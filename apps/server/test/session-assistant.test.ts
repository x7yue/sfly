// 助手会话和助手服务的连接（ADR 0027，规格 #541 第二个 PR）：建会话、发话、停止把一轮交给助手服务，助手服务推回的事件落库并
// 推给浏览器，断了重连，助手没有配置、连不上、拒绝时的 503 和 409，就绪状态。真实控制面 + 真实数据库 + 进程内的假助手服务
// （support/fake-assistant.ts，说 @sfly/schema 的协议，记下收到的命令，测试往它的事件流里推事件）。
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { inspect } from "node:util";
import {
	ASSISTANT_ABORT_SETTLE_MS,
	ASSISTANT_PROCESS_KILL_GRACE_MS,
	ASSISTANT_STOP_WAIT_MS,
	type AssistantEvent,
	PersistedSessionEvent,
	type Readiness,
	type SessionDetailResponse,
	type SessionListResponse,
	SessionView,
} from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ASSISTANT_REJECTION_TEXT, AssistantClient } from "../src/sessions/assistant-client.js";
import { STOP_GRACE_MS } from "../src/sessions/session-service.js";
import { ApiClient } from "./support/api-client.js";
import { actAs } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { FAKE_SECRET, FakeAssistant } from "./support/fake-assistant.js";
import type { ManualClock } from "./support/manual-clock.js";
import { seedSession } from "./support/sessions.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";
import { asUsers, type UserFetch } from "./support/user-api.js";

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const WORKBENCH = "workbench-a";
const USAGE = { input: 10, output: 5, cache_read: 0, cache_write: 0 };
const assistantMessage = (text: string): AssistantEvent => ({
	type: "assistant_message",
	text,
	usage: USAGE,
});
const turnEnd = (
	turn: number,
	outcome: "completed" | "stopped" = "completed",
	reason = "助手已完成",
): AssistantEvent => ({
	type: "turn_end",
	turn,
	outcome,
	reason,
	steps: 1,
	model_calls: 1,
	duration_ms: 1000,
	usage: USAGE,
});

/** 控制面自己写的 turn_end（`SessionStore.append` 的事件内容）。 */
const turnEndBody = (turn: number, outcome: "completed" | "stopped") =>
	({ type: "turn_end", turn, outcome, reason: "测试", duration_ms: 1 }) as const;

/** 一个会话的当前行（直接读库）。 */
async function sessionRow(cp: TestControlPlane, id: string) {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		const { rows } = await client.query("select * from sessions where id = $1", [id]);
		return rows[0] as { status: string; title: string; created_by: string } | undefined;
	} finally {
		await client.end();
	}
}

async function sessionCount(cp: TestControlPlane): Promise<number> {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		const { rows } = await client.query("select count(*)::int as n from sessions");
		return rows[0].n as number;
	} finally {
		await client.end();
	}
}

/** 直接改库（测试里把会话改成某个状态）。 */
async function database_query(cp: TestControlPlane, text: string, params: unknown[] = []) {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		await client.query(text, params);
	} finally {
		await client.end();
	}
}

/**
 * 停止等结局的期限（`SessionService` 的 `stopGraceMs`；这个文件里的控制面默认 300 毫秒）。要在「正在停止」的窗口里做好几个请求的
 * 用例把它放长，结局什么时候到由用例自己决定：窗口的长短不靠 CI 机器的快慢。
 */
function setStopGrace(cp: TestControlPlane, ms: number): void {
	(cp.current.sessionService as unknown as { deps: { stopGraceMs?: number } }).deps.stopGraceMs =
		ms;
}

/** 一个会话的持久事件（读接口，最新的一页）。 */
async function eventsOf(api: ApiClient, id: string): Promise<PersistedSessionEvent[]> {
	return (await api.getJson<SessionDetailResponse>(`/sessions/${id}`)).events;
}

