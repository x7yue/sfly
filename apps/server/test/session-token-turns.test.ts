// 会话令牌：每一轮开始时签发、这一轮以任何结局结束时吊销（规格 #547「签发和吊销」「不让原值泄露」，验收标准）。
// 真实控制面 + 真实 PostgreSQL + 进程内的假助手服务（support/fake-assistant.ts）。令牌的原值只在交给助手服务的 `prompt` 命令的
// `secret_env` 里：测试从假助手服务收到的命令里取它，再用它请求控制面，看控制面认不认、认成什么。
import { createHash } from "node:crypto";
import type {
	AssistantEvent,
	PersistedSessionEvent,
	SessionDetailResponse,
	SessionView,
} from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PREDATES_LOGIN_MESSAGE } from "../src/sessions/session-service.js";
import { SESSION_TOKEN_TTL_MS } from "../src/sessions/session-tokens.js";
import { ApiClient } from "./support/api-client.js";
import { bearer, loginCookie, TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { FakeAssistant } from "./support/fake-assistant.js";
import type { ManualClock } from "./support/manual-clock.js";
import { seedSession } from "./support/sessions.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";
import { asUsers } from "./support/user-api.js";

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const WORKBENCH = "workbench-token";
const USAGE = { input: 10, output: 5, cache_read: 0, cache_write: 0 };
const TOKEN_FORMAT = /^sfly_ses_[0-9a-f]{48}$/;

const turnEnd = (turn: number, outcome: "completed" | "stopped" | "failed" | "interrupted") =>
	({
		type: "turn_end",
		turn,
		outcome,
		reason: "测试",
		steps: 1,
		model_calls: 1,
		duration_ms: 1000,
		usage: USAGE,
	}) as AssistantEvent;

interface TokenRow {
	id: string;
	kind: string;
	name: string;
	prefix: string;
	token_hash: string;
	user_id: string | null;
	project_id: string | null;
	session_id: string | null;
	scopes: string[];
	created_at: Date;
	expires_at: Date | null;
	revoked_at: Date | null;
}

async function query<T extends pg.QueryResultRow>(
	cp: TestControlPlane,
	text: string,
	params: unknown[] = [],
): Promise<T[]> {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		return (await client.query<T>(text, params)).rows;
	} finally {
		await client.end();
	}
}

