// 密码、登录 Cookie、初始化码、密码哈希不进任何响应、不进报错（ADR 0029「认证的几处细节」，规格 #490）。
// 「按契约遍历每个出口」：契约里每个账号类接口都被请求过（成功的和失败的），所有响应的正文里找不到这些值；
// 登录 Cookie 只出现在登录和初始化响应的 Set-Cookie 头里，正文里也没有。新加的账号类接口没有被请求过，测试失败。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { httpContract } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SETUP_CODE_FILE } from "../src/auth/setup-code.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const JSON_HEADERS = { "content-type": "application/json" };
const ADMIN = { loginName: "root", password: "AdminSecret-1xyz" };

describe("账号类接口的出口里没有密码、Cookie、初始化码、哈希", () => {
	let cp: TestControlPlane;
	let setupCp: TestControlPlane;
	const requested = new Set<string>();
	const bodies: { what: string; status: number; text: string }[] = [];
	/** 这些值一旦出现在响应正文里就是泄露。 */
	const secrets = new Map<string, string>();

	const templateOf = (method: string, path: string): string | undefined => {
		const bare = path.split("?")[0] ?? path;
		return httpContract
			.filter((def) => def.method === method)
			.find((def) =>
				new RegExp(`^${def.path.replace(/:[A-Za-z]+/g, "[^/]+").replace(/\*$/, ".+")}$`).test(bare),
			)?.path;
	};

	const send = async (
		control: TestControlPlane,
		what: string,
		method: string,
		path: string,
		options: { cookie?: string; body?: unknown } = {},
	) => {
		const res = await control.fetch(path, {
			method,
			headers: {
				...(options.body === undefined ? {} : JSON_HEADERS),
				...(options.cookie ? { cookie: `sfly_login=${options.cookie}` } : {}),
				"sec-fetch-site": "same-origin",
			},
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
		});
		const template = templateOf(method, path);
		if (template) requested.add(`${method} ${template}`);
		bodies.push({ what, status: res.status, text: await res.clone().text() });
		return res;
	};
	const cookieOf = (res: Response) =>
		/sfly_login=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";

	beforeAll(async () => {
		cp = await startTestControlPlane({ initialAdmin: ADMIN });
		secrets.set("管理员密码", ADMIN.password);
		const login = await send(cp, "登录", "POST", "/auth/login", {
			body: { login_name: ADMIN.loginName, password: ADMIN.password },
		});
		const adminCookie = cookieOf(login);
		secrets.set("管理员的 Cookie", adminCookie);

		// 失败的登录：密码、登录名写进请求里，响应里不能有它们。
		secrets.set("猜的密码", "Guess-Secret-Pass-77");
		await send(cp, "登录：密码不对", "POST", "/auth/login", {
			body: { login_name: ADMIN.loginName, password: "Guess-Secret-Pass-77" },
		});
		await send(cp, "登录：没有这个用户", "POST", "/auth/login", {
			body: { login_name: "nobody", password: "Guess-Secret-Pass-77" },
		});
		await send(cp, "登录：请求不合格", "POST", "/auth/login", { body: { login_name: "" } });
		await send(cp, "当前用户", "GET", "/auth/me", { cookie: adminCookie });
		await send(cp, "当前用户：没登录", "GET", "/auth/me");
		await send(cp, "状态", "GET", "/auth/status");

		// 建用户：合格的、密码太短（zod 的 issues 会进 details）、登录名不合规矩、重名。
		secrets.set("新用户的密码", "XiaomingSecret-1abc");
		await send(cp, "建用户", "POST", "/users", {
			cookie: adminCookie,
			body: { login_name: "xiaoming", display_name: "小明", password: "XiaomingSecret-1abc" },
		});
		secrets.set("太短的密码", "short1");
		await send(cp, "建用户：密码太短", "POST", "/users", {
			cookie: adminCookie,
			body: { login_name: "tooshort", display_name: "短", password: "short1" },
		});
		secrets.set("登录名不合规矩时的密码", "BadNameSecret-9zzz");
		await send(cp, "建用户：登录名不合规矩", "POST", "/users", {
			cookie: adminCookie,
			body: { login_name: "Bad-Name", display_name: "x", password: "BadNameSecret-9zzz" },
		});
		secrets.set("重名时的密码", "DuplicateSecret-5ddd");
		await send(cp, "建用户：重名", "POST", "/users", {
			cookie: adminCookie,
			body: { login_name: "xiaoming", display_name: "又一个", password: "DuplicateSecret-5ddd" },
		});
		const list = await send(cp, "用户列表", "GET", "/users", { cookie: adminCookie });
		const users = ((await list.clone().json()) as { users: { id: string; login_name: string }[] })
			.users;
		const xiaoming = users.find((u) => u.login_name === "xiaoming")?.id ?? "";
		expect(xiaoming).not.toBe("");

		// 小明登录、改密码（旧密码不对、对）、注销。
		const xLogin = await send(cp, "小明登录", "POST", "/auth/login", {
			body: { login_name: "xiaoming", password: "XiaomingSecret-1abc" },
		});
		const xCookie = cookieOf(xLogin);
		secrets.set("小明的 Cookie", xCookie);
		secrets.set("小明猜的旧密码", "WrongOldSecret-3eee");
		await send(cp, "改密码：旧密码不对", "POST", "/auth/password", {
			cookie: xCookie,
			body: { old_password: "WrongOldSecret-3eee", new_password: "NewSecret-4fffgg" },
		});
		secrets.set("小明的新密码", "NewSecret-4fffgg");
		await send(cp, "改密码", "POST", "/auth/password", {
			cookie: xCookie,
			body: { old_password: "XiaomingSecret-1abc", new_password: "NewSecret-4fffgg" },
		});
		await send(cp, "改密码：新密码太短", "POST", "/auth/password", {
			cookie: xCookie,
			body: { old_password: "NewSecret-4fffgg", new_password: "tiny" },
		});
		await send(cp, "注销全部登录", "POST", "/auth/logout-all", { cookie: xCookie });
		const again = await send(cp, "小明再登录", "POST", "/auth/login", {
			body: { login_name: "xiaoming", password: "NewSecret-4fffgg" },
		});
		await send(cp, "登出", "POST", "/auth/logout", { cookie: cookieOf(again) });

		// 管理员停用、恢复、重置密码、不能对自己做的事。
		secrets.set("管理员重置的密码", "ResetSecret-6hhhii");
		await send(cp, "停用", "POST", `/users/${xiaoming}/disable`, { cookie: adminCookie });
		await send(cp, "恢复", "POST", `/users/${xiaoming}/enable`, { cookie: adminCookie });
		await send(cp, "重置密码", "POST", `/users/${xiaoming}/password`, {
			cookie: adminCookie,
			body: { password: "ResetSecret-6hhhii" },
		});
		await send(cp, "重置密码：没有这个用户", "POST", `/users/${crypto.randomUUID()}/password`, {
			cookie: adminCookie,
			body: { password: "ResetSecret-6hhhii" },
		});
		const me = (await (
			await send(cp, "当前用户（取 ID）", "GET", "/auth/me", { cookie: adminCookie })
		).json()) as {
			id: string;
		};
		await send(cp, "停用自己", "POST", `/users/${me.id}/disable`, { cookie: adminCookie });
		await send(cp, "重置自己的密码", "POST", `/users/${me.id}/password`, {
			cookie: adminCookie,
			body: { password: "ResetSecret-6hhhii" },
		});

		// 初始化：另起一个空库，初始化码、新管理员的密码。
		setupCp = await startTestControlPlane();
		const code = (await readFile(join(setupCp.dataDir, SETUP_CODE_FILE), "utf8")).trim();
		secrets.set("初始化码", code);
		secrets.set("初始化时的密码", "SetupSecret-8jjjkk");
		await send(setupCp, "状态：要初始化", "GET", "/auth/status");
		await send(setupCp, "初始化：码不对", "POST", "/auth/setup", {
			body: {
				setup_code: "AAAA-BBBB-CCCC-DDDD-EEEE",
				login_name: "boss",
				display_name: "老板",
				password: "SetupSecret-8jjjkk",
			},
		});
		const setup = await send(setupCp, "初始化", "POST", "/auth/setup", {
			body: {
				setup_code: code,
				login_name: "boss",
				display_name: "老板",
				password: "SetupSecret-8jjjkk",
			},
		});
		secrets.set("初始化后的 Cookie", cookieOf(setup));
		await send(setupCp, "初始化：已经有用户", "POST", "/auth/setup", {
			body: {
				setup_code: code,
				login_name: "boss2",
				display_name: "老板二",
				password: "SetupSecret-8jjjkk",
			},
		});
	}, 120_000);

	afterAll(async () => {
		await cp?.close();
		await setupCp?.close();
	});

	it("成功的、被拒绝的（400、401、403、404、409）响应都出现过：测的确实是失败的响应", () => {
		const statuses = new Set(bodies.map((b) => b.status));
		for (const status of [200, 201, 204, 400, 401, 403, 404, 409]) {
			expect([...statuses], `没有出现过 ${status}`).toContain(status);
		}
	});

	it("所有响应的正文里没有密码、Cookie 的值、初始化码", () => {
		expect(secrets.size).toBeGreaterThan(10);
		for (const { what, text } of bodies) {
			for (const [name, value] of secrets) {
				expect(text.includes(value), `「${what}」的响应里有${name}`).toBe(false);
			}
		}
	});

	it("所有响应的正文里没有密码哈希（scrypt 存储串）、盐、哈希的字段名", () => {
		for (const { what, text } of bodies) {
			expect(text, what).not.toMatch(/scrypt\$/);
			expect(text, what).not.toMatch(/password_hash|cookie_hash|token_hash/);
		}
	});

	it("用户和当前用户的响应只有约定的字段", async () => {
		const login = await cp.fetch("/auth/login", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ login_name: ADMIN.loginName, password: ADMIN.password }),
		});
		expect(Object.keys((await login.json()) as object).sort()).toEqual([
			"display_name",
			"id",
			"is_platform_admin",
			"login_name",
		]);
	});

	it("契约里每个账号类接口都被请求过（新加的账号类接口要在上面造它的成功和失败请求）", () => {
		const accountRoutes = httpContract
			.filter((def) => def.resource.kind === "account")
			.map((def) => `${def.method} ${def.path}`);
		expect(accountRoutes.filter((key) => !requested.has(key))).toEqual([]);
	});
});