describe("助手服务接上了：建会话、发话、停止、收回事件", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let assistant: FakeAssistant;
	let workbench: FakeAgent;
	let users: UserFetch;

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
		// 工作台：一台在线的 Agent，上报了能力端口。
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
		// 每个用例从没有在做的会话、助手服务没有收到过命令开始（后台正在开始的排队中的会话先做完）。
		await cp.current.sessionService.idle();
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			await client.query("delete from sessions");
		} finally {
			await client.end();
		}
		assistant.prompts.length = 0;
		assistant.aborts.length = 0;
		assistant.abortRequests.length = 0;
		assistant.abortMarks.clear();
		assistant.abortAttempts = 0;
		assistant.steers.length = 0;
		assistant.ends.length = 0;
		assistant.endedByAbort.length = 0;
		assistant.strictTurns = true;
		assistant.stopSettleMs = 0;
		assistant.promptReply = () => undefined;
		assistant.abortReply = () => undefined;
		assistant.health = () => assistant.healthy();
	});

	const events = (id: string) => eventsOf(api, id);

	const create = (text = "给 http_check 加一个超时参数", nickname = "alice") =>
		api.post("/projects/default/sessions", { text }, nickname);

	it("建会话：201，助手服务收到这一轮（带共享密钥、工作台的地址和端口、工作区、昵称和 AI_AGENT=pi），第一句话和一轮开始落了库", async () => {
		const res = await create("  给 http_check\n加一个超时参数  ", "alice");
		expect(res.status).toBe(201);
		const view = await json<SessionView>(res);
		expect(SessionView.safeParse(view).success).toBe(true);
		expect(view).toMatchObject({
			title: "给 http_check 加一个超时参数",
			status: "running",
			created_by: "alice",
			project: "default",
			last_turn_outcome: null,
		});

		expect(assistant.prompts).toHaveLength(1);
		const [prompt] = assistant.prompts;
		expect(prompt?.sessionId).toBe(view.id);
		expect(prompt?.authorization).toBe(`Bearer ${FAKE_SECRET}`);
		expect(prompt?.body).toMatchObject({
			turn: 1,
			text: "  给 http_check\n加一个超时参数  ",
			session: { title: view.title, created_by: "alice" },
			workbench: { name: WORKBENCH, address: "10.0.0.5:7001", workdir: "/work" },
			env: { SFLY_NICKNAME: "alice", AI_AGENT: "pi" },
			secret_env: {},
		});

		const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
		expect(detail.events.map((e) => [e.seq, e.type])).toEqual([
			[1, "user_message"],
			[2, "turn_started"],
		]);
		expect(detail.events[0]).toMatchObject({
			// 这句话的 ID：和交给助手服务的是同一个。
			message_id: prompt?.body.message_id,
			text: "  给 http_check\n加一个超时参数  ",
			steer: false,
			author: "alice",
			// 建会话要带用户的凭据：说这句话的人是这个用户。
			author_user_id: await users.userId("alice"),
		});
		expect(detail.events[1]).toMatchObject({ turn: 1 });
		// 控制面自己产生的事件用控制面的时钟。
		expect(detail.events[0]?.at).toBe(cp.clock.now().toISOString());
	});

	it("助手服务推回的事件落库、经事件流推给浏览器；读到的持久事件和事件流推送的一致，时间是助手服务盖的", async () => {
		const view = await json<SessionView>(await create());
		const sse = await SseClient.open(cp, `/sessions/${view.id}/events`);
		try {
			await sse.next("turn_started");
			const at = "2026-01-01T00:00:05.000Z";
			assistant.emit(view.id, 1, { type: "thinking" }, at);
			assistant.emit(view.id, 1, { type: "assistant_delta", text: "我先" }, at);
			assistant.emit(view.id, 1, assistantMessage("我先看一下"), at);
			assistant.emit(
				view.id,
				1,
				{ type: "tool_call", call_id: "c1", tool: "command", title: "sfly package list" },
				"2026-01-01T00:00:06.000Z",
			);
			await sse.next("tool_call");
			// 不持久的没有 ID，持久的以会话内序号作 ID（接在建会话时的两条后面）。
			// 快照（#545）发在补发读完、切到实时的那一刻，不算在这条链路的事件里；位置见 session-snapshot.test.ts。
			const events = sse.received.filter((e) => e.event !== "time" && e.event !== "snapshot");
			expect(events.map((e) => [e.event, e.id])).toEqual([
				["user_message", "1"],
				["turn_started", "2"],
				["thinking", undefined],
				["assistant_delta", undefined],
				["assistant_message", "3"],
				["tool_call", "4"],
			]);
			const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
			expect(detail.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
			// 事件流推送的持久事件和读到的是同一份（内容、序号、时间）。
			const pushed = events.filter((e) => e.id !== undefined).map((e) => e.data);
			expect(pushed).toEqual(detail.events);
			for (const event of detail.events) {
				expect(PersistedSessionEvent.safeParse(event).success, event.type).toBe(true);
			}
			// 时间是助手服务盖的，不是控制面落库的时间。
			expect(detail.events[2]?.at).toBe(at);
			expect(detail.events[3]?.at).toBe("2026-01-01T00:00:06.000Z");
		} finally {
			sse.close();
		}
	});

	it("读会话（GET /sessions/:id）：读的当中这一轮结束了，响应里的状态、事件、上一轮的结局是同一个时刻的（不会是「在做」加上已经有 turn_end 的事件，页面据此停在在做，事件流又从这条之后接）", async () => {
		const view = await json<SessionView>(await create());
		const store = cp.current.sessions;
		const real = store.find.bind(store);
		const spy = vi.spyOn(store, "find");
		// 路由先查会话在不在；这一轮的 turn_end 恰好在这之后提交。
		spy.mockImplementationOnce(async (id) => {
			const found = await real(id);
			await store.append(view.id, turnEndBody(1, "completed"));
			return found;
		});
		try {
			const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
			const ended = detail.events.some((e) => e.type === "turn_end");
			// 事件里有 turn_end 就得是空闲、有上一轮的结局；没有就得是在做、没有结局。
			expect({
				status: detail.status,
				ended,
				outcome: detail.last_turn_outcome,
			}).toEqual(
				ended
					? { status: "idle", ended: true, outcome: "completed" }
					: { status: "running", ended: false, outcome: null },
			);
		} finally {
			spy.mockRestore();
		}
	});

	describe("一轮的 turn_end 比这一轮 prompt 的回应先到控制面（事件和回应走两条连接，先后没有保证）", () => {
		it("助手服务收到 prompt 之后先发这一轮的 turn_end、过一会儿才回 202：结局照常落库、会话回到空闲，回应回来之后不会把它写回在做", async () => {
			assistant.promptDelayMs = 400;
			try {
				const creating = create("很快就做完的事");
				await eventually(() => expect(assistant.prompts).toHaveLength(1));
				const prompt = assistant.prompts[0];
				assistant.emit(prompt?.sessionId as string, 1, turnEnd(1));
				// 建会话的响应还没有回来（助手服务还没回 202），结局已经落库、会话已经空闲。
				await eventually(async () =>
					expect((await sessionRow(cp, prompt?.sessionId as string))?.status).toBe("idle"),
				);
				const res = await creating;
				expect(res.status).toBe(201);
				const created = await json<SessionView>(res);
				expect(created.status).toBe("idle");
				expect(created.last_turn_outcome).toBe("completed");
				expect((await sessionRow(cp, created.id))?.status).toBe("idle");
				expect((await events(created.id)).map((e) => e.type)).toEqual([
					"user_message",
					"turn_started",
					"turn_end",
				]);
			} finally {
				assistant.promptDelayMs = 0;
			}
		});

		it("发话也一样：第 2 轮的 turn_end 先于 prompt 的回应到，会话回到空闲，响应照常返回这句话的序号", async () => {
			const first = await json<SessionView>(await create());
			assistant.emit(first.id, 1, turnEnd(1));
			await eventually(async () => expect((await sessionRow(cp, first.id))?.status).toBe("idle"));
			assistant.prompts.length = 0;
			assistant.promptDelayMs = 400;
			try {
				const saying = api.post(`/sessions/${first.id}/messages`, { text: "再做一件事" });
				await eventually(() => expect(assistant.prompts).toHaveLength(1));
				assistant.emit(first.id, 2, turnEnd(2));
				await eventually(async () => expect((await sessionRow(cp, first.id))?.status).toBe("idle"));
				const res = await saying;
				expect(res.status).toBe(200);
				expect((await sessionRow(cp, first.id))?.status).toBe("idle");
				expect(
					(await events(first.id)).filter((e) => e.type === "turn_end").map((e) => e.turn),
				).toEqual([1, 2]);
			} finally {
				assistant.promptDelayMs = 0;
			}
		});

		it("控制面发 prompt 的请求还没有发出，这一轮的 turn_end 已经到了：落库、会话回到空闲；请求之后照常发出、建会话的响应是空闲", async () => {
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const real = AssistantClient.prototype.prompt;
			const spy = vi
				.spyOn(AssistantClient.prototype, "prompt")
				.mockImplementationOnce(async function (this: AssistantClient, ...args) {
					await held;
					return real.apply(this, args);
				});
			try {
				const creating = create("还没发出去就结束了");
				// 会话已经建好（在做，第 1 轮），prompt 的请求被扣住了；这时助手服务的事件流里先来了这一轮的 turn_end。
				let sessionId = "";
				await eventually(async () => {
					const list = await json<SessionListResponse>(await api.get("/projects/default/sessions"));
					sessionId = list.sessions[0]?.id ?? "";
					expect(sessionId).not.toBe("");
				});
				expect(assistant.prompts).toHaveLength(0);
				assistant.emit(sessionId, 1, turnEnd(1));
				await eventually(async () =>
					expect((await sessionRow(cp, sessionId))?.status).toBe("idle"),
				);
				release();
				const res = await creating;
				expect(res.status).toBe(201);
				expect((await json<SessionView>(res)).status).toBe("idle");
				expect((await events(sessionId)).filter((e) => e.type === "turn_end")).toHaveLength(1);
			} finally {
				release();
				spy.mockRestore();
			}
		});
	});

	it("一轮结束（turn_end）：会话回到空闲，上一轮的结局进了列表，可以开始下一轮（第 2 轮）", async () => {
		const view = await json<SessionView>(await create());
		assistant.emit(view.id, 1, assistantMessage("好了"));
		assistant.emit(view.id, 1, turnEnd(1));
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		const list = await json<SessionListResponse>(await api.get("/projects/default/sessions"));
		expect(list.sessions).toHaveLength(1);
		expect(list.sessions[0]).toMatchObject({
			id: view.id,
			status: "idle",
			last_turn_outcome: "completed",
		});

		const said = await api.post(`/sessions/${view.id}/messages`, { text: "再加一条日志" }, "bob");
		expect(said.status).toBe(200);
		const { seq } = await json<{ seq: number }>(said);
		expect(assistant.prompts).toHaveLength(2);
		expect(assistant.prompts[1]?.body).toMatchObject({
			turn: 2,
			text: "再加一条日志",
			// 会话的发起人不变；这句话的发起人是 bob。
			session: { created_by: "alice" },
			env: { SFLY_NICKNAME: "bob", AI_AGENT: "pi" },
		});
		const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
		const spoken = detail.events.find((e) => e.seq === seq);
		expect(spoken).toMatchObject({ type: "user_message", text: "再加一条日志", author: "bob" });
		expect((await sessionRow(cp, view.id))?.status).toBe("running");
	});

	it("在做时发话是插话（不再是 409 turn_running）；同一个项目另一个会话在做时建会话排队（不再是 409 project_busy），轮到它时才交给助手服务（#544）", async () => {
		const first = await json<SessionView>(await create("第一个"));
		const steer = await api.post(`/sessions/${first.id}/messages`, { text: "再说一句" });
		expect(steer.status).toBe(200);
		expect(assistant.steers.map((s) => s.body.text)).toEqual(["再说一句"]);

		const other = await create("第二个");
		expect(other.status).toBe(201);
		const second = await json<SessionView>(other);
		expect(second).toMatchObject({
			status: "queued",
			queue_position: 1,
			waiting_for: { session_id: first.id, title: "第一个" },
		});
		// 助手服务没有收到第二个 prompt。
		expect(await sessionCount(cp)).toBe(2);
		expect(assistant.prompts).toHaveLength(1);

		assistant.emit(first.id, 1, turnEnd(1));
		await eventually(async () => expect((await sessionRow(cp, first.id))?.status).toBe("idle"));
		// 第一个结束之后，排队的第二个自动开始。
		await eventually(() =>
			expect(assistant.prompts.map((p) => p.sessionId)).toEqual([first.id, second.id]),
		);
	});

	it("并发建会话：同一个项目只有一个开始，其余排队（都是 201）", async () => {
		const results = await Promise.all([create("甲"), create("乙"), create("丙")]);
		expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
		const views = await Promise.all(results.map((r) => json<SessionView>(r)));
		expect(views.filter((v) => v.status === "running")).toHaveLength(1);
		expect(views.filter((v) => v.status === "queued")).toHaveLength(2);
		expect(await sessionCount(cp)).toBe(3);
		expect(assistant.prompts).toHaveLength(1);
	});

	it("并发对同一个会话发话：只有一个开始新的一轮，其余的是插话", async () => {
		const view = await json<SessionView>(await create());
		assistant.emit(view.id, 1, turnEnd(1));
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		assistant.prompts.length = 0;
		assistant.steers.length = 0;
		const results = await Promise.all(
			["甲", "乙", "丙"].map((text) => api.post(`/sessions/${view.id}/messages`, { text })),
		);
		expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
		expect(assistant.prompts).toHaveLength(1);
		expect(assistant.steers).toHaveLength(2);
	});

	it("并发地给同一个项目里两个空闲的会话发话：撞上「每个项目至多一个在做」的唯一索引，一个开始、另一个排队，不是 500", async () => {
		const creator = await users.userId("tester");
		const [a, b] = await Promise.all([
			seedSession(cp.database.url, { title: "甲", status: "idle", createdByUserId: creator }),
			seedSession(cp.database.url, { title: "乙", status: "idle", createdByUserId: creator }),
		]);
		const results = await Promise.all(
			[a, b].map((id) => api.post(`/sessions/${id}/messages`, { text: "开始" })),
		);
		expect(results.map((r) => r.status)).toEqual([200, 200]);
		// 助手服务只收到一个 prompt，另一个会话排队。
		expect(assistant.prompts).toHaveLength(1);
		const loser = assistant.prompts[0]?.sessionId === a ? b : a;
		expect((await sessionRow(cp, loser))?.status).toBe("queued");
	});

	it("已结束的会话发话：409 session_ended", async () => {
		const id = await seedSession(cp.database.url, { status: "ended" });
		const res = await api.post(`/sessions/${id}/messages`, { text: "还在吗" });
		expect(res.status).toBe(409);
		expect((await json<{ error: { code: string } }>(res)).error.code).toBe("session_ended");
		expect(assistant.prompts).toHaveLength(0);
	});

	it("停止：在做时助手服务收到中止，它在宽限内把这一轮的 turn_end 带回来，控制面不重复补；不在做时不改会话（空闲的会话仍补发一次中止，已结束的不发）", async () => {
		const view = await json<SessionView>(await create());
		// 助手服务收到中止后马上带回这一轮的结局（假助手服务按协议：收下中止就结束这一轮、发 `turn_end`）。
		const stopped = await api.post(`/sessions/${view.id}/stop`, {});
		expect(stopped.status).toBe(200);
		expect(assistant.aborts).toEqual([view.id]);
		// 中止带着此刻在做的那一轮的轮次。
		expect(assistant.abortRequests).toEqual([{ sessionId: view.id, turn: 1 }]);
		expect(await json<SessionView>(stopped)).toMatchObject({
			id: view.id,
			status: "idle",
			last_turn_outcome: "stopped",
		});
		// 只有一条 turn_end，是助手服务的（原因是它写的）。
		const ends = (await events(view.id)).filter((e) => e.type === "turn_end");
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ outcome: "stopped" });
		// 不是控制面补的（控制面补的那句写着「由控制面结束」）。
		expect(String((ends[0] as { reason: string }).reason)).not.toContain("由控制面结束");

		// 不在做：不改会话，返回当前状态；空闲的会话向助手服务补发一次按会话的中止（`prompt` 超时后补发的中止可能落空，
		// 这一次让用户有办法把它停下来）。
		const again = await api.post(`/sessions/${view.id}/stop`, {});
		expect(again.status).toBe(200);
		await eventually(() => expect(assistant.aborts).toEqual([view.id, view.id]));
		// 空闲时带的是最近的那一轮（第 1 轮已经结束，助手服务什么也不会做）。
		expect(assistant.abortRequests).toEqual([
			{ sessionId: view.id, turn: 1 },
			{ sessionId: view.id, turn: 1 },
		]);
		expect(await json<SessionView>(again)).toMatchObject({
			status: "idle",
			last_turn_outcome: "stopped",
		});
		expect((await events(view.id)).filter((e) => e.type === "turn_end")).toHaveLength(1);
		// 已结束的会话：助手服务那边没有这一轮要停，不发。
		await database_query(cp, "update sessions set status = 'ended' where id = $1", [view.id]);
		const ended = await api.post(`/sessions/${view.id}/stop`, {});
		expect(ended.status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(assistant.aborts).toEqual([view.id, view.id]);
	});

	it("空闲时点停止、紧接着发话：中止带着最近那一轮的轮次，新的一轮（轮次更大）不受影响，照常做", async () => {
		const view = await json<SessionView>(await create());
		assistant.emit(view.id, 1, turnEnd(1));
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		// 空闲时点停止：向助手服务发一次中止，带第 1 轮。
		expect((await api.post(`/sessions/${view.id}/stop`, {})).status).toBe(200);
		await eventually(() =>
			expect(assistant.abortRequests).toEqual([{ sessionId: view.id, turn: 1 }]),
		);
		expect(assistant.abortMarks.get(view.id)).toBe(1);
		// 紧接着说一句话：第 2 轮的 prompt 到了助手服务，它认得第 2 轮没有被中止过，照常做（不会被当成晚到的第 1 轮结束掉）。
		expect((await api.post(`/sessions/${view.id}/messages`, { text: "再来一句" })).status).toBe(
			200,
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(assistant.prompts.at(-1)?.body.turn).toBe(2);
		expect(assistant.abortMarks.get(view.id) ?? 0).toBeLessThan(2);
		expect((await sessionRow(cp, view.id))?.status).toBe("running");
		expect((await events(view.id)).filter((e) => e.type === "turn_end")).toHaveLength(1);
		// 第 2 轮在做时点停止：中止带的是第 2 轮；助手服务这边什么也不带回，宽限之后由控制面结束它。
		expect((await api.post(`/sessions/${view.id}/stop`, {})).status).toBe(200);
		expect(assistant.abortRequests.at(-1)).toEqual({ sessionId: view.id, turn: 2 });
		expect((await sessionRow(cp, view.id))?.status).toBe("idle");
	});

	it("空闲的会话点停止不等中止的回应：助手服务的中止几秒才回，响应也马上回来", async () => {
		const view = await json<SessionView>(await create());
		assistant.emit(view.id, 1, turnEnd(1));
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		assistant.abortDelayMs = 3_000;
		try {
			const started = Date.now();
			const stopped = await api.post(`/sessions/${view.id}/stop`, {});
			expect(stopped.status).toBe(200);
			expect(Date.now() - started).toBeLessThan(1_000);
			await eventually(() =>
				expect(assistant.abortRequests).toEqual([{ sessionId: view.id, turn: 1 }]),
			);
		} finally {
			assistant.abortDelayMs = 0;
		}
	});

	it("助手服务回过一次 409 之后：控制面的轮次已经加一，空闲时点停止带新轮次，助手服务把还在跑的上一轮也结束，再发话照常做", async () => {
		try {
			const view = await json<SessionView>(await create("第一句"));
			// 第 1 轮正常结束；第 2 轮：用户点停止，但助手服务拒绝了中止（那一轮其实还在跑），控制面自己结束它（stopped）。
			assistant.emit(view.id, 1, turnEnd(1));
			await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
			expect((await api.post(`/sessions/${view.id}/messages`, { text: "第二句" })).status).toBe(
				200,
			);
			assistant.abortReply = () => ({ status: 503, code: "start_failed", message: "没停住" });
			expect((await api.post(`/sessions/${view.id}/stop`, {})).status).toBe(200);
			assistant.abortReply = () => undefined;
			expect((await sessionRow(cp, view.id))?.status).toBe("idle");
			// 第 3 轮：助手服务那边第 2 轮还在跑，回 409；控制面把第 3 轮记成失败，轮次已经是 3。
			const refused = await api.post(`/sessions/${view.id}/messages`, { text: "第三句" });
			expect(refused.status).toBe(409);
			expect((await json<{ error: { code: string } }>(refused)).error.code).toBe("turn_running");
			expect((await sessionRow(cp, view.id))?.status).toBe("idle");
			// 空闲时点停止：中止带最近的那一轮（3），助手服务把还在做的、轮次不大于 3 的第 2 轮也结束。
			assistant.abortRequests.length = 0;
			expect((await api.post(`/sessions/${view.id}/stop`, {})).status).toBe(200);
			await eventually(() =>
				expect(assistant.abortRequests).toEqual([{ sessionId: view.id, turn: 3 }]),
			);
			await eventually(() =>
				expect(assistant.endedByAbort).toEqual([{ sessionId: view.id, turn: 2 }]),
			);
			// 再发话：助手服务那边已经没有在做的一轮，第 4 轮照常开始。
			expect((await api.post(`/sessions/${view.id}/messages`, { text: "第四句" })).status).toBe(
				200,
			);
			expect(assistant.prompts.at(-1)?.body.turn).toBe(4);
			expect((await sessionRow(cp, view.id))?.status).toBe("running");
		} finally {
			assistant.endedByAbort.length = 0;
		}
	});

	it("没有过任何一轮的空闲会话点停止：没有什么可结束的，不向助手服务发中止", async () => {
		const id = await seedSession(cp.database.url, { status: "idle", title: "从没做过" });
		expect((await api.post(`/sessions/${id}/stop`, {})).status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(assistant.abortAttempts).toBe(0);
		expect(assistant.abortRequests).toEqual([]);
	});

	it("停止：助手服务不回话也能停（拒绝了中止、或收到了中止但没有带回结局）：都等到同一个期限，到期控制面补一条 stopped 的 turn_end，会话回到空闲，项目可以再开始新的一轮", async () => {
		// 助手服务拒绝中止（不认识这个会话、起不来……）：不是 202，**不马上补**：助手服务那边这一轮可能还在做，等到同一个期限
		// （测试里 300 毫秒，从发出中止起算）再由控制面结束这一轮。
		const first = await json<SessionView>(await create("第一个"));
		assistant.abortReply = () => ({ status: 503, code: "start_failed", message: "不认识这一轮" });
		const refusedAt = Date.now();
		const refused = await api.post(`/sessions/${first.id}/stop`, {});
		expect(Date.now() - refusedAt).toBeGreaterThanOrEqual(250);
		expect(refused.status).toBe(200);
		expect(await json<SessionView>(refused)).toMatchObject({
			status: "idle",
			last_turn_outcome: "stopped",
		});
		const [end] = (await events(first.id)).filter((e) => e.type === "turn_end");
		expect(end).toMatchObject({ type: "turn_end", turn: 1, outcome: "stopped" });
		expect(String((end as { reason: string }).reason)).toContain("由控制面结束");
		expect(assistant.aborts).toEqual([first.id]);

		// 项目能开始新的一轮，不被这个会话卡住。
		assistant.abortReply = () => undefined;
		const second = await json<SessionView>(await create("第二个"));
		expect(second.status).toBe("running");

		// 助手服务收到了中止（202）但在期限之内没有带回结局（停得比控制面的期限 300 毫秒慢）：等过宽限之后由控制面结束。
		assistant.stopSettleMs = 1_500;
		const started = Date.now();
		const quiet = await api.post(`/sessions/${second.id}/stop`, {});
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		expect(quiet.status).toBe(200);
		expect(await json<SessionView>(quiet)).toMatchObject({ status: "idle" });
		const [quietEnd] = (await events(second.id)).filter((e) => e.type === "turn_end");
		expect(String((quietEnd as { reason: string }).reason)).toContain("由控制面结束");
		expect((await create("第三个")).status).toBe(201);
	});

	it("停止之后助手服务晚到的同一轮的结局不再记：只有控制面补的那一条，也不会把下一轮改回空闲", async () => {
		// 助手服务收下中止，停一轮要 800 毫秒（比控制面的期限 300 毫秒长）：控制面先补一条 `stopped`；这时用户又说一句，新一轮的
		// `prompt` 在助手服务那边登记着、等第 1 轮停完（协议）；第 1 轮的 `turn_end` 在 800 毫秒时才由假助手服务发出（晚到）。
		assistant.stopSettleMs = 800;
		const view = await json<SessionView>(await create());
		await api.post(`/sessions/${view.id}/stop`, {});
		// 同一个会话开始第 2 轮；这时助手服务晚到了第 1 轮的结局。
		expect((await api.post(`/sessions/${view.id}/messages`, { text: "再来" })).status).toBe(200);
		await eventually(() => expect(assistant.stoppingTurn(view.id)).toBeUndefined(), 5_000);
		await new Promise((resolve) => setTimeout(resolve, 150));
		const ends = (await events(view.id)).filter((e) => e.type === "turn_end");
		expect(ends.map((e) => (e as { turn: number }).turn)).toEqual([1]);
		expect(ends[0]).toMatchObject({ outcome: "stopped" });
		expect((await sessionRow(cp, view.id))?.status).toBe("running");
		// 第 2 轮自己的结局照常记。
		assistant.emit(view.id, 2, turnEnd(2));
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		expect(
			(await events(view.id))
				.filter((e) => e.type === "turn_end")
				.map((e) => (e as { turn: number }).turn),
		).toEqual([1, 2]);
	});

	it("停止结束的是停止开始时记下的那一轮：中止还在路上的时候这一轮已经结束、下一轮已经开始，停止不会把新的一轮结束掉", async () => {
		const view = await json<SessionView>(await create("第一句"));
		const store = cp.current.sessions;
		// 助手服务不认识这一轮（拒绝中止），而且回应很慢：控制面等它的时候，第 1 轮正常结束、第 2 轮开始。
		assistant.abortReply = () => ({ status: 503, code: "start_failed", message: "不认识这一轮" });
		assistant.abortDelayMs = 400;
		assistant.aborts.length = 0;
		let stopping: Promise<Response> | undefined;
		try {
			stopping = api.post(`/sessions/${view.id}/stop`, {});
			await eventually(() => expect(assistant.aborts).toEqual([view.id]));
			await store.append(view.id, turnEndBody(1, "completed"));
			await store.beginTurn(view.id, "default" as never, {
				type: "user_message",
				message_id: randomUUID(),
				text: "第二句",
				steer: false,
				author: "alice",
				author_user_id: null,
			});
			expect((await stopping).status).toBe(200);
		} finally {
			await stopping?.catch(() => undefined);
			assistant.abortDelayMs = 0;
			assistant.abortReply = () => undefined;
		}
		// 第 2 轮还在做，它的状态没被这次停止碰；第 1 轮只有一条结局（正常结束的那条），第 2 轮没有结局。
		expect((await sessionRow(cp, view.id))?.status).toBe("running");
		const ends = (await events(view.id)).filter((e) => e.type === "turn_end");
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ turn: 1, outcome: "completed" });
	});

	it("助手服务没接住第一轮：新建的会话删掉（不留下会话），503 assistant_unavailable 等；说明是按错误码给的固定的一句，助手服务自己写的那句话（带内部的地址和路径）不对外", async () => {
		const internal = "ENOENT /srv/assistant/sessions/x 10.9.8.7:4000";
		for (const [reply, status, code] of [
			[
				{ status: 503, code: "start_failed", message: `起不了 pi 进程：${internal}` },
				503,
				"assistant_unavailable",
			],
			[
				{ status: 503, code: "process_limit", message: `进程数到了上限：${internal}` },
				503,
				"assistant_unavailable",
			],
			[
				{ status: 503, code: "model_not_configured", message: `没有配置模型：${internal}` },
				503,
				"model_unavailable",
			],
			[
				{ status: 503, code: "model_unreachable", message: `模型连不上：${internal}` },
				503,
				"model_unavailable",
			],
			[
				{ status: 409, code: "turn_running", message: `已有一轮在做：${internal}` },
				409,
				"turn_running",
			],
		] as const) {
			assistant.promptReply = () => reply;
			const res = await create();
			expect(res.status, reply.code).toBe(status);
			const { error } = await json<{ error: { code: string; message: string } }>(res);
			expect(error.code, reply.code).toBe(code);
			expect(error.message, reply.code).toBe(ASSISTANT_REJECTION_TEXT[reply.code]);
			expect(error.message, reply.code).not.toMatch(/10\.9\.8\.7|\/srv\/assistant/);
			expect(await sessionCount(cp), reply.code).toBe(0);
		}
		// 助手服务明确拒绝（503 是登记之前就知道起不了，409 也是）：这一轮一定没有开始，不用补发中止。
		expect(assistant.abortAttempts).toBe(0);
	});

	it("共享密钥不对：助手服务拒绝（401），控制面说明是密钥不一致，不把密钥写进说明", async () => {
		const wrong = await FakeAssistant.start({ secret: "another-secret-0123456789-0123456789-xx" });
		const other = await startTestControlPlane({
			assistantUrl: wrong.url,
			// 控制面这边的密钥和助手服务那边的不一样（同样够长）。
			assistantSecret: FAKE_SECRET,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			// 事件流永远连不上（401）：不等它连上。
			waitForAssistant: false,
		});
		const agent = await FakeAgent.connect(
			other.grpcUrl,
			{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: other.clock },
		);
		try {
			const res = await new ApiClient(asUsers(other)).post("/projects/default/sessions", {
				text: "你好",
			});
			expect(res.status).toBe(503);
			const text = await res.text();
			expect(text).toContain("assistant_unavailable");
			expect(text).toContain("SFLY_ASSISTANT_SECRET");
			expect(text).not.toContain(FAKE_SECRET);
			expect(wrong.unauthorized).toBeGreaterThan(0);
			expect(wrong.prompts).toHaveLength(0);
			// 就绪状态：助手服务连不上（健康检查被拒绝）。
			const list = await json<SessionListResponse>(
				await new ApiClient(asUsers(other)).get("/projects/default/sessions"),
			);
			expect(list.readiness.problems.map((p) => p.kind)).toContain("assistant_unreachable");
			expect(JSON.stringify(list)).not.toContain(FAKE_SECRET);
		} finally {
			await agent.disconnect();
			await other.close();
			await wrong.close();
		}
	});

	it("发话失败的各种方式之后，会话要么回到空闲、要么能被停止收拾：不会停在「在做、但这一轮没有开始」，项目不会被堵死", async () => {
		const view = await json<SessionView>(await create());
		assistant.emit(view.id, 1, turnEnd(1));
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		const store = cp.current.sessions;
		const real = store.beginTurn.bind(store);
		const say = () => api.post(`/sessions/${view.id}/messages`, { text: "再说一句" });
		const status = async () => (await sessionRow(cp, view.id))?.status;
		const spy = vi.spyOn(store, "beginTurn");
		try {
			// 1. 开始一轮之前就失败（库出错）：什么都没有改。
			spy.mockRejectedValueOnce(new Error("库挂了"));
			expect((await say()).status).toBe(500);
			expect(await status()).toBe("idle");
			expect((await events(view.id)).map((e) => e.type)).toEqual([
				"user_message",
				"turn_started",
				"turn_end",
			]);
			// 2. 开始一轮已经提交，交给助手服务之前失败（进程在这里退出、网络出错……）：会话在做第 2 轮，
			// 这一轮的开头（用户的话、turn_started）一起在库里，没有结局。
			spy.mockImplementationOnce(async (...args) => {
				await real(...args);
				throw new Error("进程退出");
			});
			expect((await say()).status).toBe(500);
			expect(await status()).toBe("running");
			expect((await events(view.id)).map((e) => e.type)).toEqual([
				"user_message",
				"turn_started",
				"turn_end",
				"user_message",
				"turn_started",
			]);
			// 停止能收拾它：补第 2 轮的结局，会话回到空闲。
			const stopped = await api.post(`/sessions/${view.id}/stop`, {});
			expect(stopped.status).toBe(200);
			expect(await json<SessionView>(stopped)).toMatchObject({
				status: "idle",
				last_turn_outcome: "stopped",
			});
			expect((await events(view.id)).at(-1)).toMatchObject({
				type: "turn_end",
				turn: 2,
				outcome: "stopped",
			});
		} finally {
			spy.mockRestore();
		}
		// 项目没有被堵死：能再开始新的一轮（第 3 轮），另一个会话也能建。
		expect((await say()).status).toBe(200);
		expect((await sessionRow(cp, view.id))?.status).toBe("running");
		assistant.emit(view.id, 3, turnEnd(3));
		await eventually(async () => expect(await status()).toBe("idle"));
		expect((await create("另一个")).status).toBe(201);
	});

	it("昵称或正文里有数据库存不进去的字符（NUL、不成对的代理字符）：400，在改任何状态之前挡掉，会话不变、没有事件", async () => {
		const view = await json<SessionView>(await create());
		assistant.emit(view.id, 1, turnEnd(1));
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		const before = (await events(view.id)).length;
		const nul = "\u0000x";
		// 昵称：不带凭据的请求（#494 之前会话的别的写接口照旧）。带了凭据的请求，身份是凭据的用户，昵称请求头不看；
		// 建会话只认用户的凭据，没有凭据是 401，到不了昵称这一步。
		for (const [path, body] of [
			[`/sessions/${view.id}/messages`, { text: "你好" }],
			[`/sessions/${view.id}/stop`, {}],
		] as const) {
			const res = await cp.fetch(path, {
				method: "POST",
				credentials: "omit",
				headers: { "content-type": "application/json", ...actAs(nul) },
				body: JSON.stringify(body),
			});
			expect(res.status, `昵称 ${path}`).toBe(400);
			expect((await json<{ error: { code: string } }>(res)).error.code).toBe("invalid_request");
		}
		const credential = { authorization: `Bearer ${await users.token("alice")}` };
		for (const path of [`/sessions/${view.id}/messages`, "/projects/default/sessions"]) {
			const res = await cp.fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json", ...credential },
				// JSON 里写 \ud800：解析出来是一个不成对的代理字符，数据库的 jsonb 拒收。
				body: '{"text":"坏\\ud800字"}',
			});
			expect(res.status, `正文 ${path}`).toBe(400);
		}
		expect(await sessionRow(cp, view.id)).toMatchObject({ status: "idle" });
		expect((await events(view.id)).length).toBe(before);
		expect(await sessionCount(cp)).toBe(1);
		expect(assistant.prompts).toHaveLength(1);
		// 对照：正常的昵称和正文照常。
		expect((await api.post(`/sessions/${view.id}/messages`, { text: "你好" })).status).toBe(200);
	});

	describe("助手服务没接住后面的一轮：用户的话还在历史里，补一条失败的结局，会话回到空闲", () => {
		it("连不上助手服务：事件流也断了，这时不开始新的一轮（#545）：503，用户的话不写进历史，会话仍是空闲；开始之后才发现 `prompt` 没接住的情形见下面各例（`promptReply`）", async () => {
			const view = await json<SessionView>(await create());
			assistant.emit(view.id, 1, turnEnd(1));
			await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
			const before = (await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`)))
				.events.length;
			await assistant.stop();
			await eventually(() => expect(cp.current.assistantConnected()).toBe(false));
			try {
				const res = await api.post(`/sessions/${view.id}/messages`, { text: "再来一次" });
				expect(res.status).toBe(503);
				expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
					"assistant_unavailable",
				);
			} finally {
				await assistant.resume();
				await assistant.connected();
				await eventually(() => expect(cp.current.assistantConnected()).toBe(true));
			}
			const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
			expect(detail.status).toBe("idle");
			// 什么也没写：没有这句话、没有新的一轮。
			expect(detail.events).toHaveLength(before);
			expect(detail.events.at(-1)).toMatchObject({
				type: "turn_end",
				turn: 1,
				outcome: "completed",
			});
		});

		it("模型不可用", async () => {
			const view = await json<SessionView>(await create());
			assistant.emit(view.id, 1, turnEnd(1));
			await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
			assistant.promptReply = () => ({
				status: 503,
				code: "model_unreachable",
				message: "模型连不上：10.9.8.7:4000 /srv/assistant/x",
			});
			const res = await api.post(`/sessions/${view.id}/messages`, { text: "再来一次" });
			expect(res.status).toBe(503);
			expect((await json<{ error: { code: string } }>(res)).error.code).toBe("model_unavailable");
			const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
			expect(detail.events.at(-1)).toMatchObject({
				type: "turn_end",
				outcome: "model_unavailable",
				error_class: "other",
				// 历史里的原因所有能读这个会话的人都看得到：固定的一句，不带助手服务写的原文。
				reason: ASSISTANT_REJECTION_TEXT.model_unreachable,
			});
			expect(JSON.stringify(detail.events.at(-1))).not.toMatch(/10\.9\.8\.7|\/srv\/assistant/);
			expect(detail.status).toBe("idle");
		});

		it("助手服务的进程数到了上限、都在做（503 process_limit，#545）：这一轮以 failed 结束，原因是固定的一句「助手服务同时在做的会话太多」，用户的话还在历史里，会话回到空闲；助手服务写的那句话（带内部地址）不对外", async () => {
			const view = await json<SessionView>(await create());
			assistant.emit(view.id, 1, turnEnd(1));
			await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
			assistant.promptReply = () => ({
				status: 503,
				code: "process_limit",
				message: "同时活着的 pi 进程已经有 8 个，都在做：10.9.8.7:4000 /srv/assistant/x",
			});
			const res = await api.post(`/sessions/${view.id}/messages`, { text: "再来一次" });
			expect(res.status).toBe(503);
			expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
				"assistant_unavailable",
			);
			const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
			expect(detail.events.at(-1)).toMatchObject({
				type: "turn_end",
				turn: 2,
				outcome: "failed",
				reason: "助手服务同时在做的会话太多：等别的会话停下来再试",
			});
			expect(JSON.stringify(detail.events.at(-1))).not.toMatch(/10\.9\.8\.7|\/srv\/assistant/);
			expect(detail.events.filter((e) => e.type === "user_message").at(-1)).toMatchObject({
				text: "再来一次",
			});
			expect(detail.status).toBe("idle");
		});
	});

	it("助手服务连不上时建会话：503 assistant_unavailable，库里没有这个会话", async () => {
		await assistant.stop();
		await eventually(() => expect(cp.current.assistantConnected()).toBe(false));
		// `/health` 的缓存（5 秒）过期之后问到的是连不上的原因；缓存里还是「通」时说明写事件流没连上（见 session-reconnect.test.ts）。
		(cp.clock as ManualClock).advance(6_000);
		try {
			const res = await create();
			expect(res.status).toBe(503);
			const { error } = await json<{ error: { code: string; message: string } }>(res);
			expect(error.code).toBe("assistant_unavailable");
			// 说明只有原因的种类：不带助手服务的地址和端口（原文进日志）。
			expect(error.message).toBe("连不上助手服务：连接被拒绝");
			expect(error.message).not.toContain(new URL(assistant.url).port);
			expect(await sessionCount(cp)).toBe(0);
		} finally {
			await assistant.resume();
			await assistant.connected();
			await eventually(() => expect(cp.current.assistantConnected()).toBe(true));
			(cp.clock as ManualClock).advance(6_000);
		}
		// 恢复之后同一个项目照常能建（之前失败的那次没有占着「在做」）。
		expect((await create()).status).toBe(201);
	});

	describe("事件连接", () => {
		it("不认识的会话、不是约定形状的行：丢掉，连接继续", async () => {
			const view = await json<SessionView>(await create());
			assistant.emit(randomUUID(), 1, assistantMessage("没人要的"));
			assistant.emitRaw("这不是 JSON");
			assistant.emitRaw(JSON.stringify({ epoch: "x", session_id: view.id }));
			assistant.emit(view.id, 1, assistantMessage("这条要落库"));
			await eventually(async () => {
				const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
				expect(detail.events.map((e) => e.type)).toContain("assistant_message");
			});
			expect(assistant.streams).toBe(1);
		});

		it("断了按退避重连：重连之后的事件照常落库，断线期间的持久事件由助手服务补发（#545，细节见 session-reconnect.test.ts）", async () => {
			const view = await json<SessionView>(await create());
			assistant.dropStreams();
			assistant.emit(view.id, 1, assistantMessage("断线期间的"));
			await assistant.connected();
			assistant.emit(view.id, 1, assistantMessage("重连之后的"));
			await eventually(async () => {
				const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
				const texts = detail.events.flatMap((e) =>
					e.type === "assistant_message" ? [e.text] : [],
				);
				expect(texts).toEqual(["断线期间的", "重连之后的"]);
			});
		});

		it("助手服务连不上又好了：连接自己恢复", async () => {
			const view = await json<SessionView>(await create());
			await assistant.stop();
			await new Promise((r) => setTimeout(r, 150));
			await assistant.resume();
			await assistant.connected();
			assistant.emit(view.id, 1, assistantMessage("恢复了"));
			await eventually(async () => {
				const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
				expect(detail.events.map((e) => e.type)).toContain("assistant_message");
			});
		});

		it("助手服务产生的事件时间原样存；同一个会话的事件按到达的先后依次落库，序号连续", async () => {
			const view = await json<SessionView>(await create());
			for (let n = 1; n <= 30; n++) {
				assistant.emit(view.id, 1, assistantMessage(`第 ${n} 条`), "2026-02-01T00:00:00.000Z");
			}
			await eventually(async () => {
				const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
				expect(detail.events).toHaveLength(32);
			});
			const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
			expect(detail.events.map((e) => e.seq)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
			const texts = detail.events.flatMap((e) => (e.type === "assistant_message" ? [e.text] : []));
			expect(texts).toEqual(Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 条`));
			expect(detail.events.at(-1)?.at).toBe("2026-02-01T00:00:00.000Z");
		}, 20_000);
	});

	describe("就绪状态", () => {
		const readiness = async (): Promise<Readiness> =>
			(await json<SessionListResponse>(await api.get("/projects/default/sessions"))).readiness;

		it("都好：可用，带工作台的名字；助手服务的 /health 缓存 5 秒", async () => {
			expect(await readiness()).toEqual({ ready: true, problems: [], workbench: WORKBENCH });
			// 5 秒内助手服务连不上也不重新问（读缓存）；之后问一遍，写明原因。
			await assistant.stop();
			await eventually(() => expect(cp.current.assistantConnected()).toBe(false));
			try {
				// 5 秒内不重新问 `/health`（缓存里是「通」），但事件流断了：就绪状态写事件流没连上（#545）。
				const cached = await readiness();
				expect(cached.ready).toBe(false);
				expect(cached.problems).toEqual([
					expect.objectContaining({
						kind: "assistant_unreachable",
						message: expect.stringContaining("事件流还没有连上"),
					}),
				]);
				(cp.clock as ManualClock).advance(6_000);
				const now = await readiness();
				expect(now.ready).toBe(false);
				expect(now.problems).toEqual([expect.objectContaining({ kind: "assistant_unreachable" })]);
				expect(now.problems[0]?.message).toBe("连不上助手服务：连接被拒绝");
				expect(JSON.stringify(now)).not.toContain(new URL(assistant.url).port);
				expect(now.workbench).toBe(WORKBENCH);
			} finally {
				await assistant.resume();
				await assistant.connected();
				await eventually(() => expect(cp.current.assistantConnected()).toBe(true));
				(cp.clock as ManualClock).advance(6_000);
			}
			expect((await readiness()).ready).toBe(true);
		});

		it("助手服务接了连接却不回话：/health 最多等 2 秒，列出会话不会跟着卡 10 秒；同时来的请求共用一次 /health", async () => {
			const advance = (ms: number) => (cp.clock as ManualClock).advance(ms);
			// 先过了缓存，再让助手服务慢：几个同时的请求只问一次。
			advance(6_000);
			assistant.healthDelayMs = 400;
			const asked = assistant.healthRequests;
			try {
				const results = await Promise.all(Array.from({ length: 5 }, () => readiness()));
				expect(results.every((r) => r.ready)).toBe(true);
				expect(assistant.healthRequests - asked).toBe(1);
				// 助手服务一直不回话：最多等 2 秒，写明连不上。
				advance(6_000);
				assistant.healthDelayMs = 8_000;
				const started = Date.now();
				const slow = await readiness();
				expect(Date.now() - started).toBeLessThan(4_000);
				expect(slow.ready).toBe(false);
				expect(slow.problems).toEqual([expect.objectContaining({ kind: "assistant_unreachable" })]);
			} finally {
				assistant.healthDelayMs = 0;
				advance(6_000);
			}
			expect((await readiness()).ready).toBe(true);
		}, 20_000);

		it("助手服务的 /health 回了拒绝（带内部地址和路径的说明）：就绪状态里是按错误码给的固定的一句，不带原文", async () => {
			const advance = (ms: number) => (cp.clock as ManualClock).advance(ms);
			advance(6_000);
			assistant.health = () => ({
				status: 503,
				code: "start_failed",
				message: "ENOENT /srv/assistant/x 10.9.8.7:4000",
			});
			try {
				const now = await readiness();
				expect(now.problems).toEqual([
					{ kind: "assistant_unreachable", message: ASSISTANT_REJECTION_TEXT.start_failed },
				]);
				expect(JSON.stringify(now)).not.toMatch(/10\.9\.8\.7|\/srv\/assistant/);
			} finally {
				assistant.health = () => assistant.healthy();
				advance(6_000);
			}
			expect((await readiness()).ready).toBe(true);
		});

		it("工作台不在线：workbench_offline，写明是哪一台；上线之后又好了", async () => {
			await workbench.disconnect();
			try {
				await eventually(async () => {
					const now = await readiness();
					expect(now.problems).toEqual([expect.objectContaining({ kind: "workbench_offline" })]);
					expect(now.problems[0]?.message).toContain(WORKBENCH);
					expect(now.workbench).toBe(WORKBENCH);
				});
				// 写接口：503 assistant_unavailable，说明是工作台不在线，没有新建会话。
				const res = await create();
				expect(res.status).toBe(503);
				const { error } = await json<{ error: { code: string; message: string } }>(res);
				expect(error.code).toBe("assistant_unavailable");
				expect(error.message).toContain(WORKBENCH);
				expect(await sessionCount(cp)).toBe(0);
			} finally {
				workbench = await FakeAgent.connect(
					cp.grpcUrl,
					{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
					{ clock: cp.clock },
				);
			}
			await eventually(async () => expect((await readiness()).ready).toBe(true));
		});
	});
});

