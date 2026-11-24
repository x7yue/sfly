// 会话令牌的请求：运行和场景版本记着是哪个会话做的，会话里同一个事务写一条平台记录（规格 #547）。
// 依据是控制面收到的请求带着哪个会话的令牌，不是模型在对话里怎么说，也不是可以伪造的 `x-sfly-client` 标注。
// 真实控制面、真实 PostgreSQL、假 Agent；会话和会话令牌直接写库造（签发和吊销在会话的写接口里，不在这里）。
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { bearer, loginCookie, TestAccounts } from "./support/credentials.js";
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

		it("会话在第几轮，记录就写第几轮（取会话此刻在做的那一轮 current_turn）", async () => {
			await db.query("update sessions set current_turn = 2 where id = $1", [sessionId]);
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

		it("推送发生在事务提交之后：推送的那一刻，写记录的事务已经结束（会话那一行的锁放掉了）；运行和版本两条路径一样", async () => {
			const id = await scenario();
			const lockFree: Promise<boolean>[] = [];
			const original = cp.current.sessions.announce.bind(cp.current.sessions);
			vi.spyOn(cp.current.sessions, "announce").mockImplementation((target, event) => {
				// 事务没结束时，它还锁着会话那一行：NOWAIT 立刻失败。
				lockFree.push(
					db.query("select id from sessions where id = $1 for update nowait", [target]).then(
						() => true,
						() => false,
					),
				);
				return original(target, event);
			});
			await json(
				await asSession("POST", `/orchestrations/${id}/runs`, { params: { host: "h" } }),
				201,
			);
			await json(
				await asSession("POST", `/orchestrations/${id}/versions`, {
					base_version: 1,
					document: document(),
				}),
				201,
			);
			await json(await asSession("POST", `/orchestrations/${id}/versions/1/restore`), 201);
			await json(await asSession("POST", `/orchestrations/${id}/copy`, { name: "副本" }), 201);
			expect(await Promise.all(lockFree)).toEqual([true, true, true, true]);
		});

		it.each([
			[
				"触发运行",
				(id: string) => ({
					path: `/orchestrations/${id}/runs`,
					body: { params: { host: "h" } },
					kind: "run",
				}),
			],
			[
				"保存版本",
				(id: string) => ({
					path: `/orchestrations/${id}/versions`,
					body: { base_version: 1, document: document() },
					kind: "scenario_version",
				}),
			],
			[
				"恢复版本",
				(id: string) => ({
					path: `/orchestrations/${id}/versions/1/restore`,
					body: undefined,
					kind: "scenario_version",
				}),
			],
			[
				"复制场景",
				(id: string) => ({
					path: `/orchestrations/${id}/copy`,
					body: { name: "副本" },
					kind: "scenario_version",
				}),
			],
		])("推送被拖住（%s）：助手服务的事件先提交先推送时，订阅的一方看到的序号仍然一直递增、一条不少（先推送大的序号，小的就被当作已经发过而丢掉，所以推送大的之前先从库里补上小的）", async (_name, request) => {
			const id = await scenario();
			const { path, body, kind } = request(id);
			const sse = await SseClient.open(cp, `/sessions/${sessionId}/events`, bearer(token));
			try {
				await sse.next("turn_started");
				let release: () => void = () => {};
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				let entered: () => void = () => {};
				const reached = new Promise<void>((resolve) => {
					entered = resolve;
				});
				const original = cp.current.sessions.announce.bind(cp.current.sessions);
				vi.spyOn(cp.current.sessions, "announce").mockImplementation(async (target, event) => {
					entered();
					await gate;
					await original(target, event);
				});
				const done = asSession("POST", path, body);
				// 写记录的事务已经提交，推送被拖在这里。
				await reached;
				const appended = cp.current.sessions.append(sessionId, {
					type: "notice",
					kind: "compaction",
					message: "压缩了上下文",
				});
				// 给这条事件足够的时间落库、发布（要是它不用排队的话）。
				await new Promise((resolve) => setTimeout(resolve, 300));
				release();
				await json(await done, 201);
				await appended;
				const platformEvent = await sse.next<{ kind: string }>("platform");
				const notice = await sse.next("notice");
				expect(platformEvent.data).toMatchObject({ kind });
				// 先收到平台记录，后收到提示；序号一直递增。
				expect(Number(platformEvent.id)).toBeLessThan(Number(notice.id));
			} finally {
				sse.close();
			}
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

	describe("响应里的会话：运行页、版本历史上「经 …」显示它", () => {
		it("运行视图、场景的运行列表、运行记录里，会话触发的运行带 session（ID 和会话此刻的标题）；别的运行没有这个字段", async () => {
			const id = await scenario();
			const mine = await json<{ id: string }>(
				await asSession("POST", `/orchestrations/${id}/runs`, { params: { host: "h" } }),
				201,
			);
			const byPerson = await api.triggerOk(id, { host: "h" });
			// 标题是会话此刻的标题：会话改了名，页面上跟着变。
			await db.query("update sessions set title = '改完的标题' where id = $1", [sessionId]);
			const ref = { id: sessionId, title: "改完的标题" };

			const viewOf = (runId: string) => api.getJson<{ session?: unknown }>(`/runs/${runId}`);
			expect((await viewOf(mine.id)).session).toEqual(ref);
			expect("session" in (await viewOf(byPerson))).toBe(false);
			const forScenario = await api.getJson<{ runs: Array<{ id: string; session?: unknown }> }>(
				`/orchestrations/${id}/runs`,
			);
			expect(forScenario.runs.find((run) => run.id === mine.id)?.session).toEqual(ref);
			expect("session" in (forScenario.runs.find((run) => run.id === byPerson) ?? {})).toBe(false);
			const records = await api.getJson<{ runs: Array<{ id: string; session?: unknown }> }>(
				"/runs",
			);
			expect(records.runs.find((run) => run.id === mine.id)?.session).toEqual(ref);
			expect("session" in (records.runs.find((run) => run.id === byPerson) ?? {})).toBe(false);
		});

		it("运行摘要、看板里在跑的运行也带 session（它们显示「谁、经什么触发」）；人触发的没有；节点里读到的运行状态（run.state）不带它", async () => {
			const id = await scenario();
			const mine = await json<{ id: string }>(
				await asSession("POST", `/orchestrations/${id}/runs`, { params: { host: "h" } }),
				201,
			);
			const byPerson = await api.triggerOk(id, { host: "h" });
			await db.query("update sessions set title = '改完的标题' where id = $1", [sessionId]);
			const ref = { id: sessionId, title: "改完的标题" };

			const summary = (runId: string) =>
				api.getJson<{ session?: unknown; triggered_via: string | null }>(`/runs/${runId}/summary`);
			expect((await summary(mine.id)).session).toEqual(ref);
			expect("session" in (await summary(byPerson))).toBe(false);

			const dashboard = await api.getJson<{
				running_runs: Array<{ id: string; session?: unknown }>;
			}>("/dashboard");
			expect(dashboard.running_runs.find((run) => run.id === mine.id)?.session).toEqual(ref);
			expect("session" in (dashboard.running_runs.find((run) => run.id === byPerson) ?? {})).toBe(
				false,
			);
		});

		it("版本历史、单个版本、保存的响应里，会话保存的版本带 session；人保存的没有", async () => {
			const id = await scenario();
			const saved = await json<{ number: number; session?: unknown }>(
				await asSession("POST", `/orchestrations/${id}/versions`, {
					base_version: 1,
					document: document(),
				}),
				201,
			);
			const ref = { id: sessionId, title: "改巡检节点" };
			expect(saved.session).toEqual(ref);
			const { versions: list } = await api.getJson<{
				versions: Array<{ number: number; session?: unknown }>;
			}>(`/orchestrations/${id}/versions`);
			expect(list.find((v) => v.number === 2)?.session).toEqual(ref);
			expect("session" in (list.find((v) => v.number === 1) ?? {})).toBe(false);
			const one = await api.getJson<{ session?: unknown }>(`/orchestrations/${id}/versions/2`);
			expect(one.session).toEqual(ref);
			const first = await api.getJson<{ session?: unknown }>(`/orchestrations/${id}/versions/1`);
			expect("session" in first).toBe(false);
		});

		it("编辑起点过期（409）时带回的最新版本摘要也带 session", async () => {
			const id = await scenario();
			await json(
				await asSession("POST", `/orchestrations/${id}/versions`, {
					base_version: 1,
					document: document(),
				}),
				201,
			);
			const stale = await api.post(`/orchestrations/${id}/versions`, {
				base_version: 1,
				document: document(),
			});
			expect(stale.status).toBe(409);
			expect(await stale.json()).toMatchObject({
				error: { details: { head: { number: 2, session: { id: sessionId } } } },
			});
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

	describe("令牌行和会话对得上、事务、链、会话的状态", () => {
		it("令牌行的项目和它所属会话的项目对不上：库里的组合外键拒绝（造不出这样的行）", async () => {
			await accounts.project("beta");
			const betaSession = await accounts.session(editor, "beta", { title: "乙的会话" });
			await expect(accounts.sessionTokenIn(betaSession, editor, "default")).rejects.toMatchObject({
				code: "23503",
				constraint: "api_tokens_session_project_fk",
			});
		});

		it("令牌的发起人和会话的发起人对不上（库里的外键拦不住）：401，当作不认识的令牌，没有运行、没有记录", async () => {
			const id = await scenario();
			const other = await accounts.user("editor2");
			await accounts.member("default", other, "editor");
			const wrong = await accounts.sessionTokenIn(sessionId, other, "default", {
				scopes: ["read", "run", "edit", "session_build"],
			});
			const res = await send("POST", `/orchestrations/${id}/runs`, bearer(wrong), {
				params: { host: "h" },
			});
			expect(res.status).toBe(401);
			expect((await db.query("select count(*)::int as n from runs")).rows[0]).toEqual({ n: 0 });
			expect(await platform()).toEqual([]);
		});

		it("已结束的会话，它的令牌从此无效（401）：读、写都是；会话空闲、在做都有效", async () => {
			const id = await scenario();
			for (const status of ["idle", "running", "queued"]) {
				// 排队中的会话一定有排队时间（库里的约束 `sessions_queued_at`），别的状态没有。
				await db.query(
					"update sessions set status = $2::text, queued_at = case when $2::text = 'queued' then now() else null end where id = $1",
					[sessionId, status],
				);
				expect((await asSession("GET", `/orchestrations/${id}`)).status, status).toBe(200);
			}
			await db.query("update sessions set status = 'ended', queued_at = null where id = $1", [
				sessionId,
			]);
			expect((await asSession("GET", `/orchestrations/${id}`)).status).toBe(401);
			expect(
				(await asSession("POST", `/orchestrations/${id}/runs`, { params: { host: "h" } })).status,
			).toBe(401);
			expect(await platform()).toEqual([]);
		});

		it("用户被停用：会话令牌是 401（读、写都是）；启用之后恢复", async () => {
			const id = await scenario();
			await accounts.disable(editor);
			expect((await asSession("GET", `/orchestrations/${id}`)).status).toBe(401);
			expect(
				(await asSession("POST", `/orchestrations/${id}/runs`, { params: { host: "h" } })).status,
			).toBe(401);
			await db.query("update users set disabled_at = null where id = $1", [editor]);
			expect((await asSession("GET", `/orchestrations/${id}`)).status).toBe(200);
		});

		// 提交时才失败的约束（延迟触发器）：这时语句和平台记录都已经写完，失败的是提交——记录和运行、版本在同一个事务里，
		// 就一起没有；要是记录在提交之后另一个事务里写，运行、版本没有而记录还在。
		const failAtCommit = async (table: string) => {
			await db.query(`create function rv_fail() returns trigger language plpgsql as $$
				begin raise exception 'forced commit failure'; end $$`);
			await db.query(`create constraint trigger rv_fail_${table} after insert on ${table}
				deferrable initially deferred for each row execute function rv_fail()`);
		};

		it("记录和运行在同一个事务里：提交失败时运行和记录都没有，也没有推送", async () => {
			const id = await scenario();
			await failAtCommit("runs");
			const sse = await SseClient.open(cp, `/sessions/${sessionId}/events`, bearer(token));
			try {
				await sse.next("turn_started");
				const res = await asSession("POST", `/orchestrations/${id}/runs`, {
					params: { host: "h" },
				});
				expect(res.status).toBe(500);
				expect((await db.query("select count(*)::int as n from runs")).rows[0]).toEqual({ n: 0 });
				expect(await platform()).toEqual([]);
				await sse.expectNone(300);
			} finally {
				sse.close();
			}
		});

		type Request = [method: string, path: string, body: unknown];
		it.each([
			[
				"保存",
				(id: string): Request => [
					"POST",
					`/orchestrations/${id}/versions`,
					{ base_version: 1, document: document() },
				],
			],
			[
				"恢复",
				(id: string): Request => ["POST", `/orchestrations/${id}/versions/1/restore`, undefined],
			],
			["复制", (id: string): Request => ["POST", `/orchestrations/${id}/copy`, { name: "副本" }]],
		])("记录和版本在同一个事务里（%s）：提交失败时版本和记录都没有", async (_name, request) => {
			const id = await scenario();
			await failAtCommit("orchestration_versions");
			const [method, path, body] = request(id);
			const res = await asSession(method, path, body);
			expect(res.status).toBe(500);
			expect(
				(await db.query("select count(*)::int as n from orchestration_versions")).rows[0],
			).toEqual({ n: 1 });
			expect((await db.query("select count(*)::int as n from orchestrations")).rows[0]).toEqual({
				n: 1,
			});
			expect(await platform()).toEqual([]);
		});

		it("请求头里自带的会话引用不被采信：个人令牌、登录、项目令牌带 x-sfly-session 之类的头，运行和版本都不记会话；会话令牌带别的会话，记的仍是令牌的会话", async () => {
			const id = await scenario();
			const other = await accounts.session(editor, "default", { title: "别的会话" });
			const forged = {
				"x-sfly-session": sessionId,
				"x-sfly-session-id": sessionId,
				"x-sfly-client": `session/${sessionId}`,
			};
			const personal = await accounts.personalToken(editor);
			const project = await accounts.projectToken("default");
			const login = await accounts.login(editor);
			for (const credential of [bearer(personal), bearer(project), loginCookie(login)]) {
				await send(
					"POST",
					`/orchestrations/${id}/runs`,
					{ ...credential, ...forged },
					{
						params: { host: "h" },
					},
				);
				await send(
					"POST",
					`/orchestrations/${id}/versions`,
					{ ...credential, ...forged },
					{
						base_version: 1,
						document: document(),
					},
				);
			}
			expect(
				(await db.query("select count(*)::int as n from runs where session_id is not null"))
					.rows[0],
			).toEqual({ n: 0 });
			expect(
				(
					await db.query(
						"select count(*)::int as n from orchestration_versions where session_id is not null",
					)
				).rows[0],
			).toEqual({ n: 0 });
			expect(await platform()).toEqual([]);
			// 会话令牌带着别的会话的头：记的是令牌自己的会话。
			const created = await json<{ id: string }>(
				await send(
					"POST",
					`/orchestrations/${id}/runs`,
					{ ...bearer(token), "x-sfly-session": other },
					{ params: { host: "h" } },
				),
				201,
			);
			expect((await runSession(created.id))?.session_id).toBe(sessionId);
			expect(await platform(other)).toEqual([]);
		});

		it("会话没有在做的一轮：空闲的会话记在最近一轮的结局之后（轮次是最近一轮）；从没开始过一轮的记第 1 轮；已结束的是 401", async () => {
			const id = await scenario();
			// 空闲：第 2 轮已经结束。
			await db.query("update sessions set current_turn = 2, status = 'idle' where id = $1", [
				sessionId,
			]);
			await db.query(
				`insert into session_events (session_id, seq, type, payload, created_at)
				values ($1, 2, 'turn_started', '{"turn": 2}', now()), ($1, 3, 'turn_end', '{"turn": 2, "status": "done"}', now())`,
				[sessionId],
			);
			await json(
				await asSession("POST", `/orchestrations/${id}/runs`, { params: { host: "h" } }),
				201,
			);
			const idle = await platform();
			expect(idle).toHaveLength(1);
			expect(idle[0]?.payload).toMatchObject({ kind: "run", turn: 2 });
			expect(idle[0]?.seq).toBeGreaterThan(3);
			// 从没开始过一轮（current_turn 为 0）：第 1 轮。
			const fresh = await accounts.session(editor, "default", { title: "还没开始", turns: 0 });
			const freshToken = await accounts.sessionTokenIn(fresh, editor, "default", {
				scopes: ["read", "run", "edit", "session_build"],
			});
			await json(
				await send("POST", `/orchestrations/${id}/runs`, bearer(freshToken), {
					params: { host: "h" },
				}),
				201,
			);
			expect((await platform(fresh))[0]?.payload).toMatchObject({ kind: "run", turn: 1 });
		});

		it("删会话：被运行和版本引用的会话能删掉，引用置空，令牌随会话删除；运行和版本照样在", async () => {
			const id = await scenario();
			const run = await json<{ id: string }>(
				await asSession("POST", `/orchestrations/${id}/runs`, { params: { host: "h" } }),
				201,
			);
			await json(
				await asSession("POST", `/orchestrations/${id}/versions`, {
					base_version: 1,
					document: document(),
				}),
				201,
			);
			await cp.current.sessions.delete(sessionId);
			expect((await runSession(run.id))?.session_id).toBeNull();
			expect(await versionSession(id, 2)).toMatchObject({ session_id: null });
			expect(
				(await db.query("select count(*)::int as n from api_tokens where kind = 'session'"))
					.rows[0],
			).toEqual({ n: 0 });
			expect(
				(await db.query("select count(*)::int as n from sessions where id = $1", [sessionId]))
					.rows[0],
			).toEqual({ n: 0 });
		});

		it("推送失败只记日志：已提交的运行是 201、任务照样派发；记录在库里，下一条事件推送的时候补上（订阅的一方看到的序号连续），重连的读库补发", async () => {
			const id = await scenario();
			const sse = await SseClient.open(cp, `/sessions/${sessionId}/events`, bearer(token));
			try {
				await sse.next("turn_started");
				// 推送这一步抛异常（测试缝 afterCommit）：announce 吞掉、只记日志，已提交的运行照常 201，后面的派发照做。
				const store = cp.current.sessions as unknown as {
					deps: { afterCommit?: () => Promise<void> };
				};
				store.deps.afterCommit = async () => {
					throw new Error("推送坏了");
				};
				const created = await json<{ id: string }>(
					await asSession("POST", `/orchestrations/${id}/runs`, { params: { host: "h" } }),
					201,
				);
				expect((await platform())[0]?.payload).toMatchObject({ run_id: created.id });
				// 任务派发给了 Agent。
				await agent.nextAssign();
				// 没推出去的那一条：下一条事件推送的时候从库里补上，先收到平台记录、再收到后来的提示。
				store.deps.afterCommit = undefined;
				await cp.current.sessions.append(sessionId, {
					type: "notice",
					kind: "compaction",
					message: "后来的",
				});
				const pushed = await sse.next<{ kind: string; run_id: string }>("platform");
				expect(pushed.data).toMatchObject({ kind: "run", run_id: created.id });
				const later = await sse.next("notice");
				expect(Number(pushed.id)).toBeLessThan(Number(later.id));
			} finally {
				sse.close();
			}
		});
	});

	describe("会话令牌的写等锁的时候不拖住别的会话的事件", () => {
		let lockDb: pg.Client;
		beforeEach(async () => {
			lockDb = new pg.Client({ connectionString: cp.database.url });
			await lockDb.connect();
		});
		afterEach(async () => {
			await lockDb.query("rollback").catch(() => undefined);
			await lockDb.end();
		});

		const quickly = async (promise: Promise<unknown>, ms = 1500) =>
			Promise.race([
				promise.then(() => "done"),
				new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), ms)),
			]);

		it.each([
			["保存（等场景那一行的 FOR UPDATE）", "save"],
			["触发（等场景那一行的 FOR SHARE）", "trigger"],
		] as const)("%s：场景那一行被别的事务锁着时，这个会话和别的会话的助手事件都不被拖住", async (_name, kind) => {
			const id = await scenario();
			const other = await accounts.session(editor, "default", { title: "别的会话" });
			// 别的事务锁住场景那一行：会话令牌的写要等它。
			await lockDb.query("begin");
			await lockDb.query("select id from orchestrations where id = $1 for update", [id]);
			const write =
				kind === "save"
					? asSession("POST", `/orchestrations/${id}/versions`, {
							base_version: 1,
							document: document(),
						})
					: asSession("POST", `/orchestrations/${id}/runs`, { params: { host: "h" } });
			// 让写请求走到等锁那一步。
			await new Promise((resolve) => setTimeout(resolve, 300));
			const sameSession = cp.current.sessions.append(sessionId, {
				type: "notice",
				kind: "compaction",
				message: "同一个会话的事件",
			});
			const otherSession = cp.current.sessions.append(other, {
				type: "notice",
				kind: "compaction",
				message: "别的会话的事件",
			});
			expect(await quickly(sameSession), "同一个会话的助手事件").toBe("done");
			expect(await quickly(otherSession), "别的会话的助手事件").toBe("done");
			await lockDb.query("commit");
			expect((await write).status).toBe(201);
		});
	});
});
