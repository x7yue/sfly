// 本地账号与登录经 HTTP（ADR 0029「认证的几处细节」，规格 #490）：真实控制面和数据库。
// 第一个管理员（初始化码、环境变量）、登录与登出、改密码、平台管理员管理账号、停用立即生效、登录名的规则、
// 登录 Cookie 的属性、登录限速。跨站检查和跨项目在 accounts-cross-site.test.ts。
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PLATFORM_ADMIN_SCOPES } from "../src/auth/scopes.js";
import { SETUP_CODE_FILE } from "../src/auth/setup-code.js";
import { actAs, loginCookie, TestAccounts } from "./support/credentials.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { seedTask } from "./support/seed-task.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const ADMIN = { loginName: "root", password: "admin-password-1", displayName: "管理员" };
const JSON_HEADERS = { "content-type": "application/json" };
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

/** 登录，返回 Cookie 的值和整条 Set-Cookie。 */
async function login(cp: TestControlPlane, loginName: string, password: string) {
	const res = await cp.fetch("/auth/login", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ login_name: loginName, password }),
	});
	const setCookie = res.headers.get("set-cookie") ?? "";
	const value = /sfly_login=([^;]*)/.exec(setCookie)?.[1] ?? "";
	return { res, setCookie, cookie: value };
}