describe("工作台的各种不能用", () => {
	let assistant: FakeAssistant;
	beforeAll(async () => {
		assistant = await FakeAssistant.start();
	});
	afterAll(async () => {
		await assistant?.close();
	});

	const withControlPlane = async (
		options: { workbenchAgent?: string },
		run: (cp: TestControlPlane, api: ApiClient) => Promise<void>,
	) => {
		const cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			assistantReconnectMs: { min: 20, max: 100 },
			...options,
		});
		try {
			await run(cp, new ApiClient(asUsers(cp)));
		} finally {
			await cp.close();
		}
	};

	it("没有登记工作台：workbench_not_set、写「没有登记工作台」（不提环境变量），写接口 503 assistant_unavailable，助手服务没有收到命令", async () => {
		await withControlPlane({}, async (cp, api) => {
			const list = await json<SessionListResponse>(await api.get("/projects/default/sessions"));
			expect(list.readiness).toMatchObject({ ready: false, workbench: null });
			expect(list.readiness.problems.map((p) => p.kind)).toEqual(["workbench_not_set"]);
			expect(list.readiness.problems[0]?.message).toContain("没有登记工作台");
			expect(list.readiness.problems[0]?.message).not.toContain("SFLY_WORKBENCH_AGENT");
			const res = await api.post("/projects/default/sessions", { text: "你好" });
			expect(res.status).toBe(503);
			expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
				"assistant_unavailable",
			);
			expect(assistant.prompts).toHaveLength(0);
			expect(await sessionCount(cp)).toBe(0);
		});
	});

	it("工作台没有上报能力端口：workbench_offline，写明原因", async () => {
		await withControlPlane({ workbenchAgent: "no-port" }, async (cp, api) => {
			const agent = await FakeAgent.connect(cp.grpcUrl, { name: "no-port" }, { clock: cp.clock });
			try {
				const list = await json<SessionListResponse>(await api.get("/projects/default/sessions"));
				expect(list.readiness.problems).toEqual([
					expect.objectContaining({ kind: "workbench_offline" }),
				]);
				expect(list.readiness.problems[0]?.message).toContain("能力端口");
			} finally {
				await agent.disconnect();
			}
		});
	});

	it("工作台是别的项目里的 Agent：workbench_not_set", async () => {
		await withControlPlane({ workbenchAgent: "elsewhere" }, async (cp, api) => {
			const agent = await FakeAgent.connect(
				cp.grpcUrl,
				{ name: "elsewhere", peer: { port: 7002 } },
				{ clock: cp.clock },
			);
			const client = new pg.Client({ connectionString: cp.database.url });
			await client.connect();
			try {
				await client.query(
					"insert into projects (id, display_name, created_at) values ('other', 'other', now())",
				);
				await client.query("update agents set project_id = 'other' where name = 'elsewhere'");
				const list = await json<SessionListResponse>(await api.get("/projects/default/sessions"));
				expect(list.readiness.problems).toEqual([
					expect.objectContaining({ kind: "workbench_not_set" }),
				]);
				expect(list.readiness.problems[0]?.message).toContain("不属于这个项目");
			} finally {
				await client.end();
				await agent.disconnect();
			}
		});
	});

	it("共享密钥太短：当作没有配置，原因写明（写接口 503 assistant_not_configured），助手服务不会被连", async () => {
		const cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: "too-short",
			workbenchAgent: "w",
		});
		try {
			const api = new ApiClient(asUsers(cp));
			const list = await json<SessionListResponse>(await api.get("/projects/default/sessions"));
			expect(list.readiness.problems[0]).toMatchObject({ kind: "assistant_not_configured" });
			expect(list.readiness.problems[0]?.message).toContain("32");
			expect(list.readiness.problems[0]?.message).not.toContain("too-short");
			const res = await api.post("/projects/default/sessions", { text: "你好" });
			expect(res.status).toBe(503);
			expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
				"assistant_not_configured",
			);
		} finally {
			await cp.close();
		}
	});
});