describe("会话令牌：每一轮开始时签发，这一轮以任何结局结束时吊销", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let users: ReturnType<typeof asUsers>;
	let assistant: FakeAssistant;
	let workbench: FakeAgent;

	beforeAll(async () => {
		assistant = await FakeAssistant.start();
		cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
		});
		users = asUsers(cp);
		api = new ApiClient(users);
		workbench = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: cp.clock },
		);
		await assistant.connected();
	}, 60_000);

	afterAll(async () => {
		await workbench?.disconnect();
		await cp?.close();
		await assistant?.close();
	});

	beforeEach(async () => {
		await cp.current.sessionService.idle();
		await query(cp, "delete from sessions");
		assistant.prompts.length = 0;
		assistant.aborts.length = 0;
		assistant.abortRequests.length = 0;
		assistant.abortMarks.clear();
		assistant.steers.length = 0;
		assistant.endedByAbort.length = 0;
		assistant.strictTurns = true;
		assistant.stopSettleMs = 0;
		assistant.promptReply = () => undefined;
		assistant.abortReply = () => undefined;
	});

	const create = (text = "给 http_check 加一个超时参数", nickname = "alice") =>
		api.post("/projects/default/sessions", { text }, nickname);
	const created = async (text?: string, nickname?: string) =>
		json<SessionView>(await create(text, nickname));
	const say = (id: string, text = "再做一件事", nickname = "alice") =>
		api.post(`/sessions/${id}/messages`, { text }, nickname);
	const detail = async (id: string) =>
		json<SessionDetailResponse>(await api.get(`/sessions/${id}`));

	/** 交给助手服务的第 n 个 `prompt`（从 0 起）里的会话令牌原值。 */
	const issued = (index = assistant.prompts.length - 1): string => {
		const token = assistant.prompts[index]?.body.secret_env.SFLY_API_TOKEN;
		if (token === undefined) throw new Error(`第 ${index} 个 prompt 没有会话令牌`);
		return token;
	};
	/** 用这枚令牌读一个会话：令牌有效是 200，吊销、过期、不认识是 401。 */
	const readWith = async (token: string, sessionId: string): Promise<number> =>
		(await cp.fetch(`/sessions/${sessionId}`, { headers: bearer(token) })).status;
	const rows = (sessionId: string) =>
		query<TokenRow>(cp, "select * from api_tokens where session_id = $1 order by created_at, id", [
			sessionId,
		]);
	const aliceId = () => users.userId("alice");
	/** 这枚令牌（按原值的哈希找）在库里吊销了没有。 */
	const revokedOf = async (sessionId: string, token: string): Promise<boolean> => {
		const hash = createHash("sha256").update(token).digest("hex");
		const row = (await rows(sessionId)).find((r) => r.token_hash === hash);
		if (row === undefined) throw new Error("库里没有这枚令牌");
		return row.revoked_at !== null;
	};

	describe("签发", () => {
		it("建会话：这一轮的令牌只在交给助手服务的 prompt 的 secret_env 里（sfly_ses_ 加 48 位十六进制）；库里一行：哈希、前缀、名称、发起人、项目、会话、四个范围、有效期；原值不在库里任何地方", async () => {
			const view = await created("给 http_check 加一个超时参数", "alice");
			const [prompt] = assistant.prompts;
			const token = issued(0);
			expect(token).toMatch(TOKEN_FORMAT);
			// 令牌只在 secret_env 里，不在普通的环境变量里，也不在这一轮的话里。
			expect(prompt?.body.env).toEqual({ SFLY_NICKNAME: "alice", AI_AGENT: "pi" });
			expect(Object.keys(prompt?.body.secret_env ?? {})).toEqual(["SFLY_API_TOKEN"]);
			expect(prompt?.body.text).not.toContain(token);

			const [row, ...others] = await rows(view.id);
			expect(others).toEqual([]);
			expect(row).toMatchObject({
				kind: "session",
				name: `会话：${view.title}`,
				prefix: token.slice(0, 13),
				token_hash: createHash("sha256").update(token).digest("hex"),
				user_id: await aliceId(),
				project_id: "default",
				session_id: view.id,
				scopes: ["read", "run", "edit", "session_build"],
				revoked_at: null,
			});
			// 有效期：这一轮的硬上限、停止一轮最晚的时间再加余量（兜底：控制面在一轮中间崩了、没看到结局时令牌也不会一直有效）。
			const createdAt = (row as TokenRow).created_at.getTime();
			expect(row?.expires_at?.getTime()).toBe(createdAt + SESSION_TOKEN_TTL_MS);
			expect(createdAt).toBe(cp.clock.now().getTime());

			// 原值哪里都没有：会话和它的事件、令牌表的每一行（只有哈希）。
			const everywhere = JSON.stringify([
				await query(cp, "select * from api_tokens"),
				await query(cp, "select * from sessions"),
				await query(cp, "select * from session_events"),
			]);
			expect(everywhere).not.toContain(token);
			expect(everywhere).not.toContain(token.slice("sfly_ses_".length));
		});

		it("工作台上的 sfly 带着它：控制面认成这个会话的令牌（读放行；对会话说话是 403 会话令牌对会话只有读，不是 401）", async () => {
			const view = await created();
			const token = issued();
			expect(await readWith(token, view.id)).toBe(200);
			const spoken = await cp.fetch(`/sessions/${view.id}/messages`, {
				method: "POST",
				headers: { "content-type": "application/json", ...bearer(token) },
				body: JSON.stringify({ text: "替人说话" }),
			});
			expect(spoken.status).toBe(403);
			expect(await spoken.json()).toMatchObject({
				error: { message: expect.stringContaining("会话令牌对会话只有读") },
			});
		});

		it("签发的令牌就是会话令牌该有的范围：保存场景版本、触发运行放行；发布节点包、管理、建会话、说话、停止、归档、取消别人的运行都拒绝（403）", async () => {
			const view = await created();
			const token = issued();
			const scenario = await api.createOrchestration("巡检");
			const as = (method: string, path: string, body?: unknown) =>
				cp.fetch(path, {
					method,
					headers: {
						...(body === undefined ? {} : { "content-type": "application/json" }),
						...bearer(token),
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				});
			const document = {
				nodes: [{ id: "entry", kind: "entry", params: [] }],
				edges: [],
				packages: {},
			};
			const saved = await as("POST", `/orchestrations/${scenario}/versions`, {
				base_version: 0,
				document,
			});
			expect(saved.status, await saved.clone().text()).toBe(201);
			// 记着是这个会话保存的：会话里有一条平台记录。
			await eventually(async () =>
				expect(
					(await detail(view.id)).events
						.filter((e) => e.type === "platform")
						.map((e) => e.type === "platform" && e.kind),
				).toEqual(["scenario_version"]),
			);
			for (const [method, path, body] of [
				["POST", "/projects/default/tokens", { name: "x", scopes: ["read"] }],
				["POST", "/feishu-bots", { name: "x", webhook_url: "https://example.com/hook" }],
				["POST", "/projects/default/sessions", { text: "你好" }],
				["POST", `/sessions/${view.id}/messages`, { text: "你好" }],
				["POST", `/sessions/${view.id}/stop`, {}],
				["POST", `/sessions/${view.id}/end`, {}],
				["POST", `/orchestrations/${scenario}/archive`, {}],
			] as const) {
				const res = await as(method, path, body);
				expect(res.status, `${method} ${path}`).toBe(403);
			}
			// 发布节点包：范围不够（缺「发布」），不是找不到、也不是没有凭据。
			const publish = await as("POST", "/packages");
			expect(publish.status).toBe(403);
			expect(await publish.json()).toMatchObject({
				error: { message: expect.stringContaining("发布") },
			});
		});

		it("每一轮一枚：下一轮签发另一枚；上一轮的令牌立即 401，这一轮的 200", async () => {
			const view = await created();
			const first = issued(0);
			assistant.emit(view.id, 1, turnEnd(1, "completed"));
			await eventually(async () => expect(await readWith(first, view.id)).toBe(401));
			expect((await say(view.id)).status).toBe(200);
			const second = issued(1);
			expect(second).toMatch(TOKEN_FORMAT);
			expect(second).not.toBe(first);
			expect(await readWith(first, view.id)).toBe(401);
			expect(await readWith(second, view.id)).toBe(200);
			// 库里两行：上一轮的已吊销，这一轮的有效。
			expect(await revokedOf(view.id, first)).toBe(true);
			expect(await revokedOf(view.id, second)).toBe(false);
			expect(await rows(view.id)).toHaveLength(2);
		});

		it("同一个会话任何时候至多一枚有效的：新的一轮开始时同一个事务里吊销上一枚（上一轮的结局没有带回来，也只有一枚有效）", async () => {
			const view = await created();
			// 上一轮的结局还没有写下，会话库里被改回空闲（模拟结局丢了；助手服务那边的一轮不管它）：新的一轮开始时上一枚在签发的事务里被吊销。
			assistant.strictTurns = false;
			await query(cp, "update sessions set status = 'idle' where id = $1", [view.id]);
			expect((await say(view.id, "第二句")).status).toBe(200);
			const all = await rows(view.id);
			expect(all).toHaveLength(2);
			expect(all.filter((row) => row.revoked_at === null)).toHaveLength(1);
			expect(await readWith(issued(0), view.id)).toBe(401);
			expect(await readWith(issued(1), view.id)).toBe(200);
		});

		it("排队的会话轮到它时签发：排队期间没有令牌，开始时才有，交给助手服务的就是它", async () => {
			const first = await created("甲", "alice");
			const second = await created("乙", "bob");
			expect(second.status).toBe("queued");
			expect(await rows(second.id)).toEqual([]);
			assistant.emit(first.id, 1, turnEnd(1, "completed"));
			await eventually(() =>
				expect(assistant.prompts.map((p) => p.sessionId)).toEqual([first.id, second.id]),
			);
			const token = issued(1);
			const [row] = await rows(second.id);
			expect(row).toMatchObject({
				session_id: second.id,
				user_id: await users.userId("bob"),
				revoked_at: null,
			});
			expect(row?.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
			expect(await readWith(token, second.id)).toBe(200);
		});

		it("发起人是会话的发起人：别人对会话说话开始新的一轮，令牌仍是发起人的", async () => {
			const view = await created("甲", "alice");
			assistant.emit(view.id, 1, turnEnd(1, "completed"));
			await eventually(async () => expect((await detail(view.id)).status).toBe("idle"));
			expect((await say(view.id, "我是鲍勃", "bob")).status).toBe(200);
			const all = await rows(view.id);
			expect(all.map((row) => row.user_id)).toEqual([await aliceId(), await aliceId()]);
		});
	});

	describe("吊销：这一轮以任何结局结束", () => {
		for (const outcome of ["completed", "failed", "stopped", "interrupted"] as const) {
			it(`助手服务带回结局 ${outcome}：这一轮的令牌立即 401`, async () => {
				const view = await created();
				const token = issued();
				expect(await readWith(token, view.id)).toBe(200);
				assistant.emit(view.id, 1, turnEnd(1, outcome));
				await eventually(async () => expect(await readWith(token, view.id)).toBe(401));
				expect((await rows(view.id)).map((row) => row.revoked_at !== null)).toEqual([true]);
			});
		}

		it("控制面自己补的结局（停止了、助手服务没有带回结局）：令牌吊销", async () => {
			// 不带回结局的助手服务：中止收下了，这一轮的结局不发（控制面等到期限、自己补一条 stopped）。
			assistant.strictTurns = false;
			const view = await created();
			const token = issued();
			const stopped = await api.postEmpty(`/sessions/${view.id}/stop`, "alice");
			expect(stopped.status).toBe(200);
			expect((await detail(view.id)).events.at(-1)).toMatchObject({
				type: "turn_end",
				outcome: "stopped",
			});
			expect(await readWith(token, view.id)).toBe(401);
		});

		it("控制面自己补的结局（交给助手服务没接住）：这一轮的令牌吊销，没有一枚还有效的", async () => {
			const view = await created();
			assistant.emit(view.id, 1, turnEnd(1, "completed"));
			await eventually(async () => expect((await detail(view.id)).status).toBe("idle"));
			assistant.promptReply = () => ({ status: 503, code: "start_failed" });
			expect((await say(view.id)).status).toBe(503);
			const token = issued();
			expect(await readWith(token, view.id)).toBe(401);
			expect((await rows(view.id)).filter((row) => row.revoked_at === null)).toEqual([]);
		});

		it("兜底（超过 30 分钟没有动静，按中断处理）：控制面补的结局也吊销，不靠令牌自己过期", async () => {
			const view = await created();
			(cp.clock as ManualClock).advance(31 * 60_000);
			expect(await cp.current.sessionService.expireStale()).toBe(1);
			expect((await detail(view.id)).events.at(-1)).toMatchObject({
				type: "turn_end",
				outcome: "interrupted",
			});
			// 看库：这时令牌也过了有效期（25 分钟），看 `revoked_at` 才是吊销。
			expect((await rows(view.id)).map((row) => row.revoked_at !== null)).toEqual([true]);
		});

		it("迟到的、别的轮次的 turn_end 不动这一轮的令牌：上一轮的结局晚到（控制面已经开始了下一轮），下一轮的令牌仍然有效", async () => {
			const view = await created();
			assistant.emit(view.id, 1, turnEnd(1, "completed"));
			await eventually(async () => expect((await detail(view.id)).status).toBe("idle"));
			expect((await say(view.id)).status).toBe(200);
			const second = issued(1);
			// 第 1 轮的结局又来一次（重复的、晚到的）：第 2 轮在做，它的令牌不受影响。事件按到达的先后处理：后面第 2 轮的消息落库了，
			// 前面那条重复的结局一定已经处理过。
			assistant.emit(view.id, 1, turnEnd(1, "completed"));
			assistant.emit(view.id, 2, { type: "assistant_message", text: "第二轮的消息", usage: USAGE });
			await eventually(async () =>
				expect((await detail(view.id)).events.at(-1)).toMatchObject({
					type: "assistant_message",
					text: "第二轮的消息",
				}),
			);
			expect((await detail(view.id)).status).toBe("running");
			expect(await readWith(second, view.id)).toBe(200);
		});

		it("会话结束：它的令牌吊销（会话结束的事务里，不靠别的）", async () => {
			const view = await created();
			assistant.emit(view.id, 1, turnEnd(1, "completed"));
			await eventually(async () => expect((await detail(view.id)).status).toBe("idle"));
			// 结局已经吊销过这一轮的令牌：另外造一枚还有效的（模拟结局之后又签发了、没有人吊销），结束会话把它也吊销。
			const accounts = new TestAccounts(cp.database.url);
			try {
				const stray = await accounts.sessionTokenIn(view.id, await aliceId(), "default");
				expect(await readWith(stray, view.id)).toBe(200);
				expect(await revokedOf(view.id, stray)).toBe(false);
				expect((await api.post(`/sessions/${view.id}/end`, {}, "alice")).status).toBe(200);
				// 已结束的会话的令牌访问检查本来就不认（会话状态），所以看库：`revoked_at` 是结束会话的事务写的。
				expect(await revokedOf(view.id, stray)).toBe(true);
				expect(await readWith(stray, view.id)).toBe(401);
			} finally {
				await accounts.close();
			}
		});

		it("控制面重启不吊销：重启时助手服务那边的一轮可能还在跑，令牌照常有效；重连之后收到这一轮的 turn_end 才吊销", async () => {
			// 单独起一个控制面：它要重启，工作台的 Agent 也要重新连上。
			const restartCp = await startTestControlPlane({
				assistantUrl: assistant.url,
				assistantSecret: assistant.secret,
				workbenchAgent: "workbench-restart",
				assistantReconnectMs: { min: 20, max: 100 },
			});
			const agent = await FakeAgent.connect(
				restartCp.grpcUrl,
				{ name: "workbench-restart", peer: { port: 7004, publicAddress: "10.0.0.8" } },
				{ clock: restartCp.clock },
			);
			try {
				await assistant.connected(2);
				const restartApi = new ApiClient(asUsers(restartCp));
				const res = await restartApi.post(
					"/projects/default/sessions",
					{ text: "做点事" },
					"alice",
				);
				expect(res.status, await res.clone().text()).toBe(201);
				const view = await json<SessionView>(res);
				const token = issued();
				const read = async () =>
					(await restartCp.fetch(`/sessions/${view.id}`, { headers: bearer(token) })).status;
				expect(await read()).toBe(200);
				await restartCp.restart();
				await assistant.connected(2);
				// 重启：这一轮还在做（助手服务那边的），没有人吊销它。
				expect(await read()).toBe(200);
				assistant.emit(view.id, 1, turnEnd(1, "completed"));
				await eventually(async () => expect(await read()).toBe(401));
			} finally {
				await agent.disconnect();
				await restartCp.close();
			}
		});

		it("令牌自己带有效期：没有看到结局（控制面在一轮中间崩了）时，过了有效期令牌也不再有效", async () => {
			const view = await created();
			const token = issued();
			expect(await readWith(token, view.id)).toBe(200);
			(cp.clock as ManualClock).advance(SESSION_TOKEN_TTL_MS - 1_000);
			expect(await readWith(token, view.id)).toBe(200);
			(cp.clock as ManualClock).advance(2_000);
			expect(await readWith(token, view.id)).toBe(401);
		});

		it("吊销通知打开着的事件流：用这枚令牌订阅会话的事件流，这一轮结束时流被关掉", async () => {
			const view = await created();
			const token = issued();
			const sse = await SseClient.open(cp, `/sessions/${view.id}/events`, bearer(token));
			try {
				await sse.next("turn_started");
				expect(sse.ended).toBe(false);
				assistant.emit(view.id, 1, turnEnd(1, "completed"));
				await eventually(() => expect(sse.ended).toBe(true));
			} finally {
				sse.close();
			}
		});
	});

	describe("第二道打码：事件里按令牌格式认出的会话令牌，落库和推送之前换成掩码", () => {
		it("助手服务（第一道没认出来）发来的事件里有令牌：消息、工具结果、提交的差异落库的都是掩码；读出来的、事件流推送的也是", async () => {
			const view = await created();
			const real = issued();
			// 别的一轮的、别的会话的、编造的：只要是 `sfly_ses_` 加令牌字符，都不能原样落库。
			const other = `sfly_ses_${"ab12".repeat(12)}`;
			const sse = await SseClient.open(cp, `/sessions/${view.id}/events`);
			try {
				await sse.next("turn_started");
				assistant.emit(view.id, 1, { type: "assistant_delta", text: `令牌是 ${real} 对吧` });
				assistant.emit(view.id, 1, {
					type: "assistant_message",
					text: `我看到 ${real}，还有 ${other}。`,
					usage: USAGE,
				});
				assistant.emit(view.id, 1, {
					type: "tool_call",
					call_id: "c1",
					tool: "command",
					title: `echo ${real}`,
				});
				assistant.emit(view.id, 1, {
					type: "tool_result",
					call_id: "c1",
					is_error: false,
					text: `SFLY_API_TOKEN=${real}\nSFLY_NICKNAME=alice\n`,
					truncated: false,
					exit_code: 0,
					duration_ms: 3,
				});
				assistant.emit(view.id, 1, {
					type: "platform",
					kind: "commit",
					turn: 1,
					hash: "3f1c2ab9d0e4",
					files: [{ path: "a.txt", additions: 1, deletions: 0 }],
					diff: `+token=${real}\n`,
					truncated: false,
				});
				await sse.next("platform");
				const stored = await query<{ type: string; payload: unknown }>(
					cp,
					"select type, payload from session_events where session_id = $1 order by seq",
					[view.id],
				);
				const all = JSON.stringify(stored);
				expect(all).not.toContain(real);
				expect(all).not.toContain(other);
				expect(all).not.toContain("ab12ab12ab12");
				expect(all).toContain("******");
				const toolResult = stored.find((row) => row.type === "tool_result")?.payload as {
					text: string;
				};
				expect(toolResult.text).toBe("SFLY_API_TOKEN=******\nSFLY_NICKNAME=alice\n");
				const message = stored.find((row) => row.type === "assistant_message")?.payload as {
					text: string;
				};
				expect(message.text).toBe("我看到 ******，还有 ******。");
				// 事件流推送的（持久的和不持久的增量）也是掩码。
				expect(JSON.stringify(sse.received)).not.toContain(real);
				const delta = sse.received.find((e) => e.event === "assistant_delta")?.data as {
					text: string;
				};
				expect(delta.text).toBe("令牌是 ****** 对吧");
				// 页面上读出来的也是。
				expect(JSON.stringify(await detail(view.id))).not.toContain(real);
			} finally {
				sse.close();
			}
		});

		it("只看令牌的格式：文字里单独写的 `sfly_ses_` 前缀、别的前缀（个人令牌）不打码", async () => {
			const view = await created();
			assistant.emit(view.id, 1, {
				type: "assistant_message",
				text: "令牌以 sfly_ses_ 开头；个人令牌以 sfly_pat_ 开头。",
				usage: USAGE,
			});
			await eventually(async () =>
				expect((await detail(view.id)).events.at(-1)).toMatchObject({
					type: "assistant_message",
					text: "令牌以 sfly_ses_ 开头；个人令牌以 sfly_pat_ 开头。",
				}),
			);
		});
	});

	describe("建会话只认用户的凭据", () => {
		it("不带凭据：401，说明怎么登录；没有建出会话，助手服务没有收到命令", async () => {
			const before = await query<{ n: number }>(cp, "select count(*)::int as n from sessions");
			const res = await cp.fetch("/projects/default/sessions", {
				method: "POST",
				headers: { "content-type": "application/json", "x-sfly-nickname": "alice" },
				body: JSON.stringify({ text: "没有凭据" }),
			});
			expect(res.status).toBe(401);
			const body = (await res.json()) as { error: { code: string; message: string } };
			expect(body.error.code).toBe("unauthorized");
			expect(body.error.message).toContain("sfly login");
			expect(body.error.message).toContain("登录");
			expect(await query(cp, "select count(*)::int as n from sessions")).toEqual(before);
			expect(assistant.prompts).toEqual([]);
		});

		it("登录（Cookie）建的会话：201，`created_by_user_id` 是这个用户，`created_by` 是他的显示名；个人令牌也一样", async () => {
			const accounts = new TestAccounts(cp.database.url);
			try {
				const carol = await accounts.user("carol", { displayName: "卡罗", admin: true });
				const cookie = await accounts.login(carol);
				const res = await cp.fetch("/projects/default/sessions", {
					method: "POST",
					headers: { "content-type": "application/json", ...loginCookie(cookie) },
					body: JSON.stringify({ text: "用登录建" }),
				});
				expect(res.status, await res.clone().text()).toBe(201);
				const view = await json<SessionView>(res);
				const [row] = await query<{ created_by: string; created_by_user_id: string }>(
					cp,
					"select created_by, created_by_user_id from sessions where id = $1",
					[view.id],
				);
				expect(row).toEqual({ created_by: "卡罗", created_by_user_id: carol });
				// 这一轮的令牌代的就是他。
				expect((await rows(view.id))[0]?.user_id).toBe(carol);
				await cp.current.sessionService.idle();
				assistant.emit(view.id, 1, turnEnd(1, "completed"));
				await eventually(async () => expect((await detail(view.id)).status).toBe("idle"));

				const personal = await accounts.personalToken(carol);
				const res2 = await cp.fetch("/projects/default/sessions", {
					method: "POST",
					headers: { "content-type": "application/json", ...bearer(personal) },
					body: JSON.stringify({ text: "用个人令牌建" }),
				});
				expect(res2.status, await res2.clone().text()).toBe(201);
				const second = await json<SessionView>(res2);
				expect(
					(
						await query<{ created_by_user_id: string }>(
							cp,
							"select created_by_user_id from sessions where id = $1",
							[second.id],
						)
					)[0],
				).toEqual({ created_by_user_id: carol });
			} finally {
				await accounts.close();
			}
		});

		it("项目令牌、会话令牌不能建会话（403）：没有用户，会话令牌要代一个人", async () => {
			const view = await created();
			const accounts = new TestAccounts(cp.database.url);
			try {
				const projectToken = await accounts.projectToken("default");
				for (const token of [projectToken, issued()]) {
					const res = await cp.fetch("/projects/default/sessions", {
						method: "POST",
						headers: { "content-type": "application/json", ...bearer(token) },
						body: JSON.stringify({ text: "代人建" }),
					});
					expect(res.status).toBe(403);
				}
				expect(
					(await query<{ n: number }>(cp, "select count(*)::int as n from sessions"))[0]?.n,
				).toBe(1);
				expect(view.id).toBeDefined();
			} finally {
				await accounts.close();
			}
		});
	});

	describe("建于登录之前的会话（没有发起人的用户）", () => {
		const events = async (id: string): Promise<PersistedSessionEvent[]> =>
			(await detail(id)).events;

		it("开始新的一轮：409 session_predates_login，写明请新建一个会话；什么都没有写，助手服务没有收到命令", async () => {
			const id = await seedSession(cp.database.url, {
				status: "idle",
				currentTurn: 1,
				events: [
					{
						type: "user_message",
						message_id: crypto.randomUUID(),
						text: "旧会话",
						steer: false,
						author: "旧人",
						author_user_id: null,
					},
					{ type: "turn_started", turn: 1 },
					{
						type: "turn_end",
						turn: 1,
						outcome: "completed",
						reason: "完成",
						steps: 0,
						model_calls: 0,
						duration_ms: 1,
					},
				],
			});
			const before = await events(id);
			const res = await say(id);
			expect(res.status).toBe(409);
			expect(await res.json()).toEqual({
				error: { code: "session_predates_login", message: "这个会话建于登录之前，请新建一个会话" },
			});
			expect(PREDATES_LOGIN_MESSAGE).toBe("这个会话建于登录之前，请新建一个会话");
			expect(await events(id)).toEqual(before);
			expect(assistant.prompts).toEqual([]);
			expect((await detail(id)).status).toBe("idle");
		});

		it("排队中的旧会话轮到它时：这一轮以失败结束，写明原因；排在后面的照常开始", async () => {
			const running = await created("在做的", "alice");
			const old = await seedSession(cp.database.url, {
				status: "queued",
				events: [
					{
						type: "user_message",
						message_id: crypto.randomUUID(),
						text: "旧会话的话",
						steer: false,
						author: "旧人",
						author_user_id: null,
					},
				],
				createdAt: new Date(cp.clock.now().getTime() + 1_000),
			});
			(cp.clock as ManualClock).advance(5_000);
			const next = await created("后来的", "bob");
			expect(next.status).toBe("queued");
			assistant.emit(running.id, 1, turnEnd(1, "completed"));
			await eventually(async () => {
				expect((await detail(old)).events.at(-1)).toMatchObject({
					type: "turn_end",
					outcome: "failed",
					reason: PREDATES_LOGIN_MESSAGE,
				});
			});
			// 旧会话没有交给助手服务；后面排着的开始了。
			await eventually(() =>
				expect(assistant.prompts.map((p) => p.sessionId)).toEqual([running.id, next.id]),
			);
			expect((await detail(old)).status).toBe("idle");
		});
	});
});