const api =
	(cp: TestControlPlane, cookie: string) => (method: string, path: string, body?: unknown) =>
		cp.fetch(path, {
			method,
			headers: {
				...loginCookie(cookie),
				...(body === undefined ? {} : JSON_HEADERS),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});

describe("第一个管理员", () => {
	let cp: TestControlPlane | undefined;
	afterEach(async () => {
		vi.restoreAllMocks();
		await cp?.close();
		cp = undefined;
	});

	const setup = (c: TestControlPlane, code: string, loginName = "boss") =>
		c.fetch("/auth/setup", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({
				setup_code: code,
				login_name: loginName,
				display_name: "第一个管理员",
				password: "first-password-1",
			}),
		});
	const codeFile = (c: TestControlPlane) => join(c.dataDir, SETUP_CODE_FILE);

	it("空库启动：日志里打印一次性的初始化码，同一个码写在数据目录里只有属主可读的文件里", async () => {
		const printed: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			printed.push(args.join(" "));
		});
		cp = await startTestControlPlane({ defaultCredentials: false, logger: true });
		const code = (await readFile(codeFile(cp), "utf8")).trim();
		expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
		expect(printed.join("\n")).toContain(code);
		// 只有属主可读写（0600）。
		expect((await stat(codeFile(cp))).mode & 0o777).toBe(0o600);
		const status = await cp.fetch("/auth/status");
		expect(await status.json()).toMatchObject({ setup_required: true });
	});

	it("用初始化码建出管理员并登录；码用过即失效，文件删掉，再用同一个码是 409", async () => {
		cp = await startTestControlPlane({ defaultCredentials: false });
		const code = (await readFile(codeFile(cp), "utf8")).trim();
		const created = await setup(cp, code);
		expect(created.status).toBe(201);
		expect(await created.json()).toMatchObject({
			login_name: "boss",
			display_name: "第一个管理员",
			is_platform_admin: true,
			// 初始化响应也带范围：第一个管理员是平台管理员，有项目管理员的全部范围（控制台据此显示管理类的操作）。
			scopes: [...PLATFORM_ADMIN_SCOPES],
		});
		const cookie = /sfly_login=([^;]+)/.exec(created.headers.get("set-cookie") ?? "")?.[1] ?? "";
		expect(cookie).not.toBe("");
		// 建出来就是登录着的：能读自己，是平台管理员。
		const me = await api(cp, cookie)("GET", "/auth/me");
		expect(me.status).toBe(200);
		expect(await me.json()).toMatchObject({ login_name: "boss", is_platform_admin: true });
		// 码失效：文件没了，再用同一个码、再用任何码都是 409（已经有用户了）。
		expect(existsSync(codeFile(cp))).toBe(false);
		expect((await setup(cp, code, "second")).status).toBe(409);
		expect(await (await cp.fetch("/auth/status")).json()).toMatchObject({ setup_required: false });
		// 他在默认项目里是项目管理员：他在默认项目里的写不算「管理员在不是成员的项目里的写」。
		const db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		try {
			const role = await db.query(
				"select role from project_members m join users u on u.id = m.user_id where u.login_name = 'boss'",
			);
			expect(role.rows).toEqual([{ role: "project_admin" }]);
		} finally {
			await db.end();
		}
	});

	it("初始化页的显示名和建用户、改显示名同一个检查：带零宽空格、标签字符、位置不对的零宽连接符的 400，不建用户、不用掉初始化码；合格的照常", async () => {
		cp = await startTestControlPlane({ defaultCredentials: false });
		const code = (await readFile(codeFile(cp), "utf8")).trim();
		const withName = (display_name: string) =>
			cp?.fetch("/auth/setup", {
				method: "POST",
				headers: JSON_HEADERS,
				body: JSON.stringify({
					setup_code: code,
					login_name: "boss",
					display_name,
					password: "first-password-1",
				}),
			}) as Promise<Response>;
		for (const bad of ["老\u200b板", "老\u202e板", "老\u{e0067}板", "\u200d老板", "老\n板"]) {
			const res = await withName(bad);
			expect(res.status, JSON.stringify(bad)).toBe(400);
		}
		const detail = await (await withName("老\u200b板")).text();
		expect(detail).toContain("显示名的第 2 个字符是 U+200B");
		// 没有建出用户，码还能用。
		expect(await (await cp.fetch("/auth/status")).json()).toMatchObject({ setup_required: true });
		expect(existsSync(codeFile(cp))).toBe(true);
		const ok = await withName("👩\u200d💻 程序员");
		expect(ok.status).toBe(201);
	});

	it("码不对是 403 invalid_setup_code，不建用户；连着猜错会被限速（429）", async () => {
		cp = await startTestControlPlane({ defaultCredentials: false });
		const wrong = await setup(cp, "AAAA-BBBB-CCCC-DDDD-EEEE");
		expect(wrong.status).toBe(403);
		expect(await wrong.json()).toMatchObject({ error: { code: "invalid_setup_code" } });
		expect(await (await cp.fetch("/auth/status")).json()).toMatchObject({ setup_required: true });
		let limited = 0;
		for (let i = 0; i < 40; i++) {
			if ((await setup(cp, `WRONG-${i}`)).status === 429) limited++;
		}
		expect(limited).toBeGreaterThan(0);
	});

	it("重启后换一个新码（旧码作废），直到有了用户；有了用户之后重启不再生成", async () => {
		cp = await startTestControlPlane({ defaultCredentials: false });
		const first = (await readFile(codeFile(cp), "utf8")).trim();
		await cp.restart();
		const second = (await readFile(codeFile(cp), "utf8")).trim();
		expect(second).not.toBe(first);
		expect((await setup(cp, first)).status).toBe(403);
		expect((await setup(cp, second)).status).toBe(201);
		await cp.restart();
		expect(existsSync(codeFile(cp))).toBe(false);
		expect(await (await cp.fetch("/auth/status")).json()).toMatchObject({ setup_required: false });
	});

	it("并发的两次初始化只有一次成功，只建出一个用户", async () => {
		cp = await startTestControlPlane({ defaultCredentials: false });
		const code = (await readFile(codeFile(cp), "utf8")).trim();
		const results = await Promise.all([setup(cp, code, "a_one"), setup(cp, code, "b_two")]);
		expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
		const db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		try {
			expect((await db.query("select 1 from users")).rowCount).toBe(1);
		} finally {
			await db.end();
		}
	});

	it("环境变量给出初始管理员：没有用户时建出来（不生成初始化码），用它的账号密码能登录", async () => {
		cp = await startTestControlPlane({ defaultCredentials: false, initialAdmin: ADMIN });
		expect(existsSync(codeFile(cp))).toBe(false);
		expect(await (await cp.fetch("/auth/status")).json()).toMatchObject({ setup_required: false });
		const { res, cookie } = await login(cp, ADMIN.loginName, ADMIN.password);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			login_name: "root",
			display_name: "管理员",
			is_platform_admin: true,
		});
		expect(cookie).not.toBe("");
	});
});