describe("兜底：一直在做的会话不会让项目永远开不了新的一轮", () => {
	let assistant: FakeAssistant;
	let cp: TestControlPlane;
	let workbench: FakeAgent;
	let api: ApiClient;

	beforeAll(async () => {
		assistant = await FakeAssistant.start();
		cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			sessionSweepIntervalMs: 20,
		});
		api = new ApiClient(asUsers(cp));
		workbench = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: cp.clock },
		);
	}, 60_000);
	afterAll(async () => {
		await workbench?.disconnect();
		await cp?.close();
		await assistant?.close();
	});

	const advance = (ms: number) => (cp.clock as ManualClock).advance(ms);

	it("超过 30 分钟没有持久事件的在做的会话：补一条结局为 interrupted 的 turn_end，会话回到空闲，项目可以再开始新的一轮；刚有过事件的不动", async () => {
		const view = await json<SessionView>(
			await api.post("/projects/default/sessions", { text: "第一个" }),
		);
		expect(view.status).toBe("running");
		// 29 分钟：还不算。
		advance(29 * 60_000);
		await new Promise((r) => setTimeout(r, 120));
		expect((await sessionRow(cp, view.id))?.status).toBe("running");
		// 项目里有会话在做：第二个会话排队，不开始。
		const second = await json<SessionView>(
			await api.post("/projects/default/sessions", { text: "第二个" }),
		);
		expect(second.status).toBe("queued");
		// 持久的事件算活动：时间重新从这条算起。
		assistant.emit(view.id, 1, assistantMessage("还在做"), cp.clock.now());
		await eventually(async () => {
			const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
			expect(detail.events.map((e) => e.type)).toContain("assistant_message");
		});
		advance(29 * 60_000);
		await new Promise((r) => setTimeout(r, 120));
		expect((await sessionRow(cp, view.id))?.status).toBe("running");
		// 再过两分钟，超过 30 分钟了。
		advance(2 * 60_000);
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
		expect(detail.events.at(-1)).toMatchObject({
			type: "turn_end",
			turn: 1,
			outcome: "interrupted",
		});
		expect(detail.last_turn_outcome).toBe("interrupted");
		// 这个项目又能开始新的一轮了：排队的第二个会话开始。
		await eventually(async () => expect((await sessionRow(cp, second.id))?.status).toBe("running"));
	});

	it("控制面重启：重启之前一直在做的会话，事件连接连上之后的第一次兜底回到空闲，没过期的不动（连不上助手服务时兜底不动，#545）", async () => {
		// 单独起一个控制面：兜底的扫描调快；启动时那一遍在连接连上之前，不判（连不上不等于这一轮没在做）。
		const other = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			sessionSweepIntervalMs: 50,
		});
		try {
			const stale = await seedSession(other.database.url, {
				status: "running",
				title: "重启前的",
				lastActivityAt: new Date(other.clock.now().getTime() - 40 * 60_000),
			});
			await other.restart();
			// 30 分钟从连上的时刻算起：连上之后没过 30 分钟不扫（见 session-reconnect.test.ts），过了才补。
			await eventually(() => expect(other.current.assistantConnected()).toBe(true), 10_000);
			(other.clock as ManualClock).advance(31 * 60_000);
			await eventually(async () => {
				const list = await json<SessionListResponse>(
					await new ApiClient(asUsers(other)).get("/projects/default/sessions"),
				);
				expect(list.sessions).toEqual([
					expect.objectContaining({ id: stale, status: "idle", last_turn_outcome: "interrupted" }),
				]);
			}, 10_000);
			// 新的在做的会话（刚有活动）重启之后不动。
			const fresh = await seedSession(other.database.url, {
				status: "running",
				title: "刚做的",
				lastActivityAt: other.clock.now(),
			});
			await other.restart();
			await eventually(() => expect(other.current.assistantConnected()).toBe(true), 10_000);
			// 连上之后至少扫过一遍，没过期的不动。
			await new Promise((resolve) => setTimeout(resolve, 200));
			const after = await json<SessionListResponse>(
				await new ApiClient(asUsers(other)).get("/projects/default/sessions"),
			);
			expect(after.sessions.find((x) => x.id === fresh)?.status).toBe("running");
		} finally {
			await other.close();
		}
	});

	it("兜底结束的是此刻在做的那一轮：第 2 轮在做（第 1 轮早就有结局）时补的是第 2 轮的 interrupted，不会被「这一轮数已经有 turn_end」吞掉", async () => {
		const other = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			sessionSweepIntervalMs: 50,
		});
		try {
			const user = (n: number) =>
				({
					type: "user_message",
					message_id: `00000000-0000-4000-8000-00000000000${n}`,
					text: `第 ${n} 句`,
					steer: false,
					author: "alice",
					author_user_id: null,
				}) as const;
			const id = await seedSession(other.database.url, {
				status: "running",
				title: "第二轮在做",
				lastActivityAt: new Date(other.clock.now().getTime() - 40 * 60_000),
				events: [
					user(1),
					{ type: "turn_started", turn: 1 },
					{ type: "turn_end", turn: 1, outcome: "completed", reason: "x", duration_ms: 1 },
					user(2),
					{ type: "turn_started", turn: 2 },
				],
			});
			await other.restart();
			await eventually(() => expect(other.current.assistantConnected()).toBe(true), 10_000);
			(other.clock as ManualClock).advance(31 * 60_000);
			await eventually(async () => {
				const view = await json<SessionDetailResponse>(
					await new ApiClient(asUsers(other)).get(`/sessions/${id}`),
				);
				expect(view.status).toBe("idle");
			}, 10_000);
			const detail = await json<SessionDetailResponse>(
				await new ApiClient(asUsers(other)).get(`/sessions/${id}`),
			);
			expect(detail.events.filter((e) => e.type === "turn_end")).toHaveLength(2);
			expect(detail.events.at(-1)).toMatchObject({
				type: "turn_end",
				turn: 2,
				outcome: "interrupted",
			});
		} finally {
			await other.close();
		}
	});

	it("这一轮已经有 turn_end、会话却还在做（旧版本留下的不一致）：兜底只把会话改回空闲，不再多记一条 turn_end", async () => {
		const other = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			sessionSweepIntervalMs: 50,
		});
		let agent: FakeAgent | undefined;
		try {
			const id = await seedSession(other.database.url, {
				status: "running",
				title: "不一致",
				lastActivityAt: new Date(other.clock.now().getTime() - 40 * 60_000),
				events: [
					{
						type: "user_message",
						message_id: "00000000-0000-4000-8000-000000000001",
						text: "第 1 句",
						steer: false,
						author: "alice",
						author_user_id: null,
					},
					{ type: "turn_started", turn: 1 },
					{
						type: "turn_end",
						turn: 1,
						outcome: "failed",
						reason: "助手服务没接住",
						duration_ms: 1,
					},
				],
			});
			await other.restart();
			const api = new ApiClient(asUsers(other));
			await eventually(() => expect(other.current.assistantConnected()).toBe(true), 10_000);
			(other.clock as ManualClock).advance(31 * 60_000);
			await eventually(async () => {
				const view = await json<SessionDetailResponse>(await api.get(`/sessions/${id}`));
				expect(view.status).toBe("idle");
			}, 10_000);
			const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${id}`));
			expect(detail.events.map((e) => e.type)).toEqual([
				"user_message",
				"turn_started",
				"turn_end",
			]);
			expect(detail.last_turn_outcome).toBe("failed");
			// 项目没有被它占着：能开始新的一轮（要有在线的工作台）。
			agent = await FakeAgent.connect(
				other.grpcUrl,
				{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
				{ clock: other.clock },
			);
			expect((await api.post("/projects/default/sessions", { text: "新的" })).status).toBe(201);
		} finally {
			await agent?.disconnect();
			await other.close();
		}
	});
});

describe("助手服务接了请求却不回话：prompt 超时的结果是未知的", () => {
	let assistant: FakeAssistant;
	let cp: TestControlPlane;
	let workbench: FakeAgent;
	let api: ApiClient;

	beforeAll(async () => {
		assistant = await FakeAssistant.start();
		cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			// 命令最多等 150 毫秒（默认 10 秒）：冷启动慢的助手服务会这样。
			assistantCommandTimeoutMs: 150,
		});
		api = new ApiClient(asUsers(cp));
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

	/** 等后台在做的事做完（`prompt` 结果未知时，补发中止、等到结局或到期再补结局都在后台）。 */
	const settled = () => cp.current.sessionService.idle();

	beforeEach(async () => {
		// 这个 describe 里的用例共用一个库、一个项目和一个助手服务：每个用例从没有会话、助手服务没有收到过命令开始，
		// 前一条留下的在做的会话不会让后一条排队。
		await settled();
		await database_query(cp, "delete from sessions");
		assistant.prompts.length = 0;
		assistant.aborts.length = 0;
		assistant.abortRequests.length = 0;
		assistant.abortMarks.clear();
		assistant.abortAttempts = 0;
		assistant.steers.length = 0;
		assistant.ends.length = 0;
		assistant.endedByAbort.length = 0;
		assistant.strictTurns = true;
		assistant.stopSettleMs = 0;
		assistant.promptDelayMs = 0;
		setStopGrace(cp, 300);
		assistant.promptReply = () => undefined;
		assistant.promptAcceptedThenReply = () => undefined;
		assistant.abortReply = () => undefined;
	});

	it("新建会话时 prompt 超时（结果未知）：503 assistant_unavailable；会话先留着（项目的位置不空出来），补发一次中止、等到期由控制面补结局，之后才删掉", async () => {
		// 助手服务收下中止之后停得比控制面的期限（300 毫秒）慢：控制面要等到期自己补结局。
		assistant.stopSettleMs = 1_500;
		assistant.promptDelayMs = 600;
		try {
			const res = await api.post("/projects/default/sessions", { text: "冷启动很慢" });
			expect(res.status).toBe(503);
			expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
				"assistant_unavailable",
			);
			// 响应不等：这一轮可能已经开始，会话还在做（正在停止），位置没有空出来。
			expect(await sessionCount(cp)).toBe(1);
			const sent = assistant.prompts.at(-1)?.sessionId as string;
			expect((await sessionRow(cp, sent))?.status).toBe("running");
			await eventually(() => expect(assistant.aborts).toContain(sent));
			expect(assistant.abortRequests.at(-1)).toEqual({ sessionId: sent, turn: 1 });
			// 到期（测试里 300 毫秒）助手服务没有带回结局：控制面补结局，会话（没有被碰过：只有最初的一句话和控制面写的事件）删掉。
			// 这个窗口里助手服务发来了事件的会话不删，见下面「做了事但没有带回结局」那条。
			await settled();
			expect(await sessionCount(cp)).toBe(0);
			// 之后助手服务发来的事件：会话已经不存在，丢掉，连接不断。
			assistant.emit(sent, 1, assistantMessage("更迟来的"));
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(assistant.streams).toBe(1);
		} finally {
			assistant.promptDelayMs = 0;
			await settled();
		}
	});

	it("已有的会话发话时 prompt 超时（结果未知）：响应 503，不马上补结局；补发带这一轮轮次的中止，等到结局或到期再补失败的结局、回到空闲；这一轮之后迟到的事件不落库", async () => {
		// 同上：助手服务停得比期限慢，到期由控制面补。
		assistant.stopSettleMs = 1_500;
		const view = await json<SessionView>(
			await api.post("/projects/default/sessions", { text: "第一句" }).then((r) => r),
		);
		assistant.emit(view.id, 1, turnEnd(1));
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		assistant.aborts.length = 0;
		assistant.abortRequests.length = 0;
		assistant.abortMarks.clear();
		assistant.promptDelayMs = 600;
		try {
			const res = await api.post(`/sessions/${view.id}/messages`, { text: "第二句" });
			expect(res.status).toBe(503);
			// 这一轮可能已经开始：会话还在做（正在停止），位置没有空出来。
			expect((await sessionRow(cp, view.id))?.status).toBe("running");
			await eventually(() => expect(assistant.aborts).toEqual([view.id]));
			// 补发的中止带着这一轮（第 2 轮）的轮次。
			expect(assistant.abortRequests).toEqual([{ sessionId: view.id, turn: 2 }]);
			await settled();
			expect((await sessionRow(cp, view.id))?.status).toBe("idle");
			const detail = await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`));
			expect(detail.events.at(-1)).toMatchObject({ type: "turn_end", turn: 2, outcome: "failed" });
			// 助手服务其实收下了第 2 轮，它的事件（轮次 2）在会话已经不在做之后到：丢掉。
			const before = detail.events.length;
			assistant.emit(view.id, 2, assistantMessage("第 2 轮其实在做"));
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(
				(await api.getJson<SessionDetailResponse>(`/sessions/${view.id}`)).events,
			).toHaveLength(before);
		} finally {
			assistant.promptDelayMs = 0;
			await settled();
		}
	});

	it("prompt 超时之后、等结局期间：助手服务带回了这一轮的结局就用它，不补；这期间用户又说的话是新的一轮的开头，排在这一轮后面，不是插话", async () => {
		// 非严格：这条要在「正在停止」的窗口里说完话、再由测试自己 `emit` 助手服务带回的结局（原因是「助手服务停下来了」，要断言它被用上、
		// 不是控制面补的）；严格的假助手服务的结局由它自己决定什么时候发。期限也放长（默认 300 毫秒），窗口里的几个请求不靠机器的快慢。
		assistant.strictTurns = false;
		setStopGrace(cp, 5_000);
		const view = await json<SessionView>(
			await api.post("/projects/default/sessions", { text: "第一句" }),
		);
		assistant.emit(view.id, 1, turnEnd(1));
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		assistant.steers.length = 0;
		assistant.prompts.length = 0;
		assistant.promptDelayMs = 400;
		try {
			expect((await api.post(`/sessions/${view.id}/messages`, { text: "第二句" })).status).toBe(
				503,
			);
			assistant.promptDelayMs = 0;
			// 正在停止：这句话是新的一轮的开头（排队，写 user_message，steer 为 false），不转发给助手服务。
			const said = await api.post(`/sessions/${view.id}/messages`, { text: "停止期间说的话" });
			expect(said.status).toBe(200);
			expect(assistant.steers).toHaveLength(0);
			const spoken = (await eventsOf(api, view.id)).filter((e) => e.type === "user_message").at(-1);
			expect(spoken).toMatchObject({ text: "停止期间说的话", steer: false });
			expect(await json<SessionView>(await api.get(`/sessions/${view.id}`))).toMatchObject({
				status: "running",
				queue_position: 1,
			});
			// 助手服务带回了第 2 轮的结局（它其实收下了这一轮）：用它，不是控制面补的。
			assistant.emit(view.id, 2, turnEnd(2, "stopped", "助手服务停下来了"));
			await settled();
			const ends = (await eventsOf(api, view.id)).filter((e) => e.type === "turn_end");
			expect(
				ends.map((e) => [(e as { turn: number }).turn, (e as { reason: string }).reason]),
			).toEqual([
				[1, "助手已完成"],
				[2, "助手服务停下来了"],
			]);
			// 排在后面的那句话开始了第 3 轮，交给助手服务的是它。
			await eventually(() =>
				expect(assistant.prompts.at(-1)?.body).toMatchObject({ turn: 3, text: "停止期间说的话" }),
			);
			// 第 3 轮做完：这个测试文件的几个用例共用一个项目，不留在做的会话堵住后面的用例。
			assistant.emit(view.id, 3, turnEnd(3));
			await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		} finally {
			assistant.promptDelayMs = 0;
			await settled();
		}
	});

	it("新建会话时 prompt 结果未知、等结局期间别人对它说了话：会话不删（那句话不跟着没了），结局写下之后那句话开始第 2 轮；助手服务那边任何时刻只有一轮", async () => {
		assistant.stopSettleMs = 800; // 这一轮在中止之后 800 毫秒才结束
		assistant.promptDelayMs = 600;
		let id: string | undefined;
		// 这个 describe 里的用例共用一个库，前面的用例留下的会话还在：比较前后的差。
		const before = await sessionCount(cp);
		try {
			const res = await api.post("/projects/default/sessions", { text: "冷启动很慢" });
			expect(res.status).toBe(503);
			id = assistant.prompts.at(-1)?.sessionId as string;
			// 慢只慢第一个 `prompt`：之后那句话开始的第 2 轮的 `prompt` 照常回应（不然它也超时，又补发一次中止）。
			assistant.promptDelayMs = 0;
			expect((await sessionRow(cp, id))?.status).toBe("running");
			// 别人对它说话：新的一轮的开头，排在后面（200）。
			const said = await api.post(`/sessions/${id}/messages`, { text: "等的时候说的话" }, "bob");
			expect(said.status).toBe(200);
			await settled();
			// 会话还在；这一轮结局写下之后，那句话开始了第 2 轮（助手服务的第 1 轮已经结束，第 2 轮的 prompt 才到，没有被回 409）。
			expect(await sessionCount(cp)).toBe(before + 1);
			expect(
				assistant.prompts
					.filter((p) => p.sessionId === id)
					.map((p) => [p.sessionId, p.body.turn, p.body.text]),
			).toEqual([
				[id, 1, "冷启动很慢"],
				[id, 2, "等的时候说的话"],
			]);
			const events = await eventsOf(api, id);
			expect(events.filter((e) => e.type === "turn_started")).toHaveLength(2);
			expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
			// 收尾：第 2 轮做完。
			assistant.emit(id, 2, turnEnd(2));
			await eventually(async () =>
				expect((await sessionRow(cp, id as string))?.status).toBe("idle"),
			);
		} finally {
			assistant.stopSettleMs = 0;
			assistant.promptDelayMs = 0;
			await settled();
		}
	});

	it("prompt 被收下（这一轮真的开始了）却回了 500：控制面按结果未知处理——补发带轮次的 abort，用助手服务带回的结局，不是自己补的", async () => {
		try {
			const view = await json<SessionView>(
				await api.post("/projects/default/sessions", { text: "第一句" }),
			);
			assistant.emit(view.id, 1, turnEnd(1));
			await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
			assistant.aborts.length = 0;
			assistant.abortRequests.length = 0;
			assistant.promptAcceptedThenReply = () => ({
				status: 500,
				code: "start_failed",
				message: "回应出错了",
			});
			const res = await api.post(`/sessions/${view.id}/messages`, { text: "第二句" });
			expect(res.status).toBe(503);
			await eventually(() =>
				expect(assistant.abortRequests).toEqual([{ sessionId: view.id, turn: 2 }]),
			);
			await settled();
			expect((await sessionRow(cp, view.id))?.status).toBe("idle");
			// 结局是助手服务带回的（中止结束的，`stopped`），不是控制面补的（控制面补的是失败的结局，`failed`）。
			expect((await eventsOf(api, view.id)).at(-1)).toMatchObject({
				type: "turn_end",
				turn: 2,
				outcome: "stopped",
			});
		} finally {
			assistant.promptAcceptedThenReply = () => undefined;
			await settled();
		}
	});

	it("新建会话 prompt 结果未知、助手服务其实收下了这一轮、做了事、结局也是它带回的：会话不删（工作区里的改动留着，会话记录不能没）", async () => {
		// 期限放长、助手服务收下中止之后 400 毫秒才结束这一轮：这段时间里它的事件照常记，结局是它带回的。
		setStopGrace(cp, 5_000);
		assistant.stopSettleMs = 400;
		assistant.promptAcceptedThenReply = () => ({
			status: 500,
			code: "start_failed",
			message: "回应出错了",
		});
		const res = await api.post("/projects/default/sessions", { text: "做点事" });
		expect(res.status).toBe(503);
		const id = assistant.prompts.at(-1)?.sessionId as string;
		assistant.emit(id, 1, assistantMessage("做了一点"));
		await eventually(async () =>
			expect((await eventsOf(api, id)).map((e) => e.type)).toContain("assistant_message"),
		);
		await settled();
		expect(await sessionCount(cp)).toBe(1);
		expect((await eventsOf(api, id)).map((e) => e.type)).toEqual([
			"user_message",
			"turn_started",
			"assistant_message",
			"turn_end",
		]);
		expect((await sessionRow(cp, id))?.status).toBe("idle");
	});

	it("新建会话 prompt 结果未知、助手服务收下了这一轮、没做什么事就带回了结局（它的 turn_end）：会话也不删，结局是助手服务带回的就算碰过", async () => {
		assistant.promptAcceptedThenReply = () => ({
			status: 500,
			code: "start_failed",
			message: "回应出错了",
		});
		const res = await api.post("/projects/default/sessions", { text: "做点事" });
		expect(res.status).toBe(503);
		const id = assistant.prompts.at(-1)?.sessionId as string;
		await settled();
		expect(await sessionCount(cp)).toBe(1);
		const events = await eventsOf(api, id);
		expect(events.map((e) => e.type)).toEqual(["user_message", "turn_started", "turn_end"]);
		// 结局是助手服务带回的（`stopped`），不是控制面补的（控制面补的是失败的结局，`failed`）。
		expect(events.at(-1)).toMatchObject({ outcome: "stopped" });
	});

	it("新建会话 prompt 结果未知、助手服务做了事但没有带回结局（控制面到期自己补）：会话也不删，这一轮里有助手服务的事件就算碰过", async () => {
		// 助手服务收下中止之后停得比期限（放长到 1 秒）慢：到期由控制面补；让助手服务的事件在期限之内到。
		assistant.stopSettleMs = 2_500;
		setStopGrace(cp, 1_000);
		assistant.promptReply = () => ({ status: 500, code: "start_failed", message: "出错了" });
		const res = await api.post("/projects/default/sessions", { text: "做点事" });
		expect(res.status).toBe(503);
		const id = assistant.prompts.at(-1)?.sessionId as string;
		assistant.emit(id, 1, assistantMessage("做了一点"));
		await settled();
		expect(await sessionCount(cp)).toBe(1);
		const events = await eventsOf(api, id);
		expect(events.map((e) => e.type)).toEqual([
			"user_message",
			"turn_started",
			"assistant_message",
			"turn_end",
		]);
		// 结局是控制面补的（失败的结局，原因是助手服务没接住这一轮），不是助手服务带回的：这一轮里有助手服务的事件，照样不删。
		expect(events.at(-1)).toMatchObject({ type: "turn_end", outcome: "failed" });
	});

	it("新建会话 prompt 结果未知、等结局期间有人结束它：会话不被删（让结束做完），/end 回 200，助手服务收到 end", async () => {
		// 助手服务停得比期限（300 毫秒）慢：控制面到期自己补结局，结束和这条结局后面的「删没被碰过的会话」撞在一起。
		assistant.stopSettleMs = 1_500;
		assistant.promptReply = () => ({ status: 500, code: "start_failed", message: "出错了" });
		const res = await api.post("/projects/default/sessions", { text: "甲" });
		expect(res.status).toBe(503);
		const id = assistant.prompts.at(-1)?.sessionId as string;
		assistant.promptReply = () => undefined;
		// 写 `session_ended` 慢一点：控制面补的结局之后「删没被碰过的会话」先到，看它让不让结束做完。
		const store = cp.current.sessions;
		const realEnd = store.end.bind(store);
		const spy = vi.spyOn(store, "end").mockImplementation(async (...args) => {
			await new Promise((resolve) => setTimeout(resolve, 400));
			return realEnd(...args);
		});
		let ended: Response;
		try {
			ended = await api.post(`/sessions/${id}/end`, {}, "bob");
			await settled();
		} finally {
			spy.mockRestore();
		}
		expect(ended.status).toBe(200);
		expect((await sessionRow(cp, id))?.status).toBe("ended");
		expect(assistant.ends).toContain(id);
	});

	it("prompt 回 500（不是 503 的 5xx，结果未知）：和超时一个口径，补发中止、等到期再补；回 503 是确定没开始，马上补、不发中止", async () => {
		const view = await json<SessionView>(
			await api.post("/projects/default/sessions", { text: "第一句" }),
		);
		assistant.emit(view.id, 1, turnEnd(1));
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		assistant.aborts.length = 0;
		assistant.abortRequests.length = 0;
		assistant.abortMarks.clear();
		assistant.abortAttempts = 0;
		try {
			// 503：确定没开始。
			assistant.promptReply = () => ({ status: 503, code: "start_failed", message: "起不来" });
			expect((await api.post(`/sessions/${view.id}/messages`, { text: "第二句" })).status).toBe(
				503,
			);
			expect((await sessionRow(cp, view.id))?.status).toBe("idle");
			expect(assistant.abortAttempts).toBe(0);
			// 500：结果未知。
			assistant.promptReply = () => ({ status: 500, code: "start_failed", message: "出错了" });
			expect((await api.post(`/sessions/${view.id}/messages`, { text: "第三句" })).status).toBe(
				503,
			);
			expect((await sessionRow(cp, view.id))?.status).toBe("running");
			await eventually(() =>
				expect(assistant.abortRequests).toEqual([{ sessionId: view.id, turn: 3 }]),
			);
			await settled();
			expect((await sessionRow(cp, view.id))?.status).toBe("idle");
			expect((await eventsOf(api, view.id)).at(-1)).toMatchObject({
				type: "turn_end",
				turn: 3,
				outcome: "failed",
			});
		} finally {
			assistant.promptReply = () => undefined;
			await settled();
		}
	});

	it("补发的中止先于这一轮到助手服务（它那时还没登记这一轮）也不会落空，助手服务记下记号；控制面补完结局之后，用户点停止时仍向助手服务发一次按会话的中止，会话本身不变", async () => {
		const view = await json<SessionView>(
			await api.post("/projects/default/sessions", { text: "第一句" }),
		);
		assistant.emit(view.id, 1, turnEnd(1));
		await eventually(async () => expect((await sessionRow(cp, view.id))?.status).toBe("idle"));
		assistant.aborts.length = 0;
		assistant.abortRequests.length = 0;
		assistant.abortMarks.clear();
		assistant.promptDelayMs = 600;
		try {
			expect((await api.post(`/sessions/${view.id}/messages`, { text: "第二句" })).status).toBe(
				503,
			);
			// 超时之后补发的那一次（这里的假助手服务只是记下，没有「登记」可言）。
			await eventually(() => expect(assistant.aborts).toEqual([view.id]));
			await settled();
		} finally {
			assistant.promptDelayMs = 0;
		}
		expect(assistant.abortRequests).toEqual([{ sessionId: view.id, turn: 2 }]);
		const before = (await eventsOf(api, view.id)).length;
		const stopped = await api.post(`/sessions/${view.id}/stop`, {});
		expect(stopped.status).toBe(200);
		expect(await json<SessionView>(stopped)).toMatchObject({ status: "idle" });
		await eventually(() => expect(assistant.aborts).toEqual([view.id, view.id]));
		// 点停止带的是最近的那一轮（第 2 轮：已经由控制面以失败结束），和超时补发的是同一轮，别的轮次不受影响。
		expect(assistant.abortRequests).toEqual([
			{ sessionId: view.id, turn: 2 },
			{ sessionId: view.id, turn: 2 },
		]);
		expect((await eventsOf(api, view.id)).length).toBe(before);
		expect((await sessionRow(cp, view.id))?.status).toBe("idle");
	});
});

