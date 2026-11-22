// 会话令牌的请求：运行和场景版本记着是哪个会话做的，会话里同一个事务写一条平台记录（规格 #547）。
// 依据是控制面收到的请求带着哪个会话的令牌，不是模型在对话里怎么说，也不是可以伪造的 `x-sfly-client` 标注。
// 真实控制面、真实 PostgreSQL、假 Agent；会话和会话令牌直接写库造（签发和吊销在会话的写接口里，不在这里）。
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { bearer, TestAccounts } from "./support/credentials.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const JSON_HEADERS = { "content-type": "application/json" };

const document = () => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [{ name: "host", type: "string", required: true }] },
		{
			id: "a",
			kind: "package",
			package: "stub",
			node: "echo",
			inputs: { v: "${{ params.host }}" },
		},
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
});

interface EventRow {
	seq: number;
	type: string;
	payload: Record<string, unknown>;
}

describe("会话令牌的请求：运行和场景版本记着会话", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let db: pg.Client;
	let api: ApiClient;
	let agent: FakeAgent;
	let editor: string;
	let sessionId: string;
	let token: string;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		accounts = new TestAccounts(cp.database.url);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
		editor = await accounts.user("editor1", { displayName: "小编" });
		await accounts.member("default", editor, "editor");
		sessionId = await accounts.session(editor, "default", { title: "改巡检节点" });
		token = await accounts.sessionTokenIn(sessionId, editor, "default", {
			name: "会话：改巡检节点",
			scopes: ["read", "run", "edit", "session_build"],
		});
	});
	afterEach(async () => {
		await agent.disconnect();
		await db.end();
		await accounts.close();
		await cp.close();
	});

	const send = (
		method: string,
		path: string,
		credential: Record<string, string>,
		body?: unknown,
		extra: Record<string, string> = {},
	) =>
		cp.fetch(path, {
			method,
			headers: { ...(body === undefined ? {} : JSON_HEADERS), ...credential, ...extra },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const asSession = (
		method: string,
		path: string,
		body?: unknown,
		extra?: Record<string, string>,
	) => send(method, path, bearer(token), body, extra);
	const json = async <T>(res: Response, status: number): Promise<T> => {
		expect(res.status, await res.clone().text()).toBe(status);
		return (await res.json()) as T;
	};
	const events = async (id = sessionId): Promise<EventRow[]> =>
		(
			await db.query<EventRow>(
				"select seq, type, payload from session_events where session_id = $1 order by seq",
				[id],
			)
		).rows;
	const platform = async (id = sessionId) =>
		(await events(id)).filter((event) => event.type === "platform");
	const runSession = async (runId: string) =>
		(
			await db.query<{ session_id: string | null; triggered_token: string | null }>(
				"select session_id, triggered_token from runs where id = $1",
				[runId],
			)
		).rows[0];
	const versionSession = async (orchestrationId: string, number: number) =>
		(
			await db.query<{
				session_id: string | null;
				author_token: string | null;
				author_via: string | null;
			}>(
				"select session_id, author_token, author_via from orchestration_versions where orchestration_id = $1 and number = $2",
				[orchestrationId, number],
			)
		).rows[0];
	/** 人（不带凭据）建好一个场景并保存第 1 版：会话令牌之外的起点。 */
	const scenario = async (name = "接口巡检") => api.orchestrationWith(document(), name);

	describe("触发运行", () => {
		it("运行上记着这个会话，会话里同一个事务写一条平台记录（运行 ID、场景名、第几轮）", async () => {
			const id = await scenario();
			const created = await json<{ id: string }>(
				await asSession("POST", `/orchestrations/${id}/runs`, { params: { host: "h" } }),
				201,
			);
			expect(await runSession(created.id)).toEqual({
				session_id: sessionId,
				triggered_token: "会话：改巡检节点",
			});
			const records = await platform();
			expect(records).toEqual([
				{
					seq: 2,
					type: "platform",
					payload: { kind: "run", turn: 1, run_id: created.id, scenario_name: "接口巡检" },
				},
			]);
		});

		it("会话在第几轮，记录就写第几轮（取最后一条 turn_started）", async () => {
			await db.query(
				`insert into session_events (session_id, seq, type, payload, created_at)
				values ($1, 2, 'turn_started', '{"turn": 2}', now())`,
				[sessionId],
			);
			const id = await scenario();
			await json(
				await asSession("POST", `/orchestrations/${id}/runs`, { params: { host: "h" } }),
				201,
			);
			expect((await platform())[0]?.payload).toMatchObject({ kind: "run", turn: 2 });
		});

		it("人、个人令牌触发的运行没有会话，会话里也没有记录；`x-sfly-client` 写成什么都不影响", async () => {
			const id = await scenario();
			const personal = await accounts.personalToken(editor);
			const byPerson = await json<{ id: string }>(
				await send(
					"POST",
					`/orchestrations/${id}/runs`,
					bearer(personal),
					{ params: { host: "h" } },
					{ "x-sfly-client": "agent/pi" },
				),
				201,
			);
			const anonymous = await api.triggerOk(id, { host: "h" });
			for (const runId of [byPerson.id, anonymous]) {
				expect((await runSession(runId))?.session_id).toBeNull();
			}
			expect(await platform()).toEqual([]);
		});

		it("会话令牌带着伪造的 x-sfly-client：标注照记（只是标注），会话照样是令牌的那个", async () => {
			const id = await scenario();
			const created = await json<{ id: string }>(
				await asSession(
					"POST",
					`/orchestrations/${id}/runs`,
					{ params: { host: "h" } },
					{
						"x-sfly-client": "agent/claude-code",
					},
				),
				201,
			);
			const row = (
				await db.query("select session_id, triggered_via from runs where id = $1", [created.id])
			).rows[0];
			expect(row).toEqual({ session_id: sessionId, triggered_via: "claude-code" });
		});

		it("触发被拒绝（缺必填参数、场景没有版本）：没有运行，会话里没有记录", async () => {
			const id = await scenario();
			await json(await asSession("POST", `/orchestrations/${id}/runs`, { params: {} }), 400);
			const empty = await api.createOrchestration("空场景");
			await json(await asSession("POST", `/orchestrations/${empty}/runs`, { params: {} }), 400);
			expect((await db.query("select count(*)::int as n from runs")).rows[0]).toEqual({ n: 0 });
			expect(await platform()).toEqual([]);
		});

		it("记录提交之后才推送：订阅会话事件流的一方收到 platform，读库也读得到", async () => {
			const id = await scenario();
			const sse = await SseClient.open(cp, `/sessions/${sessionId}/events`, bearer(token));
			try {
				await sse.next("turn_started");
				const created = await json<{ id: string }>(
					await asSession("POST", `/orchestrations/${id}/runs`, { params: { host: "h" } }),
					201,
				);
				const pushed = await sse.next<{ kind: string; run_id: string }>("platform");
				expect(pushed.data).toMatchObject({ kind: "run", run_id: created.id });
				expect((await platform())[0]?.payload).toMatchObject({ run_id: created.id });
			} finally {
				sse.close();
			}
		});
	});

	describe("保存、恢复、复制场景版本", () => {
		it("保存版本：版本上记着会话，记录里有场景 ID、名称、版本号", async () => {
			const id = await scenario("接口巡检");
			const saved = await json<{ number: number }>(
				await asSession("POST", `/orchestrations/${id}/versions`, {
					base_version: 1,
					document: document(),
				}),
				201,
			);
			expect(saved.number).toBe(2);
			expect(await versionSession(id, 2)).toEqual({
				session_id: sessionId,
				author_token: "会话：改巡检节点",
				author_via: null,
			});
			// 人保存的第 1 版没有会话。
			expect((await versionSession(id, 1))?.session_id).toBeNull();
			expect(await platform()).toEqual([
				{
					seq: 2,
					type: "platform",
					payload: {
						kind: "scenario_version",
						turn: 1,
						scenario_id: id,
						name: "接口巡检",
						version: 2,
					},
				},
			]);
		});

		it("保存没有成功（编辑起点过期 409）：版本和记录都没有", async () => {
			const id = await scenario();
			await json(
				await asSession("POST", `/orchestrations/${id}/versions`, {
					base_version: 7,
					document: document(),
				}),
				409,
			);
			expect(await platform()).toEqual([]);
			expect(
				(
					await db.query(
						"select count(*)::int as n from orchestration_versions where session_id = $1",
						[sessionId],
					)
				).rows[0],
			).toEqual({ n: 0 });
		});

		it("恢复历史版本：新追加的版本记着会话，记录里是新版本号", async () => {
			const id = await scenario();
			await json(
				await asSession("POST", `/orchestrations/${id}/versions`, {
					base_version: 1,
					document: document(),
				}),
				201,
			);
			await json(await asSession("POST", `/orchestrations/${id}/versions/1/restore`), 201);
			expect((await versionSession(id, 3))?.session_id).toBe(sessionId);
			expect((await platform()).map((event) => event.payload)).toEqual([
				expect.objectContaining({ kind: "scenario_version", version: 2 }),
				expect.objectContaining({ kind: "scenario_version", version: 3 }),
			]);
		});

		it("复制场景：副本的第 1 版记着会话，记录里是副本的 ID 和名称；源场景没有版本时副本也没有，不写记录", async () => {
			const id = await scenario();
			const copy = await json<{ id: string }>(
				await asSession("POST", `/orchestrations/${id}/copy`, { name: "接口巡检（副本）" }),
				201,
			);
			expect((await versionSession(copy.id, 1))?.session_id).toBe(sessionId);
			expect(await platform()).toEqual([
				expect.objectContaining({
					payload: {
						kind: "scenario_version",
						turn: 1,
						scenario_id: copy.id,
						name: "接口巡检（副本）",
						version: 1,
					},
				}),
			]);
			const empty = await api.createOrchestration("空场景");
			const emptyCopy = await json<{ id: string }>(
				await asSession("POST", `/orchestrations/${empty}/copy`, { name: "空场景（副本）" }),
				201,
			);
			expect(await versionSession(emptyCopy.id, 1)).toBeUndefined();
			expect(await platform()).toHaveLength(1);
		});

		it("个人令牌、登录保存的版本没有会话，会话里没有记录", async () => {
			const id = await scenario();
			const personal = await accounts.personalToken(editor);
			await json(
				await send("POST", `/orchestrations/${id}/versions`, bearer(personal), {
					base_version: 1,
					document: document(),
				}),
				201,
			);
			expect((await versionSession(id, 2))?.session_id).toBeNull();
			expect(await platform()).toEqual([]);
		});
	});

	describe("会话令牌能做什么、不能做什么（经 HTTP）", () => {
		it("取消：自己触发的成功；人触发的、别的会话触发的 403；取消之后运行上仍记着会话", async () => {
			const id = await scenario();
			const mine = await json<{ id: string }>(
				await asSession("POST", `/orchestrations/${id}/runs`, { params: { host: "h" } }),
				201,
			);
			const byPerson = await api.triggerOk(id, { host: "h" });
			const otherSession = await accounts.session(editor, "default", { title: "别的会话" });
			const otherToken = await accounts.sessionTokenIn(otherSession, editor, "default");
			const theirs = await json<{ id: string }>(
				await send("POST", `/orchestrations/${id}/runs`, bearer(otherToken), {
					params: { host: "h" },
				}),
				201,
			);
			for (const runId of [byPerson, theirs.id]) {
				const res = await asSession("POST", `/runs/${runId}/cancel`, {});
				expect(res.status, runId).toBe(403);
				expect(await res.json()).toMatchObject({
					error: { message: expect.stringContaining("只能取消这个会话自己触发的运行") },
				});
			}
			await json(await asSession("POST", `/runs/${mine.id}/cancel`, {}), 200);
			expect((await runSession(mine.id))?.session_id).toBe(sessionId);
		});

		it("归档场景、删除运行预设：403；发布节点包、管理类接口：403；建会话、发话、停止：403", async () => {
			const id = await scenario();
			for (const [method, path, body] of [
				["POST", `/orchestrations/${id}/archive`, {}],
				["DELETE", `/orchestrations/${id}/presets/${crypto.randomUUID()}`, undefined],
				["POST", "/feishu-bots", { name: "x", webhook_url: "https://example.com/hook" }],
				["POST", "/projects/default/tokens", { name: "x", scopes: ["read"] }],
				["POST", "/projects/default/sessions", { text: "你好" }],
				[`POST`, `/sessions/${sessionId}/messages`, { text: "你好" }],
				[`POST`, `/sessions/${sessionId}/stop`, {}],
			] as const) {
				const res = await asSession(method, path, body);
				expect(res.status, `${method} ${path}`).toBe(403);
			}
		});

		it("发起人被降成只读之后，会话令牌的写请求立即 403；读照旧", async () => {
			const id = await scenario();
			await accounts.member("default", editor, "read_only");
			expect(
				(await asSession("POST", `/orchestrations/${id}/runs`, { params: { host: "h" } })).status,
			).toBe(403);
			expect((await asSession("GET", `/orchestrations/${id}`)).status).toBe(200);
			expect(await platform()).toEqual([]);
		});

		it("另一个项目：会话令牌请求默认项目以外的资源是 404", async () => {
			await accounts.project("alpha");
			const alien = await accounts.session(editor, "alpha", { title: "项目甲的会话" });
			const alienToken = await accounts.sessionTokenIn(alien, editor, "alpha");
			const id = await scenario();
			expect(
				(
					await send("POST", `/orchestrations/${id}/runs`, bearer(alienToken), {
						params: { host: "h" },
					})
				).status,
			).toBe(404);
			expect(await platform(alien)).toEqual([]);
		});
	});
});