describe("登录、登出、改密码", () => {
	let cp: TestControlPlane;
	beforeAll(async () => {
		cp = await startTestControlPlane({ defaultCredentials: false, initialAdmin: ADMIN });
	});
	afterAll(async () => {
		await cp.close();
	});

	it("登录：Cookie 是 HttpOnly、SameSite=Lax、Path=/，空闲期限当作 Max-Age；http 下没有 Secure，反向代理说是 https 就加 Secure", async () => {
		const { res, setCookie } = await login(cp, "root", ADMIN.password);
		expect(res.status).toBe(200);
		expect(setCookie).toMatch(/^sfly_login=[A-Za-z0-9_-]{40,};/);
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Lax");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).toContain(`Max-Age=${12 * 3600}`);
		expect(setCookie).not.toContain("Secure");
		const secure = await cp.fetch("/auth/login", {
			method: "POST",
			headers: { ...JSON_HEADERS, "x-forwarded-proto": "https" },
			body: JSON.stringify({ login_name: "root", password: ADMIN.password }),
		});
		expect(secure.headers.get("set-cookie")).toContain("Secure");
	});

	it("库里只存 Cookie 的哈希，不存原值；登录响应里没有密码哈希", async () => {
		const { res, cookie } = await login(cp, "root", ADMIN.password);
		const text = await res.text();
		expect(text).not.toContain("scrypt");
		expect(text).not.toContain("password");
		const db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		try {
			const rows = await db.query("select cookie_hash from logins");
			expect(rows.rows.length).toBeGreaterThan(0);
			for (const row of rows.rows) expect(row.cookie_hash).not.toBe(cookie);
			const users = await db.query("select password_hash from users where login_name = 'root'");
			expect(users.rows[0].password_hash).toMatch(/^scrypt\$ln=\d+,r=\d+,p=\d+\$/);
		} finally {
			await db.end();
		}
	});

	it("登录名或密码不对：401 invalid_credentials，说法一样（不泄露账号存不存在）；登录名不区分大小写", async () => {
		const wrongPassword = await login(cp, "root", "not-the-password");
		const noSuchUser = await login(cp, "nobody", "whatever-password");
		const badShape = await login(cp, "Has-Hyphen", "whatever-password");
		for (const r of [wrongPassword, noSuchUser, badShape]) {
			expect(r.res.status).toBe(401);
			expect(r.setCookie).toBe("");
		}
		const bodies = await Promise.all(
			[wrongPassword, noSuchUser, badShape].map((r) => r.res.text()),
		);
		expect(new Set(bodies).size).toBe(1);
		expect(JSON.parse(bodies[0] as string)).toMatchObject({
			error: { code: "invalid_credentials" },
		});
		expect((await login(cp, "ROOT", ADMIN.password)).res.status).toBe(200);
	});

	it("登出：这一个登录失效，Cookie 被清掉；别的登录不受影响", async () => {
		const first = await login(cp, "root", ADMIN.password);
		const second = await login(cp, "root", ADMIN.password);
		const out = await api(cp, first.cookie)("POST", "/auth/logout");
		expect(out.status).toBe(204);
		expect(out.headers.get("set-cookie")).toMatch(/sfly_login=;.*Max-Age=0/);
		expect((await api(cp, first.cookie)("GET", "/auth/me")).status).toBe(401);
		expect((await api(cp, second.cookie)("GET", "/auth/me")).status).toBe(200);
	});

	it("注销全部登录：他所有的登录都失效，包括当前这个", async () => {
		const a = await login(cp, "root", ADMIN.password);
		const b = await login(cp, "root", ADMIN.password);
		expect((await api(cp, a.cookie)("POST", "/auth/logout-all")).status).toBe(204);
		expect((await api(cp, a.cookie)("GET", "/auth/me")).status).toBe(401);
		expect((await api(cp, b.cookie)("GET", "/auth/me")).status).toBe(401);
	});

	it("当前用户、注销全部登录、改密码只认登录：不带凭据 401，带令牌 403；登出什么凭据都不拒绝（204）", async () => {
		const accounts = new TestAccounts(cp.database.url);
		try {
			const db = new pg.Client({ connectionString: cp.database.url });
			await db.connect();
			const admin = (await db.query("select id from users where login_name = 'root'")).rows[0].id;
			await db.end();
			const token = await accounts.personalToken(admin);
			for (const [method, path] of [
				["GET", "/auth/me"],
				["POST", "/auth/logout-all"],
				["POST", "/auth/password"],
				["GET", "/users"],
			] as const) {
				const anonymous = await cp.fetch(path, { method, headers: SAME_ORIGIN });
				expect(anonymous.status, `${method} ${path} 不带凭据`).toBe(401);
				const withToken = await cp.fetch(path, {
					method,
					headers: { authorization: `Bearer ${token}` },
				});
				expect(withToken.status, `${method} ${path} 带个人令牌`).toBe(403);
			}
		} finally {
			await accounts.close();
		}
	});

	it("密码在登录时按需要升级：调高参数后旧哈希仍能登录，并换成新参数的哈希", async () => {
		const db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		try {
			const before = (await db.query("select password_hash from users where login_name = 'root'"))
				.rows[0].password_hash as string;
			expect(before).toContain("$ln=10,");
			// 把存储串换成更低参数（ln=9）的同一个密码，模拟「调高参数之前存的」。
			const { hashPassword } = await import("../src/auth/password.js");
			const old = await hashPassword(ADMIN.password, { logN: 9, r: 8, p: 1 });
			await db.query("update users set password_hash = $1 where login_name = 'root'", [old]);
			expect((await login(cp, "root", ADMIN.password)).res.status).toBe(200);
			const after = (await db.query("select password_hash from users where login_name = 'root'"))
				.rows[0].password_hash as string;
			expect(after).toContain("$ln=10,");
			expect(after).not.toBe(old);
			expect((await login(cp, "root", ADMIN.password)).res.status).toBe(200);
		} finally {
			await db.end();
		}
	});
});

