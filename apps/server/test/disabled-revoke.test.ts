// 被停用的用户仍然能吊销自己的凭据（#578）：停用是可撤回的暂停，不是作废。停用期间他的登录、个人令牌对别的接口都拒绝，
// 要是连吊销也拒绝，想登出的人（脚本里的 `sfly logout`、停用之前开着的页面）吊销不了，启用之后这些凭据又能用了。
// 所以登出、注销全部登录、吊销个人令牌这三件事，在停用期间也认他自己的凭据；别的接口照旧一律 401。
// 真实控制面和数据库。
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bearer, loginCookie, TestAccounts } from "./support/credentials.js";
import type { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("停用期间吊销自己的凭据", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let db: pg.Client;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		accounts = new TestAccounts(cp.database.url);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
	});
	afterEach(async () => {
		await db.end();
		await accounts.close();
		await cp.close();
	});

	const call = (headers: Record<string, string>, method: string, path: string, body?: unknown) =>
		cp.fetch(path, {
			method,
			headers: {
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...headers,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const enable = (userId: string) =>
		db.query("update users set disabled_at = null where id = $1", [userId]);
	const revokedLogins = async (userId: string) =>
		(
			await db.query(
				"select count(*)::int as n from logins where user_id = $1 and revoked_at is not null",
				[userId],
			)
		).rows[0].n as number;
	const revokedTokens = async (userId: string) =>
		(
			await db.query(
				"select count(*)::int as n from api_tokens where user_id = $1 and revoked_at is not null",
				[userId],
			)
		).rows[0].n as number;

	it("登出（Cookie）：库里这一个登录被注销，启用之后这个 Cookie 还是不能用；别的登录不受影响", async () => {
		const alice = await accounts.user("alice");
		await accounts.member("default", alice, "editor");
		const first = await accounts.login(alice);
		const second = await accounts.login(alice);
		await accounts.disable(alice);
		// 停用期间别的接口照旧拒绝。
		expect((await call(loginCookie(first), "GET", "/auth/me")).status).toBe(401);

		const out = await call(loginCookie(first), "POST", "/auth/logout");
		expect(out.status).toBe(204);
		expect(await revokedLogins(alice)).toBe(1);

		await enable(alice);
		expect((await call(loginCookie(first), "GET", "/auth/me")).status).toBe(401);
		expect((await call(loginCookie(second), "GET", "/auth/me")).status).toBe(200);
	});

	it("注销全部登录：停用期间也行，启用之后一个都不能用；别人的登录不动", async () => {
		const alice = await accounts.user("alice");
		const bob = await accounts.user("bob");
		const a1 = await accounts.login(alice);
		const a2 = await accounts.login(alice);
		const b1 = await accounts.login(bob);
		await accounts.disable(alice);

		expect((await call(loginCookie(a1), "POST", "/auth/logout-all")).status).toBe(204);
		expect(await revokedLogins(alice)).toBe(2);
		expect(await revokedLogins(bob)).toBe(0);

		await enable(alice);
		for (const cookie of [a1, a2]) {
			expect((await call(loginCookie(cookie), "GET", "/auth/me")).status).toBe(401);
		}
		expect((await call(loginCookie(b1), "GET", "/auth/me")).status).toBe(200);
	});

	it("个人令牌吊销它自己（sfly logout）：停用期间也行，启用之后它不能用；同一个人的别的令牌不动", async () => {
		const alice = await accounts.user("alice");
		await accounts.member("default", alice, "editor");
		const token = await accounts.personalToken(alice);
		const other = await accounts.personalToken(alice);
		const id = await accounts.tokenId(token);
		await accounts.disable(alice);
		// 停用期间用它做别的事照旧 401。
		expect((await call(bearer(token), "GET", "/projects/default/orchestrations")).status).toBe(401);
		expect((await call(bearer(token), "GET", "/account/tokens")).status).toBe(401);

		expect((await call(bearer(token), "DELETE", `/account/tokens/${id}`)).status).toBe(204);
		expect(await revokedTokens(alice)).toBe(1);

		await enable(alice);
		expect((await call(bearer(token), "GET", "/projects/default/orchestrations")).status).toBe(401);
		expect((await call(bearer(other), "GET", "/projects/default/orchestrations")).status).toBe(200);
	});

	it("个人令牌只能吊销它自己：停用期间吊销别的令牌、注销全部登录一律 401（和已吊销的令牌分不出来），那个令牌没动", async () => {
		const alice = await accounts.user("alice");
		const token = await accounts.personalToken(alice);
		const other = await accounts.personalToken(alice);
		await accounts.disable(alice);
		const res = await call(
			bearer(token),
			"DELETE",
			`/account/tokens/${await accounts.tokenId(other)}`,
		);
		expect(res.status).toBe(401);
		expect((await call(bearer(token), "POST", "/auth/logout-all")).status).toBe(401);
		expect(await revokedTokens(alice)).toBe(0);
	});

	it("登录吊销自己名下的令牌：停用期间也行；别人的令牌是 404", async () => {
		const alice = await accounts.user("alice");
		const bob = await accounts.user("bob");
		const cookie = await accounts.login(alice);
		const mine = await accounts.personalToken(alice);
		const his = await accounts.personalToken(bob);
		await accounts.disable(alice);

		const refused = await call(
			loginCookie(cookie),
			"DELETE",
			`/account/tokens/${await accounts.tokenId(his)}`,
		);
		expect(refused.status).toBe(404);
		expect(await revokedTokens(bob)).toBe(0);
		const done = await call(
			loginCookie(cookie),
			"DELETE",
			`/account/tokens/${await accounts.tokenId(mine)}`,
		);
		expect(done.status).toBe(204);
		expect(await revokedTokens(alice)).toBe(1);
	});

	it("别的一律照旧拒绝：停用的用户用登录或令牌列令牌、签发、改密码、读场景都是 401；会话令牌、项目令牌不因此放行", async () => {
		const alice = await accounts.user("alice");
		await accounts.member("default", alice, "editor");
		const cookie = await accounts.login(alice);
		const token = await accounts.personalToken(alice);
		const session = await accounts.sessionToken(alice, "default");
		await accounts.disable(alice);
		const attempts: [string, Record<string, string>, string, string, unknown?][] = [
			["Cookie 列令牌", loginCookie(cookie), "GET", "/account/tokens"],
			["Cookie 签发", loginCookie(cookie), "POST", "/account/tokens", { name: "新的" }],
			[
				"Cookie 改密码",
				loginCookie(cookie),
				"POST",
				"/auth/password",
				{
					current_password: "x",
					new_password: "a-new-password-1",
				},
			],
			["Cookie 读场景", loginCookie(cookie), "GET", "/projects/default/orchestrations"],
			["令牌列令牌", bearer(token), "GET", "/account/tokens"],
			["令牌读场景", bearer(token), "GET", "/projects/default/orchestrations"],
			// 会话令牌的所有者被停用：不认（也不因为吊销接口放宽而变成 403 之类的另一种说法）。
			[
				"会话令牌吊销",
				bearer(session),
				"DELETE",
				`/account/tokens/${await accounts.tokenId(token)}`,
			],
		];
		for (const [what, headers, method, path, body] of attempts) {
			expect((await call(headers, method, path, body)).status, what).toBe(401);
		}
		expect(await revokedTokens(alice)).toBe(0);
	});

	it("停用期间吊销不会续期登录、也不记令牌的最后使用时间", async () => {
		const alice = await accounts.user("alice");
		const cookie = await accounts.login(alice);
		const token = await accounts.personalToken(alice);
		await accounts.disable(alice);
		// 距离上次使用已经过了续期的间隔：没停用的用户这时会顺延空闲期限、记最后使用时间。
		(cp.clock as ManualClock).advance(60 * 60_000);
		const before = (await db.query("select last_used_at from logins where user_id = $1", [alice]))
			.rows[0].last_used_at as Date;
		const res = await call(loginCookie(cookie), "POST", "/auth/logout-all");
		// 响应只清 Cookie，不是续期。
		expect(res.headers.get("set-cookie") ?? "").toMatch(
			/sfly_login=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i,
		);
		const after = (await db.query("select last_used_at from logins where user_id = $1", [alice]))
			.rows[0].last_used_at as Date;
		expect(after.getTime()).toBe(before.getTime());
		await call(bearer(token), "DELETE", `/account/tokens/${await accounts.tokenId(token)}`);
		const used = (
			await db.query(
				"select last_used_at from api_tokens where token_hash is not null and user_id = $1",
				[alice],
			)
		).rows[0].last_used_at;
		expect(used).toBeNull();
	});
});
