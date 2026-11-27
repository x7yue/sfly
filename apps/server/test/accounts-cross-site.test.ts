// 跨站检查和跨项目（规格 #490 的验收标准）：登录 Cookie 是浏览器自动带上的凭据，只认同源的请求；
// 只是项目甲成员的用户登录后，用他的 Cookie 请求项目乙的资源被 #489 的检查拒绝。
// 没有登录的请求在 #494 之前照旧放行，所以「不被当作已登录」靠响应里能不能看到身份、
// 以及账号类接口（只认登录）是 401 来观察。
import { request } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAs, TestAccounts } from "./support/credentials.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const ADMIN = { loginName: "root", password: "admin-password-1", displayName: "管理员" };
const JSON_HEADERS = { "content-type": "application/json" };

async function loginCookie(cp: TestControlPlane, loginName: string, password: string) {
	const res = await cp.fetch("/auth/login", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ login_name: loginName, password }),
	});
	expect(res.status).toBe(200);
	return /sfly_login=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
}

/**
 * 用 node:http 直接发请求：Node 自带的 fetch（undici）会把 Sec-Fetch-Mode 改成它自己的值（cors），
 * 模拟不了浏览器的页面导航（Sec-Fetch-Mode: navigate）。
 */
function rawRequest(
	cp: TestControlPlane,
	path: string,
	headers: Record<string, string>,
	method = "GET",
): Promise<{ status: number; body: string }> {
	const url = new URL(path, cp.httpUrl);
	return new Promise((resolve, reject) => {
		const req = request(url, { method, headers }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				body += chunk;
			});
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

/** 一个浏览器会发的请求头：Sec-Fetch-* 随请求的来源而不同。 */
const browser = (
	cookie: string,
	site: Record<string, string>,
	extra: Record<string, string> = {},
) => ({ cookie: `sfly_login=${cookie}`, ...site, ...extra });
const sameOrigin = {
	"sec-fetch-site": "same-origin",
	"sec-fetch-mode": "cors",
	"sec-fetch-dest": "empty",
};
const crossSite = {
	"sec-fetch-site": "cross-site",
	"sec-fetch-mode": "cors",
	"sec-fetch-dest": "empty",
};
const sameSite = {
	"sec-fetch-site": "same-site",
	"sec-fetch-mode": "cors",
	"sec-fetch-dest": "empty",
};
const crossNavigation = {
	"sec-fetch-site": "cross-site",
	"sec-fetch-mode": "navigate",
	"sec-fetch-dest": "document",
};

describe("跨站检查：带 Cookie 的请求", () => {
	let cp: TestControlPlane;
	let cookie: string;

	beforeAll(async () => {
		cp = await startTestControlPlane({
			initialAdmin: ADMIN,
			publicHttpUrl: "https://sfly.example.com",
			sameOrigins: ["http://localhost:3000"],
		});
		cookie = await loginCookie(cp, "root", ADMIN.password);
	}, 60_000);
	afterAll(async () => {
		await cp.close();
	});

	const write = (headers: Record<string, string>, nickname?: string) =>
		cp.fetch("/orchestrations", {
			method: "POST",
			headers: {
				...JSON_HEADERS,
				...headers,
				...(nickname ? { ...actAs(nickname) } : {}),
			},
			body: JSON.stringify({ name: "场景" }),
		});
	it("同源的写请求正常：身份来自登录，不需要昵称请求头", async () => {
		const res = await write(browser(cookie, sameOrigin));
		expect(res.status).toBe(201);
	});

	it("Sec-Fetch-Site 是 cross-site 或 same-site 的写请求不被当作已登录：没有昵称就是 400 nickname_required", async () => {
		for (const site of [crossSite, sameSite]) {
			const res = await write(browser(cookie, site));
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({ error: { code: "nickname_required" } });
		}
	});

	it("Origin 是别的地址（浏览器没有发 Sec-Fetch-Site）：不被当作已登录；Origin 是公开地址：当作已登录", async () => {
		const evil = await write(browser(cookie, {}, { origin: "https://evil.example" }));
		expect(evil.status).toBe(400);
		const same = await write(browser(cookie, {}, { origin: "https://sfly.example.com" }));
		expect(same.status).toBe(201);
		// 开发时 vite 的地址也算同源。
		const vite = await write(browser(cookie, {}, { origin: "http://localhost:3000" }));
		expect(vite.status).toBe(201);
	});

	it("两个头都缺的写请求当作跨站：不被当作已登录", async () => {
		const res = await write(browser(cookie, {}));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "nickname_required" } });
	});

	it("被当作没有登录的写请求，带了昵称就是不带凭据的老样子（照旧放行，到 #494 才拒绝）：Cookie 没有给它任何权限", async () => {
		const res = await write(browser(cookie, crossSite), "某人");
		expect(res.status).toBe(201);
		const db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		try {
			// 创建的场景没有记用户 ID：Cookie 里的身份没有被采用。
			const rows = await db.query("select author_user_id from orchestration_versions");
			expect(rows.rows.every((r) => r.author_user_id === null)).toBe(true);
		} finally {
			await db.end();
		}
	});

	it("账号类接口只认登录：跨站带 Cookie 的 GET /auth/me 不是登录（401），同源是 200", async () => {
		expect((await cp.fetch("/auth/me", { headers: browser(cookie, sameOrigin) })).status).toBe(200);
		expect((await cp.fetch("/auth/me", { headers: browser(cookie, crossSite) })).status).toBe(401);
		expect((await cp.fetch("/auth/me", { headers: browser(cookie, sameSite) })).status).toBe(401);
		// 有副作用的账号接口：注销全部登录、管理账号，跨站一样不是登录。
		for (const [method, path] of [
			["POST", "/auth/logout-all"],
			["POST", "/users"],
		] as const) {
			const res = await cp.fetch(path, { method, headers: browser(cookie, crossSite) });
			expect(res.status, `${method} ${path}`).toBe(401);
		}
		// 登出不拒绝任何凭据，也不看同源判定：跨站的登出带着有效的登录 Cookie，库里的这条登录照样被注销
		// （浏览器上的 Cookie 无条件清掉；库里的登录留着有效，拿到这个 Cookie 的人还能继续用）。用另一条登录来试。
		// 其余的跨站请求都没有登出，这个 Cookie 还在用。
		expect((await cp.fetch("/auth/me", { headers: browser(cookie, sameOrigin) })).status).toBe(200);
		const other = await loginCookie(cp, "root", ADMIN.password);
		const logout = await cp.fetch("/auth/logout", {
			method: "POST",
			headers: browser(other, crossSite),
		});
		expect(logout.status).toBe(204);
		expect((await cp.fetch("/auth/me", { headers: browser(other, sameOrigin) })).status).toBe(401);
		expect((await cp.fetch("/auth/me", { headers: browser(cookie, sameOrigin) })).status).toBe(200);
	});

	it("跨站的页面导航 GET（从飞书卡片、别的内网站点点开日志或产物的链接）带着登录照常成功", async () => {
		const me = await rawRequest(cp, "/auth/me", browser(cookie, crossNavigation));
		expect(me.status).toBe(200);
		expect(JSON.parse(me.body)).toMatchObject({ login_name: "root" });
		// 同站（同一个公司域名下的别的内网站点）点开的链接也一样。
		const sameSiteNav = { ...crossNavigation, "sec-fetch-site": "same-site" };
		expect((await rawRequest(cp, "/auth/me", browser(cookie, sameSiteNav))).status).toBe(200);
	});

	it("跨站但不是页面导航的 GET（fetch、图片、iframe 里的导航）不被当作已登录", async () => {
		for (const headers of [
			crossSite,
			{ "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
			{ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
		]) {
			const res = await rawRequest(cp, "/auth/me", browser(cookie, headers));
			expect(res.status, JSON.stringify(headers)).toBe(401);
		}
	});

	it("有副作用的跨站请求就算是页面导航（表单提交）也不被当作已登录", async () => {
		// 登出不拒绝任何凭据（204，清掉 Cookie），也不看同源判定：带着有效的登录 Cookie，库里的这条登录照样被注销
		// （用另一条登录来试，这个 Cookie 留给下面的测试用）。
		const other = await loginCookie(cp, "root", ADMIN.password);
		const res = await rawRequest(cp, "/auth/logout", browser(other, crossNavigation), "POST");
		expect(res.status).toBe(204);
		expect((await cp.fetch("/auth/me", { headers: browser(other, sameOrigin) })).status).toBe(401);
		// 其余有副作用的账号接口：401。
		const logoutAll = await rawRequest(
			cp,
			"/auth/logout-all",
			browser(cookie, crossNavigation),
			"POST",
		);
		expect(logoutAll.status).toBe(401);
	});

	it("curl 之类不带 Sec-Fetch-Site 和 Origin 的 GET 带 Cookie 照常（只有有副作用的才当作跨站）", async () => {
		expect(
			(await cp.fetch("/auth/me", { headers: { cookie: `sfly_login=${cookie}` } })).status,
		).toBe(200);
	});
});

describe("CORS：永远不发 Access-Control-Allow-Credentials，允许 authorization 请求头", () => {
	let cp: TestControlPlane;
	beforeAll(async () => {
		cp = await startTestControlPlane();
	});
	afterAll(async () => {
		await cp.close();
	});

	it("预检的响应允许 authorization，没有 Allow-Credentials；普通响应也没有", async () => {
		const preflight = await cp.fetch("/orchestrations", {
			method: "OPTIONS",
			headers: {
				origin: "https://dash.example.com",
				"access-control-request-method": "GET",
				"access-control-request-headers": "authorization",
			},
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
		expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
			"authorization",
		);
		expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
		const normal = await cp.fetch("/health", { headers: { origin: "https://dash.example.com" } });
		expect(normal.headers.get("access-control-allow-credentials")).toBeNull();
		const login = await cp.fetch("/auth/status", {
			headers: { origin: "https://dash.example.com" },
		});
		expect(login.headers.get("access-control-allow-credentials")).toBeNull();
	});
});

describe("跨项目：只是项目甲成员的用户，他的 Cookie 请求项目乙的资源被拒绝", () => {
	let cp: TestControlPlane;
	let alphaCookie: string;
	let adminCookie: string;
	let alphaUser: string;
	let defaultScenario: string;
	let betaScenario: string;

	beforeAll(async () => {
		cp = await startTestControlPlane({ initialAdmin: ADMIN });
		const accounts = new TestAccounts(cp.database.url);
		try {
			await accounts.project("alpha");
			alphaUser = await accounts.user("alice", { displayName: "爱丽丝" });
			await accounts.member("alpha", alphaUser, "editor");
		} finally {
			await accounts.close();
		}
		// 登录走真实的接口：用户的密码要是 scrypt 存储串，直接让管理员建一个。
		adminCookie = await loginCookie(cp, "root", ADMIN.password);
		const made = await cp.fetch("/users", {
			method: "POST",
			headers: { ...JSON_HEADERS, ...browser(adminCookie, sameOrigin) },
			body: JSON.stringify({ login_name: "bob", display_name: "鲍勃", password: "bob-password-1" }),
		});
		const bob = ((await made.json()) as { id: string }).id;
		const accounts2 = new TestAccounts(cp.database.url);
		try {
			await accounts2.member("alpha", bob, "editor");
		} finally {
			await accounts2.close();
		}
		alphaCookie = await loginCookie(cp, "bob", "bob-password-1");
		// 默认项目里的场景（项目乙）；项目甲里的场景。
		const created = await cp.fetch("/orchestrations", {
			method: "POST",
			headers: { ...JSON_HEADERS, ...browser(adminCookie, sameOrigin) },
			body: JSON.stringify({ name: "默认项目的场景" }),
		});
		defaultScenario = ((await created.json()) as { id: string }).id;
		const db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		try {
			betaScenario = crypto.randomUUID();
			await db.query(
				"insert into orchestrations (id, project_id, name, head_version, created_at) values ($1, 'alpha', '项目甲的场景', 0, now())",
				[betaScenario],
			);
		} finally {
			await db.end();
		}
	}, 60_000);
	afterAll(async () => {
		await cp.close();
	});

	const as = (cookie: string, headers: Record<string, string> = sameOrigin) => ({
		headers: browser(cookie, headers),
	});

	it("项目甲的成员读不了默认项目的场景（404，不是 403），改也改不了；读得了项目甲自己的", async () => {
		const read = await cp.fetch(`/orchestrations/${defaultScenario}`, as(alphaCookie));
		expect(read.status).toBe(404);
		const patch = await cp.fetch(`/orchestrations/${defaultScenario}`, {
			method: "PATCH",
			headers: { ...JSON_HEADERS, ...browser(alphaCookie, sameOrigin) },
			body: JSON.stringify({ name: "改掉" }),
		});
		expect(patch.status).toBe(404);
		const own = await cp.fetch(`/orchestrations/${betaScenario}`, as(alphaCookie));
		expect(own.status).toBe(200);
		// 资源没有被改动。
		const untouched = await cp.fetch(`/orchestrations/${defaultScenario}`, as(adminCookie));
		expect(await untouched.json()).toMatchObject({ name: "默认项目的场景" });
	});

	it("跨站的页面导航带着登录：照样被项目的检查拒绝（导航不是绕过项目检查的口子）", async () => {
		const res = await rawRequest(
			cp,
			`/orchestrations/${defaultScenario}`,
			browser(alphaCookie, crossNavigation),
		);
		expect(res.status).toBe(404);
	});

	it("对照：同样的请求跨站 fetch 带 Cookie 不被当作已登录，在 #494 之前就是不带凭据的老样子（放行）；导航带着登录所以被拒绝", async () => {
		const asAnonymous = await cp.fetch(
			`/orchestrations/${defaultScenario}`,
			as(alphaCookie, crossSite),
		);
		expect(asAnonymous.status).toBe(200);
		const asLoggedIn = await rawRequest(
			cp,
			`/orchestrations/${defaultScenario}`,
			browser(alphaCookie, crossNavigation),
		);
		expect(asLoggedIn.status).toBe(404);
	});

	it("平台管理员停用他之后，他已有的登录立即失效", async () => {
		const bob = (
			(await (await cp.fetch("/users", as(adminCookie))).json()) as {
				users: { id: string; login_name: string }[];
			}
		).users.find((u) => u.login_name === "bob");
		expect(bob).toBeDefined();
		expect((await cp.fetch(`/orchestrations/${betaScenario}`, as(alphaCookie))).status).toBe(200);
		const disabled = await cp.fetch(`/users/${bob?.id}/disable`, {
			method: "POST",
			headers: browser(adminCookie, sameOrigin),
		});
		expect(disabled.status).toBe(200);
		const after = await cp.fetch(`/orchestrations/${betaScenario}`, as(alphaCookie));
		expect(after.status).toBe(401);
		expect((await cp.fetch("/auth/me", as(alphaCookie))).status).toBe(401);
	});
});