describe("改密码、平台管理员管理账号", () => {
	let cp: TestControlPlane;
	let adminCookie: string;
	beforeEach(async () => {
		cp = await startTestControlPlane({ defaultCredentials: false, initialAdmin: ADMIN });
		adminCookie = (await login(cp, "root", ADMIN.password)).cookie;
		await publishPackage(cp.asTester(), "stub", "1.0.0", { echo: ["v"] });
	});
	afterEach(async () => {
		await cp.close();
	});

	const create = (body: Record<string, unknown>, cookie = adminCookie) =>
		api(cp, cookie)("POST", "/users", {
			display_name: "小明",
			password: "xiaoming-pass-1",
			...body,
		});

	it("登录名的规则：含连字符、大写字母、超长、空格、非 ASCII 的建用户被拒绝（400），说明规则；合法的建得出来", async () => {
		for (const bad of ["a-b", "Alice", "x".repeat(33), "a b", "用户", "a.b", ""]) {
			const res = await create({ login_name: bad });
			expect(res.status, bad).toBe(400);
			const text = JSON.stringify(await res.json());
			expect(text, bad).toContain("小写字母、数字和下划线");
		}
		for (const good of ["a", "alice", "a_b", "user_01", "x".repeat(32)]) {
			expect((await create({ login_name: good })).status, good).toBe(201);
		}
	});

	it("登录名重复：409 login_name_taken；新建的用户不是平台管理员，除非说了是", async () => {
		const first = await create({ login_name: "xiaoming" });
		expect(first.status).toBe(201);
		expect(await first.json()).toMatchObject({ is_platform_admin: false, disabled_at: null });
		const again = await create({ login_name: "xiaoming" });
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({ error: { code: "login_name_taken" } });
		const boss = await create({ login_name: "boss2", is_platform_admin: true });
		expect(await boss.json()).toMatchObject({ is_platform_admin: true });
	});

	it("密码太短、太长被拒绝；响应和列表里没有密码或哈希", async () => {
		expect((await create({ login_name: "short", password: "1234567" })).status).toBe(400);
		expect((await create({ login_name: "long", password: "x".repeat(129) })).status).toBe(400);
		const ok = await create({ login_name: "fine" });
		expect(JSON.stringify(await ok.json())).not.toMatch(/password|scrypt/);
		const list = await api(cp, adminCookie)("GET", "/users");
		expect(list.status).toBe(200);
		const text = JSON.stringify(await list.json());
		expect(text).not.toMatch(/password|scrypt/);
		expect(text).toContain("fine");
	});

	it("只有平台管理员能管理账号：普通用户 403，不带凭据 401", async () => {
		await create({ login_name: "normal" });
		const normal = (await login(cp, "normal", "xiaoming-pass-1")).cookie;
		for (const [method, path, body] of [
			["GET", "/users", undefined],
			["POST", "/users", { login_name: "x", display_name: "x", password: "password-x-1" }],
		] as const) {
			const res = await api(cp, normal)(method, path, body);
			expect(res.status, `${method} ${path}`).toBe(403);
		}
		expect((await cp.fetch("/users", { method: "GET" })).status).toBe(401);
	});

	it("改自己的密码：旧密码不对 403 wrong_password；对了之后别处的登录都注销，当前这个保留，新密码能登录、旧密码不行", async () => {
		await create({ login_name: "xiaoming" });
		const here = (await login(cp, "xiaoming", "xiaoming-pass-1")).cookie;
		const elsewhere = (await login(cp, "xiaoming", "xiaoming-pass-1")).cookie;
		const wrong = await api(cp, here)("POST", "/auth/password", {
			old_password: "not-the-old-one",
			new_password: "brand-new-pass-1",
		});
		expect(wrong.status).toBe(403);
		expect(await wrong.json()).toMatchObject({ error: { code: "wrong_password" } });
		const changed = await api(cp, here)("POST", "/auth/password", {
			old_password: "xiaoming-pass-1",
			new_password: "brand-new-pass-1",
		});
		expect(changed.status).toBe(204);
		expect((await api(cp, here)("GET", "/auth/me")).status).toBe(200);
		expect((await api(cp, elsewhere)("GET", "/auth/me")).status).toBe(401);
		expect((await login(cp, "xiaoming", "xiaoming-pass-1")).res.status).toBe(401);
		expect((await login(cp, "xiaoming", "brand-new-pass-1")).res.status).toBe(200);
	});

	it("改密码时旧密码猜错太多次会被限速（偷到 Cookie 的人不能借这个接口猜旧密码）", async () => {
		await create({ login_name: "xiaoming" });
		const cookie = (await login(cp, "xiaoming", "xiaoming-pass-1")).cookie;
		let limited = 0;
		for (let i = 0; i < 12; i++) {
			const res = await api(cp, cookie)("POST", "/auth/password", {
				old_password: `guess-${i}`,
				new_password: "brand-new-pass-1",
			});
			if (res.status === 429) {
				limited++;
				expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
			}
		}
		expect(limited).toBeGreaterThan(0);
	});

	it("停用：他已有的登录立即失效（401），不能再登录；不能停用自己", async () => {
		const made = (await (await create({ login_name: "xiaoming" })).json()) as { id: string };
		const cookie = (await login(cp, "xiaoming", "xiaoming-pass-1")).cookie;
		expect((await api(cp, cookie)("GET", "/auth/me")).status).toBe(200);
		const disabled = await api(cp, adminCookie)("POST", `/users/${made.id}/disable`);
		expect(disabled.status).toBe(200);
		expect(await disabled.json()).toMatchObject({ disabled_at: expect.any(String) });
		expect((await api(cp, cookie)("GET", "/auth/me")).status).toBe(401);
		expect((await login(cp, "xiaoming", "xiaoming-pass-1")).res.status).toBe(401);
		const me = (await (await api(cp, adminCookie)("GET", "/auth/me")).json()) as { id: string };
		const self = await api(cp, adminCookie)("POST", `/users/${me.id}/disable`);
		expect(self.status).toBe(409);
		expect(await self.json()).toMatchObject({ error: { code: "cannot_disable_self" } });
	});

	it("停用是可撤回的暂停，不是作废：启用之后他名下的登录、个人令牌、开发 Agent 的凭据都恢复可用；已经吊销的不会因此恢复", async () => {
		const made = (await (await create({ login_name: "xiaoming" })).json()) as { id: string };
		const accounts = new TestAccounts(cp.database.url);
		try {
			await accounts.member("default", made.id, "editor");
			const cookie = (await login(cp, "xiaoming", "xiaoming-pass-1")).cookie;
			const revokedCookie = (await login(cp, "xiaoming", "xiaoming-pass-1")).cookie;
			expect((await api(cp, revokedCookie)("POST", "/auth/logout")).status).toBe(204);
			const token = await accounts.personalToken(made.id);
			const revokedToken = await accounts.personalToken(made.id, {
				revokedAt: new Date("2026-01-01"),
			});
			const devAgent = await accounts.agentCredential("default", "dev-xiaoming-laptop", {
				userId: made.id,
			});
			const read = (headers: Record<string, string>) =>
				cp.fetch("/projects/default/orchestrations", { headers });
			const bearerOf = (t: string) => ({ authorization: `Bearer ${t}` });
			const download = (t: string) =>
				cp.fetch("/projects/default/packages/stub/versions/1.0.0/archive", {
					headers: bearerOf(t),
				});

			// 启用着：能用；吊销过的不能用。
			expect((await api(cp, cookie)("GET", "/auth/me")).status).toBe(200);
			expect((await read(bearerOf(token))).status).toBe(200);
			expect((await read(bearerOf(revokedToken))).status).toBe(401);
			expect((await api(cp, revokedCookie)("GET", "/auth/me")).status).toBe(401);
			expect((await download(devAgent)).status).not.toBe(401);

			// 停用：全部拒绝。
			await api(cp, adminCookie)("POST", `/users/${made.id}/disable`);
			expect((await api(cp, cookie)("GET", "/auth/me")).status).toBe(401);
			expect((await read(bearerOf(token))).status).toBe(401);
			expect((await download(devAgent)).status).toBe(401);

			// 启用：恢复；吊销过的仍然不行。
			expect((await api(cp, adminCookie)("POST", `/users/${made.id}/enable`)).status).toBe(200);
			expect((await api(cp, cookie)("GET", "/auth/me")).status).toBe(200);
			expect((await read(bearerOf(token))).status).toBe(200);
			expect((await download(devAgent)).status).not.toBe(401);
			expect((await read(bearerOf(revokedToken))).status).toBe(401);
			expect((await api(cp, revokedCookie)("GET", "/auth/me")).status).toBe(401);
			expect((await login(cp, "xiaoming", "xiaoming-pass-1")).res.status).toBe(200);
		} finally {
			await accounts.close();
		}
	});

	it("检查本身也看停用：用户在库里被停用（没有经过停用接口，登录没被注销），他的登录照样立即失效", async () => {
		const made = (await (await create({ login_name: "xiaoming" })).json()) as { id: string };
		const cookie = (await login(cp, "xiaoming", "xiaoming-pass-1")).cookie;
		expect((await api(cp, cookie)("GET", "/auth/me")).status).toBe(200);
		const accounts = new TestAccounts(cp.database.url);
		try {
			await accounts.disable(made.id);
		} finally {
			await accounts.close();
		}
		expect((await api(cp, cookie)("GET", "/auth/me")).status).toBe(401);
		expect((await api(cp, cookie)("GET", "/projects/default/orchestrations")).status).toBe(401);
	});

	it("停用时他的个人令牌也立即失效（访问检查每次看用户有没有停用）", async () => {
		const made = (await (await create({ login_name: "xiaoming" })).json()) as { id: string };
		const accounts = new TestAccounts(cp.database.url);
		try {
			const token = await accounts.personalToken(made.id);
			const read = () =>
				cp.fetch("/projects/default/orchestrations", {
					headers: { authorization: `Bearer ${token}` },
				});
			// 不是任何项目的成员：能不能读不是这里要的，看 401 和 404 的区别——有效的令牌是 404（不是成员）。
			expect((await read()).status).toBe(404);
			await api(cp, adminCookie)("POST", `/users/${made.id}/disable`);
			expect((await read()).status).toBe(401);
		} finally {
			await accounts.close();
		}
	});

	it("重置密码：新密码能登录，旧密码不行，他的全部登录注销；不能重置自己的（用改密码）", async () => {
		const made = (await (await create({ login_name: "xiaoming" })).json()) as { id: string };
		const cookie = (await login(cp, "xiaoming", "xiaoming-pass-1")).cookie;
		const reset = await api(cp, adminCookie)("POST", `/users/${made.id}/password`, {
			password: "reset-by-admin-1",
		});
		expect(reset.status).toBe(204);
		expect((await api(cp, cookie)("GET", "/auth/me")).status).toBe(401);
		expect((await login(cp, "xiaoming", "xiaoming-pass-1")).res.status).toBe(401);
		expect((await login(cp, "xiaoming", "reset-by-admin-1")).res.status).toBe(200);
		const me = (await (await api(cp, adminCookie)("GET", "/auth/me")).json()) as { id: string };
		expect(
			(
				await api(cp, adminCookie)("POST", `/users/${me.id}/password`, {
					password: "another-pass-1",
				})
			).status,
		).toBe(409);
		expect(
			(
				await api(cp, adminCookie)("POST", `/users/${crypto.randomUUID()}/password`, {
					password: "another-pass-1",
				})
			).status,
		).toBe(404);
	});
});

