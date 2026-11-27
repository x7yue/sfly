// `CurrentUser.scopes`（#492 D）：控制台按它决定显示哪些操作（有「管理」才显示 Agent 的凭据和停用）。登录、`GET /auth/me`
// 给出这个用户此刻在默认项目里有的范围，算法和访问检查是同一个（`userScopes`）。页面显示与否和接口 200/403 要一致：
// 范围里有「管理」，管理类接口（停用 Agent）不是 403；没有，就是 403。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_ADMIN_SCOPES, ROLE_SCOPES, SCOPES, userScopes } from "../src/auth/scopes.js";
import { loginCookie, TestAccounts } from "./support/credentials.js";
import { FakeAgent } from "./support/fake-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const ADMIN = { loginName: "root", password: "admin-password-1", displayName: "管理员" };
const JSON_HEADERS = { "content-type": "application/json" };
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

describe("userScopes：范围的算法只有一份", () => {
	it("平台管理员有项目管理员的全部范围（不管是不是成员、是什么角色）；成员按角色；不是成员什么都没有", () => {
		const admin = { isPlatformAdmin: true };
		const person = { isPlatformAdmin: false };
		expect(userScopes(admin, null)).toEqual(PLATFORM_ADMIN_SCOPES);
		expect(userScopes(admin, "read_only")).toEqual(PLATFORM_ADMIN_SCOPES);
		expect(PLATFORM_ADMIN_SCOPES).toEqual(ROLE_SCOPES.project_admin);
		expect(userScopes(person, "project_admin")).toEqual(ROLE_SCOPES.project_admin);
		expect(userScopes(person, "editor")).toEqual(ROLE_SCOPES.editor);
		expect(userScopes(person, "read_only")).toEqual(["read"]);
		expect(userScopes(person, null)).toEqual([]);
		// 只有项目管理员（和平台管理员）有「管理」。
		for (const [role, scopes] of Object.entries(ROLE_SCOPES)) {
			expect((scopes as readonly string[]).includes("manage")).toBe(role === "project_admin");
		}
		expect(SCOPES).toContain("manage");
	});
});

describe("CurrentUser.scopes：登录和 GET /auth/me", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let probe: FakeAgent;
	beforeAll(async () => {
		cp = await startTestControlPlane({ initialAdmin: ADMIN });
		accounts = new TestAccounts(cp.database.url);
		// 管理类接口要有一台真的 Agent 可以操作，才分得出「过了检查」（204）和「没有这台」（404）。
		probe = await FakeAgent.connect(cp.grpcUrl, { name: "probe-agent" });
	});
	afterAll(async () => {
		await probe.disconnect();
		await accounts.close();
		await cp.close();
	});

	const cookieFor = (userId: string) => accounts.login(userId);
	const me = async (cookie: string) => {
		const res = await cp.fetch("/auth/me", { headers: loginCookie(cookie) });
		expect(res.status).toBe(200);
		return (await res.json()) as { scopes: string[]; is_platform_admin: boolean };
	};
	/**
	 * 管理类接口（恢复一台没有停用的 Agent：什么都不改）：范围够的是 204；范围不够的是 403，不是项目成员的是 404
	 * （不给不是成员的人确认有没有这个资源）。
	 */
	const manageStatus = async (cookie: string) =>
		(
			await cp.fetch("/agents/probe-agent/enable", {
				method: "POST",
				headers: { ...loginCookie(cookie), ...SAME_ORIGIN },
			})
		).status;

	it("四种人各一条，加上「不是成员」：页面显示与否和接口 200/403 一致", async () => {
		const mk = async (
			login: string,
			role: "project_admin" | "editor" | "read_only" | null,
			admin = false,
		) => {
			const id = await accounts.user(login, { admin });
			if (role !== null) await accounts.member("default", id, role);
			return cookieFor(id);
		};
		const cases = [
			{
				who: "项目管理员",
				cookie: await mk("pa", "project_admin"),
				scopes: ROLE_SCOPES.project_admin,
			},
			{ who: "编辑者", cookie: await mk("ed", "editor"), scopes: ROLE_SCOPES.editor },
			{ who: "只读成员", cookie: await mk("ro", "read_only"), scopes: ROLE_SCOPES.read_only },
			{
				who: "平台管理员（不是成员）",
				cookie: await mk("plat", null, true),
				scopes: PLATFORM_ADMIN_SCOPES,
			},
			{ who: "不是成员也不是平台管理员", cookie: await mk("nobody", null), scopes: [] },
		];
		for (const { who, cookie, scopes } of cases) {
			const current = await me(await cookie);
			expect(current.scopes, who).toEqual([...scopes]);
			const shows = current.scopes.includes("manage");
			const status = await manageStatus(await cookie);
			// 页面显示按钮的（范围里有「管理」）接口不拒绝；不显示的，接口也拒绝（403，不是成员是 404）。
			if (shows) expect(status, `${who}：页面显示按钮，接口应当 204`).toBe(204);
			else expect([403, 404], `${who}：页面不显示按钮，接口应当拒绝`).toContain(status);
		}
	});

	it("登录的响应也带范围（和 /auth/me 同一个）", async () => {
		const res = await cp.fetch("/auth/login", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ login_name: ADMIN.loginName, password: ADMIN.password }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { scopes: string[] };
		expect(body.scopes).toEqual([...PLATFORM_ADMIN_SCOPES]);
	});

	it("不缓存：角色变了，下一次读到的范围跟着变（降级之后没有「管理」，接口也是 403）", async () => {
		const id = await accounts.user("shifty");
		await accounts.member("default", id, "project_admin");
		const cookie = await cookieFor(id);
		expect((await me(cookie)).scopes).toContain("manage");
		expect(await manageStatus(cookie)).toBe(204);
		await accounts.member("default", id, "editor");
		expect((await me(cookie)).scopes).not.toContain("manage");
		expect(await manageStatus(cookie)).toBe(403);
		await accounts.removeMember("default", id);
		expect((await me(cookie)).scopes).toEqual([]);
		expect(await manageStatus(cookie)).toBe(404);
	});

	it("范围只在 CurrentUser 里：令牌页的「属于谁」和平台管理员看到的用户列表不带 scopes", async () => {
		const cookie = await cookieFor(await accounts.user("lister", { admin: true }));
		const users = (await (await cp.fetch("/users", { headers: loginCookie(cookie) })).json()) as {
			users: Array<Record<string, unknown>>;
		};
		expect(users.users.length).toBeGreaterThan(0);
		for (const user of users.users) expect(user).not.toHaveProperty("scopes");
		const tokens = (await (
			await cp.fetch("/account/tokens", { headers: loginCookie(cookie) })
		).json()) as { user: Record<string, unknown> };
		expect(tokens.user).not.toHaveProperty("scopes");
	});
});
