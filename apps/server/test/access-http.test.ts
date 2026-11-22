// 访问检查经 HTTP（规格 #489）：真实控制面和数据库，凭据直接写库（签发在 #490–#492）。
// 带凭据的请求：失效的凭据 401；通过检查的写请求把用户 ID 和令牌的名称记进 #487 加的列；
// 平台管理员在自己不是成员的项目里的写操作留记录；HEAD、事件流走同一处检查；不带凭据的请求行为不变。
import { httpContract } from "@sfly/schema";
import { strToU8 } from "fflate";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_NOT_FOUND_MESSAGE } from "../src/auth/access-guard.js";
import { locatorOf, routeKey } from "../src/auth/access-rules.js";
import { ApiClient } from "./support/api-client.js";
import { bearer, loginCookie, TestAccounts } from "./support/credentials.js";
import { FakeAgent } from "./support/fake-agent.js";
import { benchDocument, publishBench } from "./support/focus-items.js";
import type { ManualClock } from "./support/manual-clock.js";
import { packageArchive, packageMetadata, publishPackage } from "./support/package-archive.js";
import { presetScenario } from "./support/presets.js";
import { seedTask } from "./support/seed-task.js";
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

		it("有过期时间、还没到期的令牌有效；到期之后 401", async () => {
			const token = await accounts.personalToken(editor, {
				expiresAt: new Date("2026-01-02T00:00:00Z"),
			});
			expect((await call(bearer(token), "GET", "/orchestrations")).status).toBe(200);
			(cp.clock as ManualClock).advance(2 * 86_400_000);
			expect((await call(bearer(token), "GET", "/orchestrations")).status).toBe(401);
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

	describe("发布到公共项目：POST /packages?project=public（#565）", () => {
		const archive = (name: string, version = "1.0.0") =>
			packageArchive(packageMetadata({ name, version }), {
				[`${name.replace(/-/g, "_")}-${version}-py3-none-any.whl`]: strToU8(`wheel ${name}`),
			}) as Uint8Array<ArrayBuffer>;
		const publish = (headers: Record<string, string>, name: string, query = "") =>
			cp.fetch(`/packages${query}`, {
				method: "POST",
				headers: { "content-type": "application/octet-stream", ...headers },
				body: archive(name),
			});
		const projectOf = async (name: string) =>
			(await db.query("select project_id from node_packages where name = $1", [name])).rows.map(
				(r) => r.project_id,
			);
		const error = async (res: Response) =>
			((await res.json()) as { error: { code: string; message: string } }).error;

		it("平台管理员发布到公共项目：201，版本在公共项目里，记下发布人，留平台管理员的写记录并回填状态码；sfly-std 出现在包索引里", async () => {
			const admin = await accounts.user("root", { displayName: "管理员", admin: true });
			const token = await accounts.personalToken(admin, { name: "发布令牌" });

			const res = await publish(bearer(token), "sfly-std", "?project=public");

			expect(res.status, await res.clone().text()).toBe(201);
			expect(await projectOf("sfly-std")).toEqual(["public"]);
			expect(
				await one(
					"select published_by, published_by_user_id, published_token from node_packages where name = 'sfly-std'",
				),
			).toEqual({
				published_by: "管理员",
				published_by_user_id: admin,
				published_token: "发布令牌",
			});
			await vi.waitFor(async () => {
				expect(
					await one(
						"select route, resource_kind, resource_id, project_id, user_id, token_name, status from platform_admin_actions",
					),
				).toEqual({
					route: "POST /packages",
					resource_kind: "package",
					resource_id: null,
					project_id: "public",
					user_id: admin,
					token_name: "发布令牌",
					status: 201,
				});
			});
			// 公共项目里的 sfly-std 在包索引里。
			const index = await (await cp.fetch("/simple/sfly-std/")).text();
			expect(index).toContain("sfly_std-1.0.0-py3-none-any.whl");
		});

		it("平台管理员不指明 project：照旧发布到默认项目（也留平台管理员的记录，和以前一样）", async () => {
			const admin = await accounts.user("root", { admin: true });
			const token = await accounts.personalToken(admin);

			expect((await publish(bearer(token), "in-default")).status).toBe(201);

			expect(await projectOf("in-default")).toEqual(["default"]);
			expect((await db.query("select project_id from platform_admin_actions")).rows).toEqual([
				{ project_id: "default" },
			]);
		});

		it("别的凭据指明 public 被拒绝：项目管理员、编辑者、项目令牌、不是平台管理员的令牌 403，不带凭据 401，信息写明原因；什么也没有发布", async () => {
			const boss = await accounts.user("boss");
			await accounts.member("default", boss, "project_admin");
			const projectToken = await accounts.projectToken("default", { name: "项目令牌" });
			const cases: [string, Record<string, string>, number][] = [
				["项目管理员", bearer(await accounts.personalToken(boss)), 403],
				["编辑者", bearer(await accounts.personalToken(editor)), 403],
				["项目令牌", bearer(projectToken), 403],
				["不带凭据", {}, 401],
			];
			for (const [name, headers, status] of cases) {
				const res = await publish(headers, "rejected", "?project=public");
				expect(res.status, name).toBe(status);
				expect((await error(res)).message, name).toContain("公共项目只有平台管理员能写");
			}
			expect(await projectOf("rejected")).toEqual([]);
			expect((await db.query("select 1 from platform_admin_actions")).rowCount).toBe(0);
		});

		it("指明 public 以外的项目：400，写明现在只能写 public；不指明时照旧", async () => {
			const admin = await accounts.user("root", { admin: true });
			const token = await accounts.personalToken(admin);
			for (const query of [
				"?project=default",
				"?project=alpha",
				"?project=",
				"?project=public&project=public",
			]) {
				for (const headers of [{}, bearer(token)]) {
					const res = await publish(headers, "rejected", query);
					expect(res.status, query).toBe(400);
					expect(await error(res), query).toMatchObject({
						code: "invalid_request",
						message: expect.stringContaining("现在只能写 public"),
					});
				}
			}
			expect(await projectOf("rejected")).toEqual([]);
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

		it("检查先于读请求体：失效的凭据上传超过上限的请求体是 401，不是 413、415，也不会先读请求体", async () => {
			const junk = new Uint8Array(2 * 1024 * 1024);
			const post = (headers: Record<string, string>) =>
				cp.fetch("/packages", { method: "POST", headers, body: junk });
			expect(
				(await post({ "content-type": "text/plain", ...bearer("sfly_pat_unknown") })).status,
			).toBe(401);
			expect(
				(await post({ "content-type": "application/octet-stream", ...bearer("sfly_pat_unknown") }))
					.status,
			).toBe(401);
			// 失效的 JSON 请求也一样：401 先于 400。
			const bad = await call(bearer("sfly_pat_unknown"), "POST", "/orchestrations", { wrong: 1 });
			expect(bad.status).toBe(401);
			// 对照：有效的凭据，请求体不对才是 413（超过请求体上限）/ 400。
			const token = await accounts.personalToken(editor);
			expect((await post({ "content-type": "text/plain", ...bearer(token) })).status).toBe(413);
			expect((await call(bearer(token), "POST", "/orchestrations", { wrong: 1 })).status).toBe(400);
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

			// 记录里没有「当时的成员角色」（不是成员）；响应的状态码是响应发出之后才回填的，等一下。
			await vi.waitFor(async () => {
				const filled = (
					await db.query(
						"select member_role, status from platform_admin_actions order by at, route",
					)
				).rows;
				expect(filled.map((r) => [r.member_role, r.status])).toEqual([
					[null, 201],
					[null, 201],
				]);
			});

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

describe("平台管理员的写记录：结果、成员角色和请求里的怪值", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let db: pg.Client;
	let token: string;
	let admin: string;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		accounts = new TestAccounts(cp.database.url);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		admin = await accounts.user("root", { admin: true });
		token = await accounts.personalToken(admin, { name: "运维" });
	});
	afterEach(async () => {
		await db.end();
		await accounts.close();
		await cp.close();
	});

	const call = (method: string, path: string, body?: unknown) =>
		cp.fetch(path, {
			method,
			headers: {
				...bearer(token),
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const records = async () =>
		(
			await db.query(
				"select route, resource_id, status, member_role from platform_admin_actions order by at, id",
			)
		).rows as {
			route: string;
			resource_id: string | null;
			status: number | null;
			member_role: string | null;
		}[];

	it("路径参数含 NUL：和不带凭据一样是 404，不是 500，也不留记录（NUL 存不进 PostgreSQL 的文本）", async () => {
		for (const path of ["/feishu-bots/%00x", "/feishu-bots/a%00", "/feishu-bots/%00"]) {
			const withToken = await call("DELETE", path);
			const anonymous = await cp.fetch(path, { method: "DELETE" });
			expect(withToken.status, path).toBe(404);
			expect(withToken.status, path).toBe(anonymous.status);
		}
		expect(await records()).toEqual([]);
	});

	it("别的怪值能走到访问检查：控制字符、emoji、换行、接近上限的长度都照常记下，不是 500", async () => {
		// 路径参数的长度上限是 100 个字符（Fastify 的 maxParamLength），再长的在进访问检查之前就被 Fastify 拒绝。
		const names = ["a\u0001b", "机器人😀", "line\nbreak", "n".repeat(100)];
		for (const name of names) {
			const res = await call("DELETE", `/feishu-bots/${encodeURIComponent(name)}`);
			expect(res.status, JSON.stringify(name)).toBe(404);
		}
		await vi.waitFor(async () => {
			// 手动时钟没动，记录的时间相同：不看顺序。
			expect((await records()).map((r) => r.resource_id).sort()).toEqual([...names].sort());
		});
	});

	it("非法的 UTF-8（%FF）和超长的参数在进访问检查之前就被 Fastify 拒绝（400、414）：这条守的是「不会是 500」，测到的是框架", async () => {
		for (const path of ["/feishu-bots/%FF", `/feishu-bots/${"n".repeat(300)}`]) {
			const res = await call("DELETE", path);
			expect(res.status, path).toBeGreaterThanOrEqual(400);
			expect(res.status, path).toBeLessThan(500);
		}
		expect(await records()).toEqual([]);
	});

	it("记录带着响应的状态码：成功的、请求不合格的（400）、找不到的（404）各一条，先记后回填", async () => {
		const ok = await call("POST", "/feishu-bots", {
			name: "机器人",
			webhook_url: "https://open.feishu.cn/hook/abc",
		});
		expect(ok.status).toBe(201);
		// 记录按时间排序：每个请求之间推进一下手动时钟。
		(cp.clock as ManualClock).advance(1000);
		const invalid = await call("POST", "/feishu-bots", { name: "", webhook_url: "不是地址" });
		expect(invalid.status).toBe(400);
		(cp.clock as ManualClock).advance(1000);
		const missing = await call("DELETE", "/feishu-bots/不存在");
		expect(missing.status).toBe(404);
		// onResponse 在响应发出之后才回填，等一下。
		await vi.waitFor(async () => {
			expect((await records()).map((r) => r.status)).toEqual([201, 400, 404]);
		});
		expect((await records()).map((r) => [r.route, r.resource_id])).toEqual([
			["POST /feishu-bots", null],
			["POST /feishu-bots", null],
			["DELETE /feishu-bots/:name", "不存在"],
		]);
	});

	it("他是成员、但这次写靠的是管理员的权限：记录里有他当时的角色；不是成员为空", async () => {
		await call("POST", "/feishu-bots", {
			name: "甲",
			webhook_url: "https://open.feishu.cn/hook/a",
		});
		(cp.clock as ManualClock).advance(1000);
		await accounts.member("default", admin, "read_only");
		await call("POST", "/orchestrations", { name: "场景" });
		await vi.waitFor(async () => {
			expect((await records()).map((r) => [r.route, r.member_role])).toEqual([
				["POST /feishu-bots", null],
				["POST /orchestrations", "read_only"],
			]);
		});
	});
});

describe("路径里的 ID 不是 UUID：每种凭据都得到 404 或 403，不会是 500", () => {
	// 访问检查里每一处拿路径参数去查 uuid 列的地方都要先判断格式：PostgreSQL 对不是 UUID 的字符串报
	// `invalid input syntax for type uuid`，那会变成 500。用真库、对契约里每个按 ID 定位的接口、每种凭据都请求一遍。
	let cp: TestControlPlane;
	let credentials: { name: string; headers: Record<string, string> }[];

	beforeAll(async () => {
		cp = await startTestControlPlane({ agentToken: "s3cret" });
		const accounts = new TestAccounts(cp.database.url);
		try {
			const editor = await accounts.user("editor1");
			await accounts.member("default", editor, "editor");
			const admin = await accounts.user("root", { admin: true });
			credentials = [
				{ name: "不带凭据", headers: {} },
				{ name: "共享令牌", headers: bearer("s3cret") },
				{ name: "个人令牌（编辑者）", headers: bearer(await accounts.personalToken(editor)) },
				{ name: "个人令牌（平台管理员）", headers: bearer(await accounts.personalToken(admin)) },
				{ name: "项目令牌", headers: bearer(await accounts.projectToken("default")) },
				{
					name: "会话令牌",
					headers: bearer(await accounts.sessionToken(editor, "default")),
				},
				{
					name: "登录 Cookie",
					headers: loginCookie(await accounts.login(editor)),
				},
				{
					name: "Agent 凭据",
					headers: bearer(await accounts.agentCredential("default", "agent-a")),
				},
				{
					name: "开发 Agent 的凭据",
					headers: bearer(
						await accounts.agentCredential("default", "dev-editor1-laptop", { userId: editor }),
					),
				},
				{
					name: "任务凭据",
					headers: bearer(await accounts.taskCredential("default", crypto.randomUUID())),
				},
			];
		} finally {
			await accounts.close();
		}
	});
	afterAll(async () => {
		await cp.close();
	});

	const byId = httpContract.filter((def) => {
		const locator = locatorOf(def);
		return locator?.from === "scenario" || locator?.from === "run" || locator?.from === "task";
	});

	it("契约里有按 ID 定位（经场景、运行、任务）的接口可测", () => {
		expect(byId.length).toBeGreaterThan(30);
	});

	for (const def of byId) {
		it(`${routeKey(def)}：ID 写成 not-a-uuid、全 0 的 UUID、带 SQL 的字符串，每种凭据都不是 500`, async () => {
			const locator = locatorOf(def);
			const idParam = locator && "param" in locator ? locator.param : "id";
			for (const id of [
				"not-a-uuid",
				"00000000-0000-0000-0000-000000000000",
				"1' or '1'='1",
				"12345",
			]) {
				const path = def.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)|\*$/g, (_all, name?: string) =>
					encodeURIComponent(name === idParam ? id : name === undefined ? "a.txt" : "x"),
				);
				for (const credential of credentials) {
					const res = await cp.fetch(path, {
						method: def.method,
						headers: { ...credential.headers, "sec-fetch-site": "same-origin" },
					});
					expect(
						res.status,
						`${def.method} ${path}（${credential.name}）：${await res.clone().text()}`,
					).toBeLessThan(500);
				}
			}
		}, 30_000);
	}
});

describe("开发 Agent 的凭据随用户停用失效（真库）", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	beforeAll(async () => {
		cp = await startTestControlPlane();
		accounts = new TestAccounts(cp.database.url);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
	});
	afterAll(async () => {
		await accounts.close();
		await cp.close();
	});

	const archive = (headers: Record<string, string>) =>
		cp.fetch("/packages/stub/versions/1.0.0/archive", { headers });

	it("所属用户启用时能下载节点包归档；停用之后 401；吊销过的、按台签发的（没有用户）各按各的", async () => {
		const owner = await accounts.user("owner1");
		await accounts.member("default", owner, "editor");
		const dev = bearer(
			await accounts.agentCredential("default", "dev-owner1-laptop", { userId: owner }),
		);
		const perAgent = bearer(await accounts.agentCredential("default", "agent-a"));
		expect((await archive(dev)).status).toBe(200);
		expect((await archive(perAgent)).status).toBe(200);

		await accounts.disable(owner);
		const stopped = await archive(dev);
		expect(stopped.status).toBe(401);
		expect(await stopped.json()).toMatchObject({ error: { code: "unauthorized" } });
		// 按台签发的凭据没有用户，不受影响。
		expect((await archive(perAgent)).status).toBe(200);
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

	it("配了共享令牌时，Agent 凭据上传产物照样通过：访问检查已经核对过凭据，处理函数不再拿共享令牌比；共享令牌和不带凭据的上传仍按共享令牌", async () => {
		const accounts = new TestAccounts(cp.database.url);
		try {
			const { task } = await seedTask(cp, { agent: "agent-x", status: "running" });
			const upload = (headers: Record<string, string>, name: string) =>
				cp.fetch(`/tasks/${task}/artifacts/${name}`, {
					method: "PUT",
					headers: { "content-type": "application/octet-stream", ...headers },
					body: "x",
				});
			const credential = await accounts.agentCredential("default", "agent-x");
			expect((await upload(bearer(credential), "own.txt")).status).toBe(201);
			expect((await upload(bearer("s3cret"), "shared.txt")).status).toBe(201);
			expect((await upload({}, "anonymous.txt")).status).toBe(401);
			// 别的 Agent 的凭据：访问检查拒绝（任务不是派给它的）。
			const other = await accounts.agentCredential("default", "agent-y");
			expect((await upload(bearer(other), "other.txt")).status).toBe(404);
		} finally {
			await accounts.close();
		}
	});
});