describe("事件流的心跳：静默的连接不会被掐断，死了的连接会被发现", () => {
	it("助手服务按协议写心跳：连接空闲了好几个阈值也不断，没有重连", async () => {
		const assistant = await FakeAssistant.start({ heartbeatMs: 60 });
		const cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			assistantReconnectMs: { min: 20, max: 100 },
			// 300 毫秒没有任何字节就当连接死了。
			assistantEventsIdleMs: 300,
		});
		try {
			await assistant.connected();
			await new Promise((resolve) => setTimeout(resolve, 1200));
			expect(assistant.eventRequests).toBe(1);
			expect(assistant.streams).toBe(1);
		} finally {
			await cp.close();
			await assistant.close();
		}
	}, 30_000);

	it("助手服务不发心跳、也没有事件：超过阈值控制面主动断开重连（不等响应体超时 300 秒），重连之后的事件照常落库", async () => {
		const assistant = await FakeAssistant.start({ heartbeatMs: 0 });
		const cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			assistantEventsIdleMs: 300,
		});
		const workbench = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: cp.clock },
		);
		try {
			await assistant.connected();
			await eventually(() => expect(assistant.eventRequests).toBeGreaterThanOrEqual(3), 5000);
			await assistant.connected();
			// 连接又连上了：这时来的事件照常处理。
			const api = new ApiClient(asUsers(cp));
			const view = await json<SessionView>(
				await api.post("/projects/default/sessions", { text: "你好" }),
			);
			assistant.emit(view.id, 1, assistantMessage("重连之后的消息"));
			await eventually(async () =>
				expect(
					(await api.getJson<SessionDetailResponse>(`/sessions/${view.id}`)).events.at(-1),
				).toMatchObject({ type: "assistant_message", text: "重连之后的消息" }),
			);
		} finally {
			await workbench.disconnect();
			await cp.close();
			await assistant.close();
		}
	}, 30_000);

	it("有心跳时，事件和心跳混着来：事件照常落库，连接不断", async () => {
		const assistant = await FakeAssistant.start({ heartbeatMs: 60 });
		const cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			assistantEventsIdleMs: 300,
		});
		const workbench = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: cp.clock },
		);
		try {
			await assistant.connected();
			const api = new ApiClient(asUsers(cp));
			const view = await json<SessionView>(
				await api.post("/projects/default/sessions", { text: "你好" }),
			);
			await new Promise((resolve) => setTimeout(resolve, 700));
			assistant.emit(view.id, 1, assistantMessage("心跳之后的消息"));
			await eventually(async () =>
				expect(
					(await api.getJson<SessionDetailResponse>(`/sessions/${view.id}`)).events.at(-1),
				).toMatchObject({
					text: "心跳之后的消息",
				}),
			);
			expect(assistant.eventRequests).toBe(1);
		} finally {
			await workbench.disconnect();
			await cp.close();
			await assistant.close();
		}
	}, 30_000);
});

