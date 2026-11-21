// 访问检查经 HTTP（规格 #489）：真实控制面和数据库，凭据直接写库（签发在 #490–#492）。
// 带凭据的请求：失效的凭据 401；通过检查的写请求把用户 ID 和令牌的名称记进 #487 加的列；
// 平台管理员在自己不是成员的项目里的写操作留记录；HEAD、事件流走同一处检查；不带凭据的请求行为不变。
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_NOT_FOUND_MESSAGE } from "../src/auth/access-guard.js";
import { ApiClient } from "./support/api-client.js";
import { bearer, loginCookie, TestAccounts } from "./support/credentials.js";
import { FakeAgent } from "./support/fake-agent.js";
import { benchDocument, publishBench } from "./support/focus-items.js";
import { packageArchive, packageMetadata, publishPackage } from "./support/package-archive.js";
import { presetScenario } from "./support/presets.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const DOCUMENT = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

describe("带凭据的请求", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let db: pg.Client;
	let agent: FakeAgent;
	let editor: string;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		accounts = new TestAccounts(cp.database.url);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		editor = await accounts.user("xiaoming", { displayName: "小明" });
		await accounts.member("default", editor, "editor");
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await db.end();
		await accounts.close();
		await cp.close();
	});

	const call = (
		headers: Record<string, string>,
		method: string,
		path: string,
		body?: unknown,
	): Promise<Response> =>
		cp.fetch(path, {
			method,
			headers: {
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...headers,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const created = async (res: Response) => {
		expect(res.status, await res.clone().text()).toBeLessThan(300);
		return (await res.json()) as { id: string };
	};
	const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

	describe("身份来自凭据，不看昵称请求头", () => {
		it("写操作带令牌不需要昵称；不带凭据照旧要昵称（400 nickname_required）", async () => {
			const token = await accounts.personalToken(editor);
			const res = await call(bearer(token), "POST", "/orchestrations", { name: "场景" });
			expect(res.status).toBe(201);
			const anonymous = await call({}, "POST", "/orchestrations", { name: "场景" });
			expect(anonymous.status).toBe(400);
			expect(await anonymous.json()).toMatchObject({ error: { code: "nickname_required" } });
		});

		it("个人令牌：保存版本、触发、取消、运行预设、关注项记下用户 ID 和令牌的名称，显示名取用户的（昵称请求头不作数）", async () => {
			await publishBench(cp);
			const token = await accounts.personalToken(editor, { name: "ci-token" });
			const headers = {
				...bearer(token),
				"x-sfly-nickname": encodeURIComponent("冒充的人"),
				"x-sfly-client": "sfly-cli/0.5.0 agent/codex",
			};
			const scenario = (
				await created(await call(headers, "POST", "/orchestrations", { name: "场景" }))
			).id;

			// 保存版本
			const saved = await call(headers, "POST", `/orchestrations/${scenario}/versions`, {
				base_version: 0,
				document: DOCUMENT,
			});
			expect(saved.status, await saved.clone().text()).toBe(201);
			expect(
				await one(
					"select author, author_user_id, author_via, author_token from orchestration_versions",
				),
			).toEqual({
				author: "小明",
				author_user_id: editor,
				author_via: "codex",
				author_token: "ci-token",
			});

			// 触发和取消
			const run = (
				await created(
					await call(headers, "POST", `/orchestrations/${scenario}/runs`, { params: {} }),
				)
			).id;
			await agent.nextAssign();
			expect((await call(headers, "POST", `/runs/${run}/cancel`, {})).status).toBe(200);
			expect(
				await one(
					`select triggered_by, triggered_by_user_id, triggered_via, triggered_token,
						cancel_requested_by, cancel_requested_by_user_id, cancel_requested_via, cancel_requested_token
					from runs where id = $1`,
					[run],
				),
			).toEqual({
				triggered_by: "小明",
				triggered_by_user_id: editor,
				triggered_via: "codex",
				triggered_token: "ci-token",
				cancel_requested_by: "小明",
				cancel_requested_by_user_id: editor,
				cancel_requested_via: "codex",
				cancel_requested_token: "ci-token",
			});
			// 接口返回的「谁」是用户的显示名。
			const view = (await (await call(headers, "GET", `/runs/${run}`)).json()) as {
				triggered_by: string;
			};
			expect(view.triggered_by).toBe("小明");

			// 运行预设（要入口参数的场景）
			const withParams = (
				await created(await call(headers, "POST", "/orchestrations", { name: "有参数" }))
			).id;
			expect(
				(
					await call(headers, "POST", `/orchestrations/${withParams}/versions`, {
						base_version: 0,
						document: presetScenario(),
					})
				).status,
			).toBe(201);
			const preset = await call(headers, "POST", `/orchestrations/${withParams}/presets`, {
				name: "预设",
				params: [{ name: "host", value: "h1" }],
			});
			expect(preset.status, await preset.clone().text()).toBe(201);
			expect(await one("select updated_by, updated_by_user_id from run_presets")).toEqual({
				updated_by: "小明",
				updated_by_user_id: editor,
			});

			// 关注项最后一次修改
			const focus = await created(
				await call(headers, "POST", "/orchestrations", { name: "关注项场景" }),
			);
			await call(headers, "POST", `/orchestrations/${focus.id}/versions`, {
				base_version: 0,
				document: benchDocument(),
			});
			const patched = await call(headers, "PATCH", `/orchestrations/${focus.id}`, {
				focus_items: [{ node_id: "load", chart: "TPS" }],
			});
			expect(patched.status, await patched.clone().text()).toBe(200);
			expect(
				await one("select focus_edit from orchestrations where id = $1", [focus.id]),
			).toMatchObject({
				focus_edit: { by: "小明", by_user_id: editor },
			});
		});

		it("登录 Cookie：用户 ID 照记，令牌的名称为空；项目令牌：显示名是令牌的名称，没有用户", async () => {
			const cookie = await accounts.login(editor);
			const scenario = (
				await created(await call(loginCookie(cookie), "POST", "/orchestrations", { name: "场景" }))
			).id;
			await call(loginCookie(cookie), "POST", `/orchestrations/${scenario}/versions`, {
				base_version: 0,
				document: DOCUMENT,
			});
			expect(
				await one("select author, author_user_id, author_token from orchestration_versions"),
			).toEqual({
				author: "小明",
				author_user_id: editor,
				author_token: null,
			});

			const project = await accounts.projectToken("default", { name: "自动化" });
			const saved = await call(bearer(project), "POST", `/orchestrations/${scenario}/versions`, {
				base_version: 1,
				document: DOCUMENT,
			});
			expect(saved.status, await saved.clone().text()).toBe(201);
			expect(
				await one(
					"select author, author_user_id, author_token from orchestration_versions where number = 2",
				),
			).toEqual({ author: "自动化", author_user_id: null, author_token: "自动化" });
		});

		it("不带凭据：昵称请求头照旧，用户 ID 和令牌的名称为空", async () => {
			const api = new ApiClient(cp);
			const scenario = await api.orchestrationWith(DOCUMENT);
			const runId = await api.triggerOk(scenario);
			expect(
				await one(
					"select triggered_by, triggered_by_user_id, triggered_token from runs where id = $1",
					[runId],
				),
			).toEqual({ triggered_by: "tester", triggered_by_user_id: null, triggered_token: null });
		});

		it("发布节点包：带凭据的记下发布人（显示名、用户 ID、令牌的名称），不带凭据的没有", async () => {
			const token = await accounts.personalToken(editor, { name: "发布令牌" });
			const archive = (name: string) =>
				packageArchive(packageMetadata({ name, version: "1.0.0" })) as Uint8Array<ArrayBuffer>;
			const publish = (headers: Record<string, string>, name: string) =>
				cp.fetch("/packages", {
					method: "POST",
					headers: { "content-type": "application/octet-stream", ...headers },
					body: archive(name),
				});
			expect((await publish(bearer(token), "with-credential")).status).toBe(201);
			expect((await publish({}, "anonymous")).status).toBe(201);
			expect(
				await one(
					"select published_by, published_by_user_id, published_token from node_packages where name = 'with-credential'",
				),
			).toEqual({
				published_by: "小明",
				published_by_user_id: editor,
				published_token: "发布令牌",
			});
			expect(
				await one(
					"select published_by, published_by_user_id, published_token from node_packages where name = 'anonymous'",
				),
			).toEqual({ published_by: null, published_by_user_id: null, published_token: null });
		});
	});

	describe("拒绝的方式", () => {
		it("失效的凭据 401 unauthorized，带什么凭据都一样；不带凭据照旧放行", async () => {
			const res = await call(bearer("sfly_pat_unknown"), "GET", "/orchestrations");
			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
			expect((await call(loginCookie("nope"), "GET", "/orchestrations")).status).toBe(401);
			expect((await call({}, "GET", "/orchestrations")).status).toBe(200);
			// 不属于项目的接口不看凭据。
			expect((await call(bearer("sfly_pat_unknown"), "GET", "/health")).status).toBe(200);
		});

		it("没有这个范围 403，说明缺哪个范围；不是成员 404", async () => {
			const reader = await accounts.user("reader");
			await accounts.member("default", reader, "read_only");
			const stranger = await accounts.user("stranger");
			const readerToken = await accounts.personalToken(reader);
			const forbidden = await call(bearer(readerToken), "POST", "/orchestrations", { name: "x" });
			expect(forbidden.status).toBe(403);
			expect(await forbidden.json()).toMatchObject({
				error: { code: "forbidden", message: expect.stringContaining("编辑") },
			});
			const hidden = await call(
				bearer(await accounts.personalToken(stranger)),
				"GET",
				"/orchestrations",
			);
			expect(hidden.status).toBe(404);
			expect(await hidden.json()).toMatchObject({
				error: { code: "not_found", message: ACCESS_NOT_FOUND_MESSAGE },
			});
		});

		it("Fastify 为 GET 自动生成的 HEAD 路由走同一处检查", async () => {
			const stranger = await accounts.user("stranger");
			const scenario = (
				await created(
					await call(bearer(await accounts.personalToken(editor)), "POST", "/orchestrations", {
						name: "场景",
					}),
				)
			).id;
			const path = `/orchestrations/${scenario}`;
			expect(
				(await call(bearer(await accounts.personalToken(stranger)), "HEAD", path)).status,
			).toBe(404);
			expect((await call(bearer("sfly_pat_unknown"), "HEAD", path)).status).toBe(401);
			expect((await call(bearer(await accounts.personalToken(editor)), "HEAD", path)).status).toBe(
				200,
			);
		});

		it("事件流（SSE）也走同一处检查：拒绝的是 JSON 错误，不会打开流", async () => {
			const stranger = await accounts.user("stranger");
			const api = new ApiClient(cp);
			const run = await api.triggerOk(await api.orchestrationWith(DOCUMENT));
			const denied = await call(
				bearer(await accounts.personalToken(stranger)),
				"GET",
				`/runs/${run}/events`,
			);
			expect(denied.status).toBe(404);
			expect(denied.headers.get("content-type")).toContain("application/json");
			expect((await call(bearer("sfly_pat_unknown"), "GET", `/runs/${run}/events`)).status).toBe(
				401,
			);
			const controller = new AbortController();
			const allowed = await cp.fetch(`/runs/${run}/events`, {
				headers: bearer(await accounts.personalToken(editor)),
				signal: controller.signal,
			});
			expect(allowed.status).toBe(200);
			expect(allowed.headers.get("content-type")).toContain("text/event-stream");
			controller.abort();
		});
	});

	describe("平台管理员在自己不是成员的项目里的写操作留记录", () => {
		it("写记一条（谁、什么时候、哪个接口、作用在哪个资源上），读不记；他是成员的项目里的写不记", async () => {
			const admin = await accounts.user("root", { admin: true, displayName: "管理员" });
			const token = await accounts.personalToken(admin, { name: "运维" });
			const scenario = (
				await created(await call(bearer(token), "POST", "/orchestrations", { name: "场景" }))
			).id;
			expect((await call(bearer(token), "GET", `/orchestrations/${scenario}`)).status).toBe(200);
			expect(
				(
					await call(bearer(token), "POST", `/orchestrations/${scenario}/versions`, {
						base_version: 0,
						document: DOCUMENT,
					})
				).status,
			).toBe(201);

			const rows = (await db.query("select * from platform_admin_actions order by at, route")).rows;
			expect(
				rows.map((r) => [
					r.route,
					r.resource_kind,
					r.resource_id,
					r.token_name,
					r.user_id,
					r.project_id,
				]),
			).toEqual([
				["POST /orchestrations", "scenario", null, "运维", admin, "default"],
				["POST /orchestrations/:id/versions", "scenario", scenario, "运维", admin, "default"],
			]);
			expect(rows[0].at).toEqual(cp.clock.now());

			// 成为成员之后，他在这个项目里的写不再记。
			await accounts.member("default", admin, "editor");
			await call(bearer(token), "POST", "/orchestrations", { name: "又一个" });
			expect((await db.query("select 1 from platform_admin_actions")).rowCount).toBe(2);
			// 别的用户（编辑者）的写不记。
			await call(bearer(await accounts.personalToken(editor)), "POST", "/orchestrations", {
				name: "x",
			});
			expect((await db.query("select 1 from platform_admin_actions")).rowCount).toBe(2);
		});
	});
});

describe("共享令牌", () => {
	let cp: TestControlPlane;
	beforeAll(async () => {
		cp = await startTestControlPlane({ agentToken: "s3cret" });
	});
	afterAll(async () => {
		await cp.close();
	});

	it("带共享令牌的 HTTP 请求和不带凭据的走同一套：照旧放行，不看昵称以外的身份（库里没有的 Bearer 才是 401）", async () => {
		const api = new ApiClient(cp);
		const withShared = await cp.fetch("/orchestrations", { headers: bearer("s3cret") });
		expect(withShared.status).toBe(200);
		const wrong = await cp.fetch("/orchestrations", { headers: bearer("wrong") });
		expect(wrong.status).toBe(401);
		// 写操作：没有昵称仍是 400，共享令牌不是身份。
		const write = await cp.fetch("/orchestrations", {
			method: "POST",
			headers: { "content-type": "application/json", ...bearer("s3cret") },
			body: JSON.stringify({ name: "x" }),
		});
		expect(write.status).toBe(400);
		expect(await write.json()).toMatchObject({ error: { code: "nickname_required" } });
		expect(await api.createOrchestration("带昵称")).toBeTruthy();
	});
});
