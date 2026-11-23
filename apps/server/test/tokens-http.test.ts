// 个人令牌和项目令牌经 HTTP（ADR 0029「凭据」，规格 #491）：真实控制面和数据库。
// 签发（Cookie、账号密码）、令牌不能签发令牌、范围不超过签发人的角色、使用时再取交集、过期和吊销立即生效、
// 个人令牌只能吊销它自己、原值只出现一次（不在库里、不在日志里）、最后使用时间节流、吊销时关掉打开的事件流、
// 项目令牌（管理范围、不能带管理、只认人签发）、限定项目的令牌看不到别的项目。
import { Writable } from "node:stream";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_NOT_FOUND_MESSAGE } from "../src/auth/access-guard.js";
import { hashCredential } from "../src/auth/credential-hash.js";
import { ApiClient } from "./support/api-client.js";
import { bearer, loginCookie, TestAccounts } from "./support/credentials.js";
import type { ManualClock } from "./support/manual-clock.js";
import { seedTask } from "./support/seed-task.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const ADMIN = { loginName: "root", password: "admin-password-1" };
const JSON_HEADERS = { "content-type": "application/json" };
const PASSWORD = "user-password-1";
const DAY = 86_400_000;

interface Issued {
	id: string;
	kind: string;
	name: string;
	prefix: string;
	scopes: string[];
	project: string | null;
	created_at: string;
	expires_at: string | null;
	revoked_at: string | null;
	last_used_at: string | null;
	current: boolean;
	token: string;
}