describe("停止的等待和助手服务的强制结束对齐", () => {
	it("控制面等的时间就是协议里的 ASSISTANT_STOP_WAIT_MS：不短于「先等 abort、不行再结束进程」最坏的那条路加余量", () => {
		expect(STOP_GRACE_MS).toBe(ASSISTANT_STOP_WAIT_MS);
		expect(STOP_GRACE_MS).toBeGreaterThanOrEqual(
			ASSISTANT_ABORT_SETTLE_MS + ASSISTANT_PROCESS_KILL_GRACE_MS + 1_000,
		);
	});

	it("助手服务 6 秒之后才带回这一轮的结局（比原来的 5 秒慢、比宽限快）：控制面等着它，不先补结局；停止之后马上再说一句，新的一轮照常开始", async () => {
		const assistant = await FakeAssistant.start();
		// 用真正的默认宽限（不是测试里缩短的 300 毫秒）。
		const cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			// 不传值：用控制面自己的默认（生产走的就是它）。
			sessionStopGraceMs: "production",
		});
		const workbench = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: cp.clock },
		);
		try {
			await assistant.connected();
			const api = new ApiClient(asUsers(cp));
			const view = await json<SessionView>(
				await api.post("/projects/default/sessions", { text: "第一句" }),
			);
			// 助手服务停一轮要几秒（先关输入、SIGTERM、等进程退出），结局在进程退出之后才发：假助手服务的「在停止」6 秒。
			assistant.stopSettleMs = 6_000;
			const started = Date.now();
			const stopped = await api.post(`/sessions/${view.id}/stop`, {});
			expect(stopped.status).toBe(200);
			expect(Date.now() - started).toBeGreaterThanOrEqual(5_500);
			expect(await json<SessionView>(stopped)).toMatchObject({
				status: "idle",
				last_turn_outcome: "stopped",
			});
			// 结局是助手服务带回来的，不是控制面先补的。
			const ends = (await eventsOf(api, view.id)).filter((e) => e.type === "turn_end");
			expect(ends).toHaveLength(1);
			expect(String((ends[0] as { reason: string }).reason)).not.toContain("由控制面结束");
			// 马上再说一句：新的一轮照常开始。
			assistant.stopSettleMs = 0;
			expect((await api.post(`/sessions/${view.id}/messages`, { text: "再来一句" })).status).toBe(
				200,
			);
			expect(assistant.prompts.at(-1)?.body.turn).toBe(2);
		} finally {
			await workbench.disconnect();
			await cp.close();
			await assistant.close();
		}
	}, 30_000);
});