describe("登录限速", () => {
	let cp: TestControlPlane;
	beforeAll(async () => {
		cp = await startTestControlPlane({ defaultCredentials: false, initialAdmin: ADMIN });
	});
	afterAll(async () => {
		await cp.close();
	});

	it("连续失败有退避：前几次 401，之后 429 带 Retry-After，限速期间对的密码也要等；推进时间之后恢复；成功清零", async () => {
		const clock = cp.clock as ManualClock;
		let first429 = -1;
		for (let i = 0; i < 12; i++) {
			const { res } = await login(cp, "root", `wrong-${i}`);
			if (res.status === 429 && first429 < 0) {
				first429 = i;
				expect(res.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
				expect(await res.json()).toMatchObject({ error: { code: "too_many_attempts" } });
			}
		}
		expect(first429).toBeGreaterThanOrEqual(5);
		// 限速期间连对的密码也不放行。
		expect((await login(cp, "root", ADMIN.password)).res.status).toBe(429);
		clock.advance(3_600_001);
		const ok = await login(cp, "root", ADMIN.password);
		expect(ok.res.status).toBe(200);
		// 成功之后清零：再错几次又是从头算。
		for (let i = 0; i < 3; i++) expect((await login(cp, "root", "wrong")).res.status).toBe(401);
	});
});

describe("登出和停用关掉打开的事件流", () => {
	let cp: TestControlPlane;
	let adminCookie: string;
	beforeEach(async () => {
		cp = await startTestControlPlane({ defaultCredentials: false, initialAdmin: ADMIN });
		adminCookie = (await login(cp, "root", ADMIN.password)).cookie;
	});
	afterEach(async () => {
		await cp.close();
	});

	const waitEnded = async (stream: SseClient) => {
		await vi.waitFor(() => expect(stream.ended).toBe(true), { timeout: 3000 });
	};
	/** 打开一条事件流（运行的事件流，运行存在即可；带着这个登录 Cookie）。 */
	const openStream = async (cookie: string) => {
		const { run } = await seedTask(cp.asTester(), { agent: "agent-a", status: "running" });
		return SseClient.open(cp, `/runs/${run}/events`, loginCookie(cookie));
	};

	it("登出：这个登录打开的流关掉，同一个用户别的登录打开的流不受影响", async () => {
		const other = (await login(cp, "root", ADMIN.password)).cookie;
		const mine = await openStream(adminCookie);
		const theirs = await openStream(other);
		await mine.next("time");
		await theirs.next("time");
		await api(cp, adminCookie)("POST", "/auth/logout");
		await waitEnded(mine);
		expect(theirs.ended).toBe(false);
		theirs.close();
	});

	it("注销全部登录：他所有打开的流都关掉", async () => {
		const other = (await login(cp, "root", ADMIN.password)).cookie;
		const mine = await openStream(adminCookie);
		const theirs = await openStream(other);
		await api(cp, adminCookie)("POST", "/auth/logout-all");
		await waitEnded(mine);
		await waitEnded(theirs);
	});

	it("停用：他打开的流关掉，别的用户的流不受影响", async () => {
		const made = (await (
			await api(cp, adminCookie)("POST", "/users", {
				login_name: "xiaoming",
				display_name: "小明",
				password: "xiaoming-pass-1",
			})
		).json()) as { id: string };
		// 小明要是某个项目的成员才读得到场景：给他编辑者。
		const accounts = new TestAccounts(cp.database.url);
		try {
			await accounts.member("default", made.id, "editor");
		} finally {
			await accounts.close();
		}
		const xiaoming = (await login(cp, "xiaoming", "xiaoming-pass-1")).cookie;
		const his = await openStream(xiaoming);
		const adminsOwn = await openStream(adminCookie);
		await api(cp, adminCookie)("POST", `/users/${made.id}/disable`);
		await waitEnded(his);
		expect(adminsOwn.ended).toBe(false);
		adminsOwn.close();
	});
});

describe("还没有初始化（没有任何用户）：不带凭据只能初始化、登录和用公开的接口（#494）", () => {
	let cp: TestControlPlane;
	beforeAll(async () => {
		cp = await startTestControlPlane({ defaultCredentials: false });
	});
	afterAll(async () => {
		await cp.close();
	});

	it("登录页的状态接口说要初始化；初始化、登录、登出、健康检查不要凭据；别的接口不带凭据（带了昵称也一样）401", async () => {
		expect(await (await cp.fetch("/auth/status")).json()).toMatchObject({ setup_required: true });
		expect((await cp.fetch("/health")).status).toBe(200);
		// 初始化和登录走到了处理函数：码不对、账号不对是它们自己的错误，不是要凭据的 401。
		const setup = await cp.fetch("/auth/setup", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({
				setup_code: "0000-0000-0000-0000-0000",
				login_name: "boss",
				display_name: "第一个管理员",
				password: "first-password-1",
			}),
		});
		expect(setup.status).toBe(403);
		expect(await setup.json()).toMatchObject({ error: { code: "invalid_setup_code" } });
		const login = await cp.fetch("/auth/login", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ login_name: "nobody", password: "whatever-password" }),
		});
		expect(login.status).toBe(401);
		expect(await login.json()).toMatchObject({ error: { code: "invalid_credentials" } });
		expect((await cp.fetch("/auth/logout", { method: "POST" })).status).toBe(204);

		const read = await cp.fetch("/projects/default/orchestrations");
		const write = await cp.fetch("/projects/default/orchestrations", {
			method: "POST",
			headers: { ...JSON_HEADERS, ...actAs("xiaoming") },
			body: JSON.stringify({ name: "场景" }),
		});
		for (const res of [read, write]) {
			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "unauthorized", message: expect.stringContaining("sfly login") },
			});
		}
		expect(await (await cp.fetch("/auth/status")).json()).toMatchObject({ setup_required: true });
	});
});