describe("令牌", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let db: pg.Client;
	let clock: ManualClock;
	let adminCookie: string;
	const logs: string[] = [];

	beforeEach(async () => {
		logs.length = 0;
		const stream = new Writable({
			write(chunk, _encoding, done) {
				logs.push(String(chunk));
				done();
			},
		});
		cp = await startTestControlPlane({ initialAdmin: ADMIN, logger: { stream } });
		clock = cp.clock as ManualClock;
		accounts = new TestAccounts(cp.database.url);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		adminCookie = await login("root", ADMIN.password);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await db.end();
		await accounts.close();
		await cp.close();
	});

	// ---- 小工具

	const call = (
		headers: Record<string, string>,
		method: string,
		path: string,
		body?: unknown,
	): Promise<Response> =>
		cp.fetch(path, {
			method,
			headers: { ...(body === undefined ? {} : JSON_HEADERS), ...headers },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const withCookie = (cookie: string) => loginCookie(cookie);

	async function login(loginName: string, password: string): Promise<string> {
		const res = await cp.fetch("/auth/login", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ login_name: loginName, password }),
		});
		expect(res.status, await res.clone().text()).toBe(200);
		return /sfly_login=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
	}

	/** 管理员建一个有真实密码的用户（可以用账号密码换令牌）；返回用户 ID。 */
	async function user(loginName: string, options: { admin?: boolean } = {}): Promise<string> {
		const res = await call(withCookie(adminCookie), "POST", "/users", {
			login_name: loginName,
			display_name: loginName,
			password: PASSWORD,
			is_platform_admin: options.admin ?? false,
		});
		expect(res.status, await res.clone().text()).toBe(201);
		return ((await res.json()) as { id: string }).id;
	}

	/** 用 Cookie 签发个人令牌。 */
	async function personal(cookie: string, body: Record<string, unknown>): Promise<Response> {
		return call(withCookie(cookie), "POST", "/account/tokens", body);
	}
	async function personalOk(cookie: string, body: Record<string, unknown>): Promise<Issued> {
		const res = await personal(cookie, body);
		expect(res.status, await res.clone().text()).toBe(201);
		return (await res.json()) as Issued;
	}
	async function projectOk(
		cookie: string,
		project: string,
		body: Record<string, unknown>,
	): Promise<Issued> {
		const res = await call(withCookie(cookie), "POST", `/projects/${project}/tokens`, body);
		expect(res.status, await res.clone().text()).toBe(201);
		return (await res.json()) as Issued;
	}
	const errorOf = async (res: Response) =>
		((await res.json()) as { error: { code: string; message: string } }).error;
	const row = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

	/** 默认项目里一个场景（触发运行用）。 */
	const scenario = () =>
		new ApiClient(cp).orchestrationWith({
			default_agent: "agent-a",
			nodes: [{ id: "entry", kind: "entry", params: [] }],
			edges: [],
			packages: {},
		});

	// ---- 个人令牌：签发

	describe("个人令牌：签发", () => {
		it("用登录 Cookie 签发：原值带 sfly_pat_ 前缀，只在这次响应里出现；带着它能请求", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "editor");
			const cookie = await login("alice", PASSWORD);
			const issued = await personalOk(cookie, { name: "我的电脑", expires_in_days: 30 });
			expect(issued).toMatchObject({
				kind: "personal",
				name: "我的电脑",
				project: null,
				revoked_at: null,
				last_used_at: null,
				current: false,
			});
			expect(issued.token).toMatch(/^sfly_pat_[0-9a-f]{48}$/);
			expect(issued.prefix).toBe(issued.token.slice(0, 13));
			expect(issued.expires_at).toBe(new Date(clock.now().getTime() + 30 * DAY).toISOString());
			// 带着它能请求（不用昵称）。
			const res = await call(bearer(issued.token), "GET", "/orchestrations");
			expect(res.status).toBe(200);
		});

		it("库里只有 SHA-256 哈希和前缀，没有原值；列出的响应里也没有原值", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "editor");
			const cookie = await login("alice", PASSWORD);
			const issued = await personalOk(cookie, { name: "一个" });
			const stored = await row("select * from api_tokens where id = $1", [issued.id]);
			expect(stored.token_hash).toBe(hashCredential(issued.token));
			expect(stored.token_hash).not.toBe(issued.token);
			expect(stored.prefix).toBe(issued.token.slice(0, 13));
			expect(JSON.stringify(stored)).not.toContain(issued.token);
			expect(stored).toMatchObject({ kind: "personal", user_id: id, project_id: null });
			const listed = await call(withCookie(cookie), "GET", "/account/tokens");
			expect(listed.status).toBe(200);
			const text = await listed.text();
			expect(text).not.toContain(issued.token);
			expect(JSON.parse(text).tokens).toEqual([
				expect.objectContaining({ id: issued.id, prefix: issued.prefix, current: false }),
			]);
			expect(JSON.parse(text).tokens[0]).not.toHaveProperty("token");
		});

		it("账号密码换令牌（sfly login）：不要 Cookie；不留下登录；密码不对 401，停用的账号 401，连着猜错会限速", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "editor");
			const logins = async () => (await row("select count(*)::int as n from logins")).n as number;
			const before = await logins();
			const res = await call({}, "POST", "/account/tokens", {
				name: "sfly login",
				login_name: "alice",
				password: PASSWORD,
			});
			expect(res.status, await res.clone().text()).toBe(201);
			const issued = (await res.json()) as Issued;
			expect(issued.token).toMatch(/^sfly_pat_/);
			expect(await logins()).toBe(before);
			// 登录名不区分大小写，和登录一样。
			expect(
				(
					await call({}, "POST", "/account/tokens", {
						name: "大写",
						login_name: "ALICE",
						password: PASSWORD,
					})
				).status,
			).toBe(201);
			// 密码不对：401，和登录同一个说法，没有签出令牌。
			const wrong = await call({}, "POST", "/account/tokens", {
				name: "x",
				login_name: "alice",
				password: "wrong-password-9",
			});
			expect(wrong.status).toBe(401);
			expect(await errorOf(wrong)).toMatchObject({ code: "invalid_credentials" });
			expect((await row("select count(*)::int as n from api_tokens")).n).toBe(2);
			// 没有 Cookie 也没有账号密码：401。
			expect((await call({}, "POST", "/account/tokens", { name: "x" })).status).toBe(401);
			expect(
				(await call({}, "POST", "/account/tokens", { name: "x", login_name: "alice" })).status,
			).toBe(401);
			// 停用的账号和密码不对一样。
			await accounts.disable(id);
			const disabled = await call({}, "POST", "/account/tokens", {
				name: "y",
				login_name: "alice",
				password: PASSWORD,
			});
			expect(disabled.status).toBe(401);
			expect(await errorOf(disabled)).toMatchObject({ code: "invalid_credentials" });
		});

		it("账号密码方式和登录共用限速：连着猜错 429 带 Retry-After", async () => {
			await user("alice");
			let limited: Response | undefined;
			for (let i = 0; i < 40 && limited === undefined; i++) {
				const res = await call({}, "POST", "/account/tokens", {
					name: "x",
					login_name: "alice",
					password: `wrong-password-${i}`,
				});
				if (res.status === 429) limited = res;
			}
			expect(limited?.status).toBe(429);
			expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThan(0);
			// 限速期间连正确的密码也不放行。
			const right = await call({}, "POST", "/account/tokens", {
				name: "x",
				login_name: "alice",
				password: PASSWORD,
			});
			expect(right.status).toBe(429);
		});

		it("令牌不能签发令牌：个人令牌、项目令牌带着正确的账号密码也是 403", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "project_admin");
			const personalToken = await accounts.personalToken(id);
			const projectToken = await accounts.projectToken("default");
			for (const token of [personalToken, projectToken]) {
				const res = await call(bearer(token), "POST", "/account/tokens", {
					name: "套娃",
					login_name: "alice",
					password: PASSWORD,
				});
				expect(res.status).toBe(403);
				expect(await errorOf(res)).toMatchObject({ code: "forbidden" });
			}
			expect((await row("select count(*)::int as n from api_tokens")).n).toBe(2);
			// 失效的令牌是 401，不是 403。
			const revoked = await accounts.personalToken(id, { revokedAt: new Date("2026-01-01") });
			expect((await call(bearer(revoked), "POST", "/account/tokens", { name: "x" })).status).toBe(
				401,
			);
		});

		it("只读角色和编辑者都能签自己的；平台管理员也行", async () => {
			const reader = await user("reader");
			await accounts.member("default", reader, "read_only");
			const editor = await user("editor1");
			await accounts.member("default", editor, "editor");
			for (const name of ["reader", "editor1"]) {
				const issued = await personalOk(await login(name, PASSWORD), { name: "t" });
				expect(issued.token).toMatch(/^sfly_pat_/);
			}
			expect((await personal(adminCookie, { name: "t" })).status).toBe(201);
		});
	});

	// ---- 个人令牌：范围

	describe("个人令牌：范围不超过签发人此刻的角色", () => {
		it("不写范围：签发人此刻能有的全部范围（只读 → 读；编辑者 → 没有管理；管理员 → 全部）", async () => {
			const reader = await user("reader");
			await accounts.member("default", reader, "read_only");
			const editor = await user("editor1");
			await accounts.member("default", editor, "editor");
			const readerToken = await personalOk(await login("reader", PASSWORD), { name: "a" });
			expect(readerToken.scopes).toEqual(["read"]);
			const editorToken = await personalOk(await login("editor1", PASSWORD), { name: "a" });
			expect(editorToken.scopes.sort()).toEqual([
				"edit",
				"publish",
				"read",
				"run",
				"session_build",
			]);
			const adminToken = await personalOk(adminCookie, { name: "a" });
			expect(adminToken.scopes.sort()).toEqual([
				"edit",
				"manage",
				"publish",
				"read",
				"run",
				"session_build",
			]);
		});

		it("写了超过角色的范围：403 scope_exceeds_role，说明写明哪些超了；没有签出令牌", async () => {
			const reader = await user("reader");
			await accounts.member("default", reader, "read_only");
			const cookie = await login("reader", PASSWORD);
			const res = await personal(cookie, { name: "想要更多", scopes: ["read", "run", "manage"] });
			expect(res.status).toBe(403);
			const error = await errorOf(res);
			expect(error.code).toBe("scope_exceeds_role");
			expect(error.message).toContain("运行");
			expect(error.message).toContain("管理");
			expect((await row("select count(*)::int as n from api_tokens")).n).toBe(0);
			// 编辑者没有管理。
			const editor = await user("editor1");
			await accounts.member("default", editor, "editor");
			const res2 = await personal(await login("editor1", PASSWORD), {
				name: "x",
				scopes: ["manage"],
			});
			expect(res2.status).toBe(403);
			expect(await errorOf(res2)).toMatchObject({ code: "scope_exceeds_role" });
			// 范围是空的、不认识的范围名：400。
			expect((await personal(cookie, { name: "x", scopes: [] })).status).toBe(400);
			expect((await personal(cookie, { name: "x", scopes: ["nonsense"] })).status).toBe(400);
		});

		it("限定了项目的，看他在那个项目里的角色；没限定的，看他在所有项目里的角色加起来", async () => {
			await accounts.project("alpha");
			await accounts.project("beta");
			const id = await user("alice");
			await accounts.member("alpha", id, "editor");
			await accounts.member("beta", id, "project_admin");
			const cookie = await login("alice", PASSWORD);
			// 限定在 alpha（编辑者）：没有管理；限定在 beta（项目管理员）：有。
			expect(
				(await personal(cookie, { name: "a1", project: "alpha", scopes: ["manage"] })).status,
			).toBe(403);
			expect(
				(await personalOk(cookie, { name: "a2", project: "alpha", scopes: ["run"] })).project,
			).toBe("alpha");
			expect(
				(await personalOk(cookie, { name: "b1", project: "beta", scopes: ["manage"] })).scopes,
			).toEqual(["manage"]);
			// 没限定：两个项目的角色加起来，有管理。
			const all = await personalOk(cookie, { name: "all" });
			expect(all.scopes).toContain("manage");
			expect(all.project).toBeNull();
			// 限定了 alpha、不写范围：alpha 里的角色（编辑者）的范围。
			const limited = await personalOk(cookie, { name: "a3", project: "alpha" });
			expect(limited.scopes.sort()).toEqual(["edit", "publish", "read", "run", "session_build"]);
		});

		it("限定的项目不存在、或他不是成员（不是平台管理员）：404，说法一样，不泄露项目有没有", async () => {
			await accounts.project("secret");
			const id = await user("alice");
			await accounts.member("default", id, "editor");
			const cookie = await login("alice", PASSWORD);
			for (const project of ["secret", "no-such-project"]) {
				const res = await personal(cookie, { name: "x", project });
				expect(res.status, project).toBe(404);
				expect(await errorOf(res)).toMatchObject({ message: ACCESS_NOT_FOUND_MESSAGE });
			}
			// 平台管理员不是成员也能限定到存在的项目；不存在的项目 404。
			expect((await personal(adminCookie, { name: "x", project: "secret" })).status).toBe(201);
			expect((await personal(adminCookie, { name: "y", project: "no-such-project" })).status).toBe(
				404,
			);
		});

		it("还不是任何项目的成员：403 no_scopes，写明怎么办", async () => {
			await user("nobody");
			const res = await personal(await login("nobody", PASSWORD), { name: "x" });
			expect(res.status).toBe(403);
			expect(await errorOf(res)).toMatchObject({ code: "no_scopes" });
		});

		it("使用时再和他此刻的角色取交集：只读范围的令牌触发运行被拒绝；他被降为只读后，原来有「运行」范围的令牌也被拒绝", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "editor");
			const cookie = await login("alice", PASSWORD);
			const target = await scenario();
			const readOnly = await personalOk(cookie, { name: "只读", scopes: ["read"] });
			const runner = await personalOk(cookie, { name: "能运行", scopes: ["read", "run"] });
			const trigger = (token: string) =>
				call(bearer(token), "POST", `/orchestrations/${target}/runs`, { params: {} });
			// 只读范围的令牌：403，说明缺「运行」。
			const refused = await trigger(readOnly.token);
			expect(refused.status).toBe(403);
			expect((await errorOf(refused)).message).toContain("运行");
			// 有「运行」范围的令牌通过了访问检查（之后的失败是别的原因：场景没有版本）。
			expect((await trigger(runner.token)).status).not.toBe(403);
			// 他被降为只读：同一个令牌，访问检查按他此刻的角色取交集，「运行」没了。
			await accounts.member("default", id, "read_only");
			const downgraded = await trigger(runner.token);
			expect(downgraded.status).toBe(403);
			expect((await errorOf(downgraded)).message).toContain("运行");
			// 读还在。
			expect((await call(bearer(runner.token), "GET", "/orchestrations")).status).toBe(200);
		});
	});

	// ---- 个人令牌：过期、吊销、最后使用时间

	describe("个人令牌：过期、吊销和最后使用时间", () => {
		it("过期的令牌立即 401；不写有效期就不过期", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "editor");
			const cookie = await login("alice", PASSWORD);
			const short = await personalOk(cookie, { name: "短", expires_in_days: 1 });
			const forever = await personalOk(cookie, { name: "长" });
			expect(forever.expires_at).toBeNull();
			// 有效期要在范围内（登录的空闲期限是 12 小时：下面推进一天之后这个登录也过期了，所以先测）。
			expect((await personal(cookie, { name: "x", expires_in_days: 0 })).status).toBe(400);
			expect((await personal(cookie, { name: "x", expires_in_days: 3651 })).status).toBe(400);
			expect((await call(bearer(short.token), "GET", "/orchestrations")).status).toBe(200);
			clock.advance(DAY - 1);
			expect((await call(bearer(short.token), "GET", "/orchestrations")).status).toBe(200);
			clock.advance(1);
			expect((await call(bearer(short.token), "GET", "/orchestrations")).status).toBe(401);
			expect((await call(bearer(forever.token), "GET", "/orchestrations")).status).toBe(200);
		});

		it("用 Cookie 吊销自己的令牌：立即 401，列表里带吊销的时间；再吊销一次是 204", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "editor");
			const cookie = await login("alice", PASSWORD);
			const issued = await personalOk(cookie, { name: "要吊销的" });
			expect((await call(bearer(issued.token), "GET", "/orchestrations")).status).toBe(200);
			const revoked = await call(withCookie(cookie), "DELETE", `/account/tokens/${issued.id}`);
			expect(revoked.status).toBe(204);
			expect((await call(bearer(issued.token), "GET", "/orchestrations")).status).toBe(401);
			expect(
				(await call(withCookie(cookie), "DELETE", `/account/tokens/${issued.id}`)).status,
			).toBe(204);
			const listed = (await (await call(withCookie(cookie), "GET", "/account/tokens")).json()) as {
				tokens: Issued[];
			};
			expect(listed.tokens).toEqual([
				expect.objectContaining({
					id: issued.id,
					revoked_at: clock.now().toISOString(),
				}),
			]);
		});

		it("别人的令牌：用 Cookie 吊销是 404，没有被吊销", async () => {
			const alice = await user("alice");
			await accounts.member("default", alice, "editor");
			const bob = await user("bob");
			await accounts.member("default", bob, "editor");
			const bobToken = await personalOk(await login("bob", PASSWORD), { name: "bob 的" });
			const res = await call(
				withCookie(await login("alice", PASSWORD)),
				"DELETE",
				`/account/tokens/${bobToken.id}`,
			);
			expect(res.status).toBe(404);
			expect((await call(bearer(bobToken.token), "GET", "/orchestrations")).status).toBe(200);
			// 不是 UUID 的 ID 是 400（契约校验），不是 500。
			expect(
				(await call(withCookie(await login("alice", PASSWORD)), "DELETE", "/account/tokens/xx"))
					.status,
			).toBe(400);
		});

		it("个人令牌只能吊销它自己（sfly logout）：吊销同一用户的另一个令牌、改密码都被拒绝", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "editor");
			const cookie = await login("alice", PASSWORD);
			const mine = await personalOk(cookie, { name: "我用的" });
			const other = await personalOk(cookie, { name: "另一个" });
			// 吊销另一个：403，另一个还能用。
			const refused = await call(bearer(mine.token), "DELETE", `/account/tokens/${other.id}`);
			expect(refused.status).toBe(403);
			expect(await errorOf(refused)).toMatchObject({ code: "forbidden" });
			expect((await call(bearer(other.token), "GET", "/orchestrations")).status).toBe(200);
			// 改密码：只认登录，个人令牌 403。
			const changed = await call(bearer(mine.token), "POST", "/auth/password", {
				old_password: PASSWORD,
				new_password: "another-password-2",
			});
			expect(changed.status).toBe(403);
			expect(
				(await call({}, "POST", "/auth/login", { login_name: "alice", password: PASSWORD })).status,
			).toBe(200);
			// 吊销它自己：204，之后它自己是 401，另一个不受影响。
			const self = await call(bearer(mine.token), "DELETE", `/account/tokens/${mine.id}`);
			expect(self.status).toBe(204);
			expect((await call(bearer(mine.token), "GET", "/orchestrations")).status).toBe(401);
			expect((await call(bearer(other.token), "GET", "/orchestrations")).status).toBe(200);
		});

		it("用个人令牌列出自己的令牌，标出发起请求的这一个（current）；只列自己的", async () => {
			const alice = await user("alice");
			await accounts.member("default", alice, "editor");
			const bob = await user("bob");
			await accounts.member("default", bob, "editor");
			const cookie = await login("alice", PASSWORD);
			const first = await personalOk(cookie, { name: "一" });
			const second = await personalOk(cookie, { name: "二" });
			await personalOk(await login("bob", PASSWORD), { name: "bob 的" });
			const res = await call(bearer(second.token), "GET", "/account/tokens");
			expect(res.status).toBe(200);
			const { tokens, user: owner } = (await res.json()) as { tokens: Issued[]; user: object };
			// 附上令牌所属的用户：命令行靠它知道「自己」的显示名（个人令牌不能读 /auth/me）。
			expect(owner).toMatchObject({
				login_name: "alice",
				display_name: "alice",
				is_platform_admin: false,
			});
			expect(tokens.map((t) => [t.name, t.current]).sort()).toEqual([
				["一", false],
				["二", true],
			]);
			expect(tokens.map((t) => t.id).sort()).toEqual([first.id, second.id].sort());
			// 项目令牌不能列个人令牌（不属于任何用户）：403。
			const projectToken = await accounts.projectToken("default");
			expect((await call(bearer(projectToken), "GET", "/account/tokens")).status).toBe(403);
			// 没有凭据：401。
			expect((await call({}, "GET", "/account/tokens")).status).toBe(401);
		});

		it("同名的有效令牌：409 token_name_taken；吊销之后名字可以再用；每个用户的有效令牌有上限", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "editor");
			const cookie = await login("alice", PASSWORD);
			const first = await personalOk(cookie, { name: "笔记本" });
			const dup = await personal(cookie, { name: " 笔记本 " });
			expect(dup.status).toBe(409);
			expect(await errorOf(dup)).toMatchObject({ code: "token_name_taken" });
			await call(withCookie(cookie), "DELETE", `/account/tokens/${first.id}`);
			expect((await personal(cookie, { name: "笔记本" })).status).toBe(201);
			// 上限：已经有 100 个有效的，再签发 409 too_many_tokens。
			await db.query(
				`insert into api_tokens (id, kind, name, prefix, token_hash, user_id, scopes, created_at)
				select gen_random_uuid(), 'personal', 'bulk-' || n, 'sfly_pat_xxxx', 'hash-' || n, $1, '{read}', now()
				from generate_series(1, 99) n`,
				[id],
			);
			const over = await personal(cookie, { name: "第 101 个" });
			expect(over.status).toBe(409);
			expect(await errorOf(over)).toMatchObject({ code: "too_many_tokens" });
		});

		it("最后使用时间按令牌节流：一分钟内只写一次；失效的令牌不记", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "editor");
			const cookie = await login("alice", PASSWORD);
			const issued = await personalOk(cookie, { name: "节流" });
			const lastUsed = async () =>
				(await row("select last_used_at from api_tokens where id = $1", [issued.id]))
					.last_used_at as Date | null;
			expect(await lastUsed()).toBeNull();
			const use = () => call(bearer(issued.token), "GET", "/orchestrations");
			// 第一次使用：记下。
			const t0 = clock.now();
			expect((await use()).status).toBe(200);
			expect((await lastUsed())?.toISOString()).toBe(t0.toISOString());
			// 一分钟之内再用：不写（还是第一次的时间）。
			clock.advance(59_000);
			expect((await use()).status).toBe(200);
			expect((await lastUsed())?.toISOString()).toBe(t0.toISOString());
			// 满一分钟：更新。
			clock.advance(1_000);
			expect((await use()).status).toBe(200);
			expect((await lastUsed())?.toISOString()).toBe(clock.now().toISOString());
			// 并发的请求只有一个写（不报错，值是同一个时间）。
			clock.advance(120_000);
			const statuses = await Promise.all(Array.from({ length: 8 }, use));
			expect(statuses.map((r) => r.status)).toEqual(Array(8).fill(200));
			expect((await lastUsed())?.toISOString()).toBe(clock.now().toISOString());
			// 列出里看得到最后使用时间。
			const { tokens } = (await (
				await call(withCookie(cookie), "GET", "/account/tokens")
			).json()) as {
				tokens: Issued[];
			};
			expect(tokens[0]?.last_used_at).toBe(clock.now().toISOString());
			// 吊销之后再用是 401，不再记。
			await call(withCookie(cookie), "DELETE", `/account/tokens/${issued.id}`);
			const revokedAt = await lastUsed();
			clock.advance(600_000);
			expect((await use()).status).toBe(401);
			expect(await lastUsed()).toEqual(revokedAt);
		});
	});

	// ---- 令牌原值只出现一次

	describe("原值不在库里、不在日志里", () => {
		it("签发、使用、列出、吊销、失败的请求之后：控制面日志里找不到令牌原值、账号密码和 Cookie", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "project_admin");
			const cookie = await login("alice", PASSWORD);
			const issued = await personalOk(cookie, { name: "日志" });
			const viaPassword = (await (
				await call({}, "POST", "/account/tokens", {
					name: "密码方式",
					login_name: "alice",
					password: PASSWORD,
				})
			).json()) as Issued;
			const project = await projectOk(cookie, "default", { name: "ci", scopes: ["read"] });
			for (const token of [issued.token, viaPassword.token, project.token]) {
				await call(bearer(token), "GET", "/orchestrations");
				await call(bearer(token), "GET", "/account/tokens");
				await call(bearer(token), "POST", "/orchestrations", { name: "x" });
				await call(bearer(token), "GET", "/no-such-route");
			}
			await call({}, "POST", "/account/tokens", {
				name: "错的",
				login_name: "alice",
				password: "wrong-password-1",
			});
			await call(withCookie(cookie), "DELETE", `/account/tokens/${issued.id}`);
			await call(bearer(issued.token), "GET", "/orchestrations");
			await call(withCookie(cookie), "DELETE", `/projects/default/tokens/${project.id}`);
			await vi.waitFor(() => expect(logs.length).toBeGreaterThan(0));
			const output = logs.join("");
			for (const secret of [
				issued.token,
				viaPassword.token,
				project.token,
				PASSWORD,
				"wrong-password-1",
				cookie,
			]) {
				expect(output, `日志里不该有 ${secret.slice(0, 12)}…`).not.toContain(secret);
			}
			// 库里也没有原值。
			const dump = JSON.stringify((await db.query("select * from api_tokens")).rows);
			for (const token of [issued.token, viaPassword.token, project.token]) {
				expect(dump).not.toContain(token);
			}
		});
	});

	// ---- 吊销时关掉打开的事件流

	describe("吊销令牌：打开的事件流关掉", () => {
		const waitEnded = (stream: SseClient) =>
			vi.waitFor(() => expect(stream.ended).toBe(true), { timeout: 3000 });
		const open = async (token: string) => {
			const { run } = await seedTask(cp, { agent: "agent-a", status: "running" });
			return SseClient.open(cp, `/runs/${run}/events`, bearer(token));
		};

		it("个人令牌被吊销（自己吊销或用 Cookie 吊销）：用它打开的流关掉，同一用户别的令牌的流不受影响", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "editor");
			const cookie = await login("alice", PASSWORD);
			const a = await personalOk(cookie, { name: "a" });
			const b = await personalOk(cookie, { name: "b" });
			const streamA = await open(a.token);
			const streamB = await open(b.token);
			await streamA.next("time");
			await streamB.next("time");
			expect((await call(withCookie(cookie), "DELETE", `/account/tokens/${a.id}`)).status).toBe(
				204,
			);
			await waitEnded(streamA);
			expect(streamB.ended).toBe(false);
			// 令牌吊销它自己（sfly logout）：同样关掉。
			expect((await call(bearer(b.token), "DELETE", `/account/tokens/${b.id}`)).status).toBe(204);
			await waitEnded(streamB);
		});

		it("项目令牌被吊销：用它打开的流关掉", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "project_admin");
			const cookie = await login("alice", PASSWORD);
			const token = await projectOk(cookie, "default", { name: "ci", scopes: ["read"] });
			const stream = await open(token.token);
			await stream.next("time");
			expect(
				(await call(withCookie(cookie), "DELETE", `/projects/default/tokens/${token.id}`)).status,
			).toBe(204);
			await waitEnded(stream);
		});
	});

	// ---- 项目令牌

	describe("项目令牌", () => {
		it("项目管理员用 Cookie 签发：原值带 sfly_prj_ 前缀、范围必须写；带着它按范围请求，没有用户", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "project_admin");
			const cookie = await login("alice", PASSWORD);
			const issued = await projectOk(cookie, "default", {
				name: "ci",
				scopes: ["read", "run"],
				expires_in_days: 90,
			});
			expect(issued.token).toMatch(/^sfly_prj_[0-9a-f]{48}$/);
			expect(issued).toMatchObject({
				kind: "project",
				project: "default",
				scopes: ["read", "run"],
				current: false,
			});
			const stored = await row("select * from api_tokens where id = $1", [issued.id]);
			expect(stored).toMatchObject({ kind: "project", project_id: "default", user_id: null });
			expect(stored.token_hash).toBe(hashCredential(issued.token));
			expect(JSON.stringify(stored)).not.toContain(issued.token);
			expect((await call(bearer(issued.token), "GET", "/orchestrations")).status).toBe(200);
			// 范围必须写。
			expect(
				(await call(withCookie(cookie), "POST", "/projects/default/tokens", { name: "x" })).status,
			).toBe(400);
		});

		it("项目令牌自己不能带「管理」范围：签发时拒绝（400 manage_scope_not_allowed），库里没有", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "project_admin");
			const cookie = await login("alice", PASSWORD);
			const res = await call(withCookie(cookie), "POST", "/projects/default/tokens", {
				name: "想管理",
				scopes: ["read", "manage"],
			});
			expect(res.status).toBe(400);
			expect(await errorOf(res)).toMatchObject({ code: "manage_scope_not_allowed" });
			expect((await row("select count(*)::int as n from api_tokens")).n).toBe(0);
			// 平台管理员也一样。
			const admin = await call(withCookie(adminCookie), "POST", "/projects/default/tokens", {
				name: "想管理",
				scopes: ["manage"],
			});
			expect(admin.status).toBe(400);
		});

		it("要「管理」范围：只读、编辑者列出、签发、吊销都是 403；项目令牌自己没有管理，不能管理项目令牌", async () => {
			const reader = await user("reader");
			await accounts.member("default", reader, "read_only");
			const editor = await user("editor1");
			await accounts.member("default", editor, "editor");
			const admin = await user("alice");
			await accounts.member("default", admin, "project_admin");
			const made = await projectOk(await login("alice", PASSWORD), "default", {
				name: "ci",
				scopes: ["read"],
			});
			for (const name of ["reader", "editor1"]) {
				const cookie = await login(name, PASSWORD);
				const list = await call(withCookie(cookie), "GET", "/projects/default/tokens");
				expect(list.status, `${name} 列出`).toBe(403);
				expect((await errorOf(list)).message).toContain("管理");
				const issue = await call(withCookie(cookie), "POST", "/projects/default/tokens", {
					name: "x",
					scopes: ["read"],
				});
				expect(issue.status, `${name} 签发`).toBe(403);
				const revoke = await call(
					withCookie(cookie),
					"DELETE",
					`/projects/default/tokens/${made.id}`,
				);
				expect(revoke.status, `${name} 吊销`).toBe(403);
			}
			// 项目令牌没有管理范围：不能列出、不能吊销。
			expect((await call(bearer(made.token), "GET", "/projects/default/tokens")).status).toBe(403);
			expect(
				(await call(bearer(made.token), "DELETE", `/projects/default/tokens/${made.id}`)).status,
			).toBe(403);
			// 没被吊销。
			expect((await call(bearer(made.token), "GET", "/orchestrations")).status).toBe(200);
		});

		it("令牌不能签发令牌：带「管理」范围的个人令牌可以列出和吊销项目令牌，但不能签发（403）", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "project_admin");
			const cookie = await login("alice", PASSWORD);
			const made = await projectOk(cookie, "default", { name: "ci", scopes: ["read"] });
			const personalToken = (await personalOk(cookie, { name: "我的", scopes: ["read", "manage"] }))
				.token;
			const issue = await call(bearer(personalToken), "POST", "/projects/default/tokens", {
				name: "套娃",
				scopes: ["read"],
			});
			expect(issue.status).toBe(403);
			expect(await errorOf(issue)).toMatchObject({ code: "forbidden" });
			expect(
				(await row("select count(*)::int as n from api_tokens where kind = 'project'")).n,
			).toBe(1);
			const list = await call(bearer(personalToken), "GET", "/projects/default/tokens");
			expect(list.status).toBe(200);
			expect(((await list.json()) as { tokens: Issued[] }).tokens.map((t) => t.id)).toEqual([
				made.id,
			]);
			const revoked = await call(
				bearer(personalToken),
				"DELETE",
				`/projects/default/tokens/${made.id}`,
			);
			expect(revoked.status).toBe(204);
			expect((await call(bearer(made.token), "GET", "/orchestrations")).status).toBe(401);
		});

		it("范围按签发的写：只读范围的项目令牌触发运行被拒绝，有「运行」范围的通过检查", async () => {
			const id = await user("alice");
			await accounts.member("default", id, "project_admin");
			const cookie = await login("alice", PASSWORD);
			const target = await scenario();
			const readOnly = await projectOk(cookie, "default", { name: "读", scopes: ["read"] });
			const runner = await projectOk(cookie, "default", { name: "跑", scopes: ["read", "run"] });
			const trigger = (token: string) =>
				call(bearer(token), "POST", `/orchestrations/${target}/runs`, { params: {} });
			const refused = await trigger(readOnly.token);
			expect(refused.status).toBe(403);
			expect((await errorOf(refused)).message).toContain("运行");
			expect((await trigger(runner.token)).status).not.toBe(403);
			// 没有「编辑」范围：不能新建场景。
			const create = await call(bearer(runner.token), "POST", "/orchestrations", { name: "x" });
			expect(create.status).toBe(403);
		});

		it("吊销、过期立即 401；再吊销是 204；令牌 ID 属于别的项目是 404，没有被吊销", async () => {
			await accounts.project("alpha");
			const id = await user("alice");
			await accounts.member("default", id, "project_admin");
			await accounts.member("alpha", id, "project_admin");
			const cookie = await login("alice", PASSWORD);
			const inDefault = await projectOk(cookie, "default", { name: "ci", scopes: ["read"] });
			const inAlpha = await projectOk(cookie, "alpha", { name: "ci", scopes: ["read"] });
			const short = await projectOk(cookie, "default", {
				name: "short",
				scopes: ["read"],
				expires_in_days: 1,
			});
			const use = (token: string) => call(bearer(token), "GET", "/orchestrations");
			expect((await use(inDefault.token)).status).toBe(200);
			const revoke = (project: string, tokenId: string) =>
				call(withCookie(cookie), "DELETE", `/projects/${project}/tokens/${tokenId}`);
			// 令牌 ID 在别的项目里：404，说法和不存在一样，没有被吊销。
			const wrongProject = await revoke("default", inAlpha.id);
			expect(wrongProject.status).toBe(404);
			expect(
				(await row("select revoked_at from api_tokens where id = $1", [inAlpha.id])).revoked_at,
			).toBeNull();
			expect((await revoke("default", "00000000-0000-4000-8000-000000000000")).status).toBe(404);
			// 吊销：立即 401；再吊销是 204。
			expect((await revoke("default", inDefault.id)).status).toBe(204);
			expect((await use(inDefault.token)).status).toBe(401);
			expect((await revoke("default", inDefault.id)).status).toBe(204);
			// 过期：到点立即 401。
			expect((await use(short.token)).status).toBe(200);
			clock.advance(DAY);
			expect((await use(short.token)).status).toBe(401);
			// 列出里带状态（推进了一天，登录的空闲期限过了，重新登录）。
			const fresh = await login("alice", PASSWORD);
			const { tokens } = (await (
				await call(withCookie(fresh), "GET", "/projects/default/tokens")
			).json()) as { tokens: Issued[] };
			expect(tokens.map((t) => [t.name, t.revoked_at !== null]).sort()).toEqual([
				["ci", true],
				["short", false],
			]);
			expect(tokens.find((t) => t.name === "short")?.expires_at).not.toBeNull();
		});

		it("限定了项目的令牌看不到别的项目：个人令牌限定在 alpha、alpha 的项目令牌，请求默认项目的资源和令牌接口都是 404", async () => {
			await accounts.project("alpha");
			const id = await user("alice");
			await accounts.member("default", id, "project_admin");
			await accounts.member("alpha", id, "project_admin");
			const cookie = await login("alice", PASSWORD);
			const target = await scenario();
			const limited = await personalOk(cookie, { name: "alpha 的", project: "alpha" });
			const inAlpha = await projectOk(cookie, "alpha", {
				name: "alpha 的",
				scopes: ["read", "run"],
			});
			const defaultToken = await projectOk(cookie, "default", { name: "d", scopes: ["read"] });
			for (const token of [limited.token, inAlpha.token]) {
				for (const [method, path, body] of [
					["GET", "/orchestrations", undefined],
					["GET", `/orchestrations/${target}`, undefined],
					["POST", `/orchestrations/${target}/runs`, { params: {} }],
					["POST", "/orchestrations", { name: "越界" }],
					["GET", "/projects/default/tokens", undefined],
					["DELETE", `/projects/default/tokens/${defaultToken.id}`, undefined],
				] as const) {
					const res = await call(bearer(token), method, path, body);
					expect(res.status, `${method} ${path}`).toBe(404);
					expect(await errorOf(res)).toMatchObject({ message: ACCESS_NOT_FOUND_MESSAGE });
				}
			}
			// 没有被动过：默认项目的令牌还有效，场景没有多出来。
			expect((await call(bearer(defaultToken.token), "GET", "/orchestrations")).status).toBe(200);
			expect(
				(await row("select revoked_at from api_tokens where id = $1", [defaultToken.id]))
					.revoked_at,
			).toBeNull();
			expect((await row("select count(*)::int as n from orchestrations")).n).toBe(1);
		});

		it("别的项目的管理员：项目甲的管理员签发、列出、吊销项目乙的令牌是 404；平台管理员不是成员也行，并留下记录", async () => {
			await accounts.project("alpha");
			await accounts.project("beta");
			const alice = await user("alice");
			await accounts.member("alpha", alice, "project_admin");
			const cookie = await login("alice", PASSWORD);
			const betaToken = await projectOk(adminCookie, "beta", { name: "b", scopes: ["read"] });
			for (const [method, path, body] of [
				["GET", "/projects/beta/tokens", undefined],
				["POST", "/projects/beta/tokens", { name: "越界", scopes: ["read"] }],
				["DELETE", `/projects/beta/tokens/${betaToken.id}`, undefined],
				["GET", "/projects/no-such-project/tokens", undefined],
				["POST", "/projects/no-such-project/tokens", { name: "x", scopes: ["read"] }],
			] as const) {
				const res = await call(withCookie(cookie), method, path, body);
				expect(res.status, `${method} ${path}`).toBe(404);
				expect(await errorOf(res)).toMatchObject({ message: ACCESS_NOT_FOUND_MESSAGE });
			}
			// 项目标识写法不对：404，不是 500。
			expect((await call(withCookie(cookie), "GET", "/projects/Not_A_Project/tokens")).status).toBe(
				404,
			);
			expect(
				(await row("select revoked_at from api_tokens where id = $1", [betaToken.id])).revoked_at,
			).toBeNull();
			// 平台管理员在不是成员的项目 beta 里签发：写操作留记录（谁、哪个接口、作用在哪个资源上）。
			const actions = await db.query(
				"select project_id, route, resource_kind, resource_id from platform_admin_actions order by at",
			);
			expect(actions.rows).toEqual([
				{
					project_id: "beta",
					route: "POST /projects/:project/tokens",
					resource_kind: "project",
					resource_id: "beta",
				},
			]);
		});

		it("两个项目各有各的令牌：列出只列这个项目的", async () => {
			await accounts.project("alpha");
			const id = await user("alice");
			await accounts.member("default", id, "project_admin");
			await accounts.member("alpha", id, "project_admin");
			const cookie = await login("alice", PASSWORD);
			const a = await projectOk(cookie, "default", { name: "d", scopes: ["read"] });
			const b = await projectOk(cookie, "alpha", { name: "a", scopes: ["read"] });
			const list = async (project: string) =>
				(
					(await (await call(withCookie(cookie), "GET", `/projects/${project}/tokens`)).json()) as {
						tokens: Issued[];
					}
				).tokens.map((t) => t.id);
			expect(await list("default")).toEqual([a.id]);
			expect(await list("alpha")).toEqual([b.id]);
			// 同名在不同项目里不冲突；同一个项目里冲突。
			expect(
				(
					await call(withCookie(cookie), "POST", "/projects/alpha/tokens", {
						name: "a",
						scopes: ["read"],
					})
				).status,
			).toBe(409);
			expect(
				(
					await call(withCookie(cookie), "POST", "/projects/alpha/tokens", {
						name: "d",
						scopes: ["read"],
					})
				).status,
			).toBe(201);
		});
	});
});