describe("日志里有原因、没有会话的内容", () => {
	it("助手服务没有接住这一轮：日志写会话、轮次和底层错误的原文，不写用户的话；回给人的只有稳定的一句", async () => {
		const assistant = await FakeAssistant.start();
		const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
		const cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			logger: { stream: sink },
		});
		const workbench = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: cp.clock },
		);
		const logged: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logged.push(
				args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 6 }))).join(" "),
			);
		});
		try {
			await assistant.connected();
			const api = new ApiClient(asUsers(cp));
			const secretText = "我的私密的话 hunter2-不该出现在日志里";
			const port = new URL(assistant.url).port;
			// 1. 助手服务连不上。
			await assistant.stop();
			const refused = await api.post("/projects/default/sessions", { text: secretText });
			expect(refused.status).toBe(503);
			expect((await json<{ error: { message: string } }>(refused)).error.message).toBe(
				"连不上助手服务：连接被拒绝",
			);
			await assistant.resume();
			await assistant.connected();
			// 2. 助手服务拒绝，说明里带内部的路径。
			assistant.promptReply = () => ({
				status: 503,
				code: "start_failed",
				message: "ENOENT /srv/assistant/internal-path",
			});
			const rejected = await api.post("/projects/default/sessions", { text: secretText });
			expect(rejected.status).toBe(503);
			expect(JSON.stringify(await rejected.json())).not.toContain("/srv/assistant");
			const text = logged.join("\n");
			// 日志里：哪个会话的哪一轮没接住，底层错误的原文（连接被拒带地址和端口、助手服务写的那句话）。
			expect(text).toMatch(/助手服务没有接住会话 [0-9a-f-]{36} 的第 1 轮/);
			expect(text).toContain("ECONNREFUSED");
			expect(text).toContain(port);
			expect(text).toContain("/srv/assistant/internal-path");
			// 日志里没有用户的话。
			expect(text).not.toContain("hunter2");
			expect(text).not.toContain("我的私密的话");
		} finally {
			spy.mockRestore();
			await workbench.disconnect();
			await cp.close();
			await assistant.close();
		}
	}, 30_000);
});

