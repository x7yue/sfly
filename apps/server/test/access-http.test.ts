// 访问检查经 HTTP（规格 #489）：真实控制面和数据库，凭据直接写库（签发在 #490–#492）。
// 带凭据的请求：失效的凭据 401；通过检查的写请求把用户 ID 和令牌的名称记进 #487 加的列；
// 平台管理员在自己不是成员的项目里的写操作留记录；HEAD、事件流走同一处检查；不带凭据的请求行为不变。
import { httpContract } from "@sfly/schema";
import { strToU8 } from "fflate";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_NOT_FOUND_MESSAGE } from "../src/auth/access-guard.js";
import { locatorOf, routeKey } from "../src/auth/access-rules.js";
import { publicPackageLockKey } from "../src/packages/package-repository.js";
import { ApiClient } from "./support/api-client.js";
import { actAs, bearer, loginCookie, TestAccounts } from "./support/credentials.js";
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
		cp = await startTestControlPlane({ defaultCredentials: false });
		accounts = new TestAccounts(cp.database.url);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		editor = await accounts.user("xiaoming", { displayName: "小明" });
		await accounts.member("default", editor, "editor");
		await publishPackage(cp.asTester(), "stub", "1.0.0", { echo: ["v"] });
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
			await publishBench(cp.asTester());
			const token = await accounts.personalToken(editor, { name: "ci-token" });
			const headers = {
				...bearer(token),
				...actAs("冒充的人"),
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
				cp.fetch("/projects/default/packages", {
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

	describe("发布到公共项目：POST /projects/public/packages（#565、#488）", () => {
		const archive = (name: string, version = "1.0.0") =>
			packageArchive(packageMetadata({ name, version }), {
				[`${name.replace(/-/g, "_")}-${version}-py3-none-any.whl`]: strToU8(`wheel ${name}`),
			}) as Uint8Array<ArrayBuffer>;
		const publish = (
			headers: Record<string, string>,
			name: string,
			project = "default",
			version = "1.0.0",
		) =>
			cp.fetch(`/projects/${project}/packages`, {
				method: "POST",
				headers: { "content-type": "application/octet-stream", ...headers },
				body: archive(name, version),
			});
		const projectOf = async (name: string) =>
			(await db.query("select project_id from node_packages where name = $1", [name])).rows.map(
				(r) => r.project_id,
			);
		const versionsOf = async (name: string) =>
			(
				await db.query("select version from node_packages where name = $1 order by version", [name])
			).rows.map((r) => r.version);
		const error = async (res: Response) =>
			((await res.json()) as { error: { code: string; message: string } }).error;

		it("平台管理员发布到公共项目：201，版本在公共项目里，记下发布人，留平台管理员的写记录并回填状态码；sfly-std 出现在包索引里", async () => {
			const admin = await accounts.user("root", { displayName: "管理员", admin: true });
			const token = await accounts.personalToken(admin, { name: "发布令牌" });

			const res = await publish(bearer(token), "sfly-std", "public");

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
					route: "POST /projects/:project/packages",
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

		it("平台管理员发布到默认项目：在默认项目里（也留平台管理员的记录，和以前一样）", async () => {
			const admin = await accounts.user("root", { admin: true });
			const token = await accounts.personalToken(admin);

			expect((await publish(bearer(token), "in-default")).status).toBe(201);

			expect(await projectOf("in-default")).toEqual(["default"]);
			expect((await db.query("select project_id from platform_admin_actions")).rows).toEqual([
				{ project_id: "default" },
			]);
		});

		it("公共项目里和已有版本规范化（PEP 440）之后相同的版本不能再发布：409，写明已有的是哪个；一模一样的版本也 409；不同的版本照常；默认项目不受这条限制", async () => {
			const admin = await accounts.user("root", { admin: true });
			const token = bearer(await accounts.personalToken(admin));
			expect((await publish(token, "sfly-std", "public", "0.9.0")).status).toBe(201);

			for (const same of ["0.9", "0.9.0.0", "00.9.0"]) {
				const res = await publish(token, "sfly-std", "public", same);
				expect(res.status, same).toBe(409);
				const { code, message } = await error(res);
				expect(code, same).toBe("conflict");
				expect(message, same).toContain(`sfly-std@${same}`);
				expect(message, same).toContain("公共项目里已有的 sfly-std@0.9.0");
			}
			// 一模一样的版本：照旧是「已存在」。
			const identical = await publish(token, "sfly-std", "public", "0.9.0");
			expect(identical.status).toBe(409);
			expect((await error(identical)).message).toContain("已存在");
			// 不同的版本、别的名字照常发布。
			expect((await publish(token, "sfly-std", "public", "0.9.1")).status).toBe(201);
			expect((await publish(token, "other", "public", "0.9")).status).toBe(201);
			expect(await versionsOf("sfly-std")).toEqual(["0.9.0", "0.9.1"]);
			// 默认项目里发布不受这条限制（索引只列公共项目里的包）。
			expect((await publish(token, "sfly-std", "default", "0.9")).status).toBe(201);
			expect((await projectOf("sfly-std")).sort()).toEqual(["default", "public", "public"]);
		});

		it("同时发布规范化之后相同的两个版本：只有一个成功，另一个 409（咨询锁，不会两个都通过检查）", async () => {
			const admin = await accounts.user("root", { admin: true });
			const token = bearer(await accounts.personalToken(admin));

			const results = await Promise.all(
				["1.5", "1.5.0", "1.5.0.0", "01.5"].map((version) =>
					publish(token, "racing", "public", version),
				),
			);

			expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
			expect(await versionsOf("racing")).toHaveLength(1);
		});

		it("默认项目里不做规范化比较：先发 x@1.0 再发 x@1.0.0 都是 201（规则只对公共项目）", async () => {
			const admin = await accounts.user("root", { admin: true });
			const token = bearer(await accounts.personalToken(admin));

			const first = await publish(token, "plain", "default", "1.0");
			const second = await publish(token, "plain", "default", "1.0.0");
			const third = await publish(token, "plain", "default", "1.0.0.0");

			expect([first.status, second.status, third.status]).toEqual([201, 201, 201]);
			expect(await versionsOf("plain")).toEqual(["1.0", "1.0.0", "1.0.0.0"]);
		});

		it("同名同版本已经在另一个项目里：409 的说明写明在哪个项目（公共或默认），平台管理员往公共项目发时说明它不在包索引里", async () => {
			const admin = await accounts.user("root", { admin: true });
			const token = bearer(await accounts.personalToken(admin));

			// 默认项目里先有了 x@2.0，平台管理员再往公共项目发同一个版本。
			expect((await publish(token, "elsewhere", "default", "2.0")).status).toBe(201);
			const toPublic = await publish(token, "elsewhere", "public", "2.0");
			expect(toPublic.status).toBe(409);
			expect((await error(toPublic)).message).toBe(
				"节点包 elsewhere@2.0 已存在（在默认项目里），不能覆盖已发布的版本，它不在包索引里；换一个版本号发布到公共项目",
			);
			expect(await projectOf("elsewhere")).toEqual(["default"]);

			// 反过来：公共项目里先有，默认项目再发同一个版本。
			expect((await publish(token, "shared-first", "public", "3.0")).status).toBe(201);
			const toDefault = await publish(token, "shared-first", "default", "3.0");
			expect(toDefault.status).toBe(409);
			expect((await error(toDefault)).message).toBe(
				"节点包 shared-first@3.0 已存在（在公共项目里），不能覆盖已发布的版本",
			);

			// 同一个项目里重发：说明和以前一样，不多说项目。
			const again = await publish(token, "shared-first", "public", "3.0");
			expect((await error(again)).message).toBe(
				"节点包 shared-first@3.0 已存在，不能覆盖已发布的版本",
			);
		});

		it("同名同版本在一个无关的项目里：409 的说明不写那个项目的名字，也不说它在哪里（只有公共和默认两个项目会写明）", async () => {
			const admin = await accounts.user("root", { admin: true });
			const token = bearer(await accounts.personalToken(admin));
			await accounts.project("secret-team");
			await db.query(
				`insert into node_packages (name, version, project_id, metadata, file_path, sha256, size, published_at)
				 values ('hidden', '4.0', 'secret-team', '{}'::jsonb, 'packages/hidden/4.0.sflypkg', 'x', 1, now())`,
			);

			for (const [where, headers, query] of [
				["往公共项目发", token, "public"],
				["往默认项目发", token, "default"],
			] as const) {
				const res = await publish(headers, "hidden", query, "4.0");
				expect(res.status, where).toBe(409);
				const { message } = await error(res);
				expect(message, where).toBe("节点包 hidden@4.0 已存在，不能覆盖已发布的版本");
				expect(message, where).not.toContain("secret-team");
			}
			expect(await projectOf("hidden")).toEqual(["secret-team"]);
		});

		it("发布时先取这个名字的咨询锁：另一条连接正在发布同名的包时，等它提交了再比较，看到它写的版本（没有锁两个都会通过检查）", async () => {
			const admin = await accounts.user("root", { admin: true });
			const token = bearer(await accounts.personalToken(admin));
			// 另一条连接：开事务、拿同一把锁、写下 1.5、先不提交——相当于一次正在进行的发布。
			const holder = new pg.Client({ connectionString: cp.database.url });
			await holder.connect();
			try {
				await holder.query("begin");
				await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
					publicPackageLockKey("locked"),
				]);
				await holder.query(
					`insert into node_packages (name, version, project_id, metadata, file_path, sha256, size, published_at)
					 values ('locked', '1.5', 'public', '{}'::jsonb, 'packages/locked/1.5.sflypkg', 'x', 1, now())`,
				);

				const racing = publish(token, "locked", "public", "1.5.0");
				const early = await Promise.race([
					racing.then(() => "done"),
					new Promise((resolve) => setTimeout(() => resolve("waiting"), 500)),
				]);
				expect(early, "拿不到锁的发布要等着").toBe("waiting");

				await holder.query("commit");
				const res = await racing;
				expect(res.status, await res.clone().text()).toBe(409);
				expect((await error(res)).message).toContain("locked@1.5");
			} finally {
				await holder.query("rollback").catch(() => undefined);
				await holder.end();
			}
			expect(await versionsOf("locked")).toEqual(["1.5"]);
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
				const res = await publish(headers, "rejected", "public");
				expect(res.status, name).toBe(status);
				expect((await error(res)).message, name).toContain("公共项目只有平台管理员能写");
			}
			expect(await projectOf("rejected")).toEqual([]);
			expect((await db.query("select 1 from platform_admin_actions")).rowCount).toBe(0);
		});

		it("路径里的项目不存在：404，有没有凭据、是谁都一样；什么也没有发布", async () => {
			const admin = await accounts.user("root", { admin: true });
			const token = await accounts.personalToken(admin);
			for (const project of ["alpha", "Not-A-Project"]) {
				for (const headers of [{}, bearer(token)]) {
					const res = await publish(headers, "rejected", project);
					expect(res.status, project).toBe(404);
					expect(await error(res), project).toMatchObject({ code: "not_found" });
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
				cp.fetch("/projects/default/packages", { method: "POST", headers, body: junk });
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
			const api = new ApiClient(cp.asTester());
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
		cp = await startTestControlPlane({ defaultCredentials: false });
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
		// 路径参数的长度上限是 128 个码元（解码之后，Fastify 的 maxParamLength，`src/http/api.ts` 的 `MAX_PATH_PARAM_LENGTH`），
		// 再长的在进访问检查之前就被 Fastify 拒绝。
		const names = ["a\u0001b", "机器人😀", "line\nbreak", "n".repeat(128)];
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
		for (const path of ["/feishu-bots/%FF", `/feishu-bots/${"n".repeat(129)}`]) {
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
		cp = await startTestControlPlane({ defaultCredentials: false, agentToken: "s3cret" });
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
		cp = await startTestControlPlane({ defaultCredentials: false });
		accounts = new TestAccounts(cp.database.url);
		await publishPackage(cp.asTester(), "stub", "1.0.0", { echo: ["v"] });
	});
	afterAll(async () => {
		await accounts.close();
		await cp.close();
	});

	const archive = (headers: Record<string, string>) =>
		cp.fetch("/projects/default/packages/stub/versions/1.0.0/archive", { headers });

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
		cp = await startTestControlPlane({ defaultCredentials: false, agentToken: "s3cret" });
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
			const { task } = await seedTask(cp.asTester(), { agent: "agent-x", status: "running" });
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