describe("停止时中止的命令超时（结果未知）：照样等助手服务带回结局", () => {
	let assistant: FakeAssistant;
	let cp: TestControlPlane;
	let workbench: FakeAgent;
	let api: ApiClient;

	beforeAll(async () => {
		assistant = await FakeAssistant.start();
		cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			// 命令最多等 150 毫秒；停止等结局最多 1.5 秒。
			assistantCommandTimeoutMs: 150,
			sessionStopGraceMs: 1_500,
		});
		api = new ApiClient(asUsers(cp));
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

	it("中止的命令超时：助手服务可能已经收下了，只是没来得及回应；控制面照样等它带回结局，结局是助手服务的，不是控制面先补的", async () => {
		const view = await json<SessionView>(
			await api.post("/projects/default/sessions", { text: "第一句" }),
		);
		// 中止 400 毫秒才回应（超过命令的 150 毫秒），助手服务收下中止之后 300 毫秒带回这一轮的结局（假助手服务按协议：处理在先、回应在后；
		// 结局落在命令超时之后、期限（1.5 秒）之内：中止命令超时就马上自己补结局的话，这条会红）。
		assistant.abortDelayMs = 400;
		assistant.stopSettleMs = 300;
		try {
			const stopped = await api.post(`/sessions/${view.id}/stop`, {});
			expect(stopped.status).toBe(200);
			expect(await json<SessionView>(stopped)).toMatchObject({ status: "idle" });
			const ends = (await eventsOf(api, view.id)).filter((e) => e.type === "turn_end");
			expect(ends).toHaveLength(1);
			expect(ends[0]).toMatchObject({ outcome: "stopped" });
			expect(String((ends[0] as { reason: string }).reason)).not.toContain("由控制面结束");
		} finally {
			assistant.abortDelayMs = 0;
			assistant.stopSettleMs = 0;
		}
	});

	it("中止没有得到 202（连接被拒绝）：不马上补结局，等到发出中止起的期限，到期才由控制面补；项目的位置在那之前不空出来", async () => {
		const view = await json<SessionView>(
			await api.post("/projects/default/sessions", { text: "第二句" }),
		);
		await assistant.stop();
		try {
			const started = Date.now();
			const stopped = await api.post(`/sessions/${view.id}/stop`, {});
			expect(stopped.status).toBe(200);
			// 期限是 1.5 秒（从发出中止起算）：这期间助手服务那边这一轮可能还在做，不能先把位置空出来。
			expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
			const ends = (await eventsOf(api, view.id)).filter((e) => e.type === "turn_end");
			expect(ends).toHaveLength(1);
			expect(String((ends[0] as { reason: string }).reason)).toContain("由控制面结束");
		} finally {
			await assistant.resume();
			await assistant.connected();
		}
	});

	it("中止没有得到 202（连接被拒绝）、期间助手服务回来并带回了这一轮的结局：用它，不补；结局写下之前会话一直是在做", async () => {
		const view = await json<SessionView>(
			await api.post("/projects/default/sessions", { text: "第三句" }),
		);
		await assistant.stop();
		let stopping: Promise<Response> | undefined;
		try {
			stopping = api.post(`/sessions/${view.id}/stop`, {});
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect((await sessionRow(cp, view.id))?.status).toBe("running");
			await assistant.resume();
			await assistant.connected();
			assistant.emit(view.id, 1, turnEnd(1, "stopped", "助手服务自己停下来了"));
			expect((await stopping).status).toBe(200);
		} finally {
			await stopping?.catch(() => undefined);
		}
		const ends = (await eventsOf(api, view.id)).filter((e) => e.type === "turn_end");
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ outcome: "stopped", reason: "助手服务自己停下来了" });
		expect((await sessionRow(cp, view.id))?.status).toBe("idle");
	});
});
