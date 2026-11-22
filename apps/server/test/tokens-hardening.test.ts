// 令牌的几处收紧（规格 #491 的独立审查）：
// - `Authorization` 头里有我们的令牌、写法却不是 `Bearer <令牌>`：401 并说明写法，不当作没带凭据照旧放行；
// - 令牌名称拒绝控制字符；
// - 请求日志把地址里长得像令牌的值盖住（客户端把令牌放进查询参数时），请求头不进日志，5xx 的错误日志也是；
// - 打开着的事件流定期重新检查凭据：令牌过期了、令牌所属的用户在库里被停用了（没有经过接口），流也会关掉。
// 真实控制面和数据库。
import { Writable } from "node:stream";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bearer, loginCookie, TestAccounts } from "./support/credentials.js";
import type { ManualClock } from "./support/manual-clock.js";
import { seedTask } from "./support/seed-task.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const ADMIN = { loginName: "root", password: "admin-password-1" };
const JSON_HEADERS = { "content-type": "application/json" };
const DAY = 86_400_000;

describe("令牌的几处收紧", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let db: pg.Client;
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
		// 打开的事件流每 0.2 秒重新检查一次凭据（默认 30 秒）。
		cp = await startTestControlPlane({
			initialAdmin: ADMIN,
			logger: { stream },
			streamRecheckMs: 200,
		});
		accounts = new TestAccounts(cp.database.url);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		const login = await cp.fetch("/auth/login", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ login_name: ADMIN.loginName, password: ADMIN.password }),
		});
		adminCookie = /sfly_login=([^;]*)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
	});
	afterEach(async () => {
		await db.end();
		await accounts.close();
		await cp.close();
	});

	const call = (headers: Record<string, string>, method: string, path: string, body?: unknown) =>
		cp.fetch(path, {
			method,
			headers: { ...(body === undefined ? {} : JSON_HEADERS), ...headers },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const issue = async (body: Record<string, unknown>) => {
		const res = await call(loginCookie(adminCookie), "POST", "/account/tokens", body);
		expect(res.status, await res.clone().text()).toBe(201);
		return (await res.json()) as { id: string; token: string };
	};
	const errorOf = async (res: Response) =>
		((await res.json()) as { error: { code: string; message: string } }).error;

	describe("Authorization 头写错了写法", () => {
		it("头里有我们的令牌、却不是 Bearer 写法：401，说明正确的写法；写操作也不会以匿名身份成功", async () => {
			const { token } = await issue({ name: "脚本" });
			const wrong = [
				token, // 直接放原值
				`token ${token}`,
				`Token ${token}`,
				`Bearer: ${token}`,
				`Bearer${token}`,
				`Basic ${token}`,
			];
			for (const authorization of wrong) {
				const read = await call({ authorization }, "GET", "/orchestrations");
				expect(read.status, authorization.slice(0, 20)).toBe(401);
				expect((await errorOf(read)).message).toContain("Bearer <令牌>");
				// 带着昵称的写：以前会以匿名（昵称）身份写成功。
				const write = await call(
					{ authorization, "x-sfly-nickname": encodeURIComponent("脚本") },
					"POST",
					"/orchestrations",
					{ name: "不该建出来" },
				);
				expect(write.status, authorization.slice(0, 20)).toBe(401);
			}
			expect((await db.query("select count(*)::int as n from orchestrations")).rows[0].n).toBe(0);
			// 回复里不带请求头的原值。
			const echoed = JSON.stringify(
				await errorOf(await call({ authorization: token }, "GET", "/orchestrations")),
			);
			expect(echoed).not.toContain(token);
		});

		it("正确的 Bearer 写法照常（大小写不敏感、多个空格）；和我们无关的方案（Basic 带别的内容、空头）照旧当作没带", async () => {
			const { token } = await issue({ name: "脚本" });
			for (const authorization of [`Bearer ${token}`, `bearer ${token}`, `BEARER   ${token}`]) {
				expect((await call({ authorization }, "GET", "/orchestrations")).status).toBe(200);
			}
			// 前面有反向代理做基本认证的部署：Authorization 是 Basic，里面没有我们的令牌，不能被挡。
			const basic = `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`;
			expect((await call({ authorization: basic }, "GET", "/orchestrations")).status).toBe(200);
			expect((await call({ authorization: "" }, "GET", "/orchestrations")).status).toBe(200);
		});

		it("登录、初始化状态、健康检查本来就不看凭据：写错的头不挡它们；系统接口同样", async () => {
			const { token } = await issue({ name: "脚本" });
			const authorization = `token ${token}`;
			expect((await call({ authorization }, "GET", "/health")).status).toBe(200);
			expect((await call({ authorization }, "GET", "/auth/status")).status).toBe(200);
			const login = await call({ authorization }, "POST", "/auth/login", {
				login_name: ADMIN.loginName,
				password: ADMIN.password,
			});
			expect(login.status).toBe(200);
			// 需要凭据的账号类接口：401。
			expect((await call({ authorization }, "GET", "/account/tokens")).status).toBe(401);
		});

		it("Agent 凭据和别的前缀也一样认得出", async () => {
			const agent = await accounts.agentCredential("default", "agent-a");
			const session = await accounts.sessionToken(await accounts.user("alice"), "default");
			for (const secret of [agent, session]) {
				const res = await call({ authorization: secret }, "GET", "/orchestrations");
				expect(res.status).toBe(401);
			}
		});
	});

	describe("项目令牌记着签发人，不随签发人失效", () => {
		it("列表和签发的响应里带签发人的显示名；签发人在库里被停用之后令牌照样有效，列表里还是他；个人令牌不记签发人", async () => {
			// 第二个平台管理员签发项目令牌：他之后被停用。
			const boss = await accounts.user("boss", { admin: true, displayName: "老板" });
			const bossToken = await accounts.login(boss);
			const issued = await call(loginCookie(bossToken), "POST", "/projects/default/tokens", {
				name: "自动化",
				scopes: ["read"],
			});
			expect(issued.status, await issued.clone().text()).toBe(201);
			const created = (await issued.json()) as { token: string; issued_by: string | null };
			expect(created.issued_by).toBe("老板");

			const list = async () =>
				(
					(await (
						await call(loginCookie(adminCookie), "GET", "/projects/default/tokens")
					).json()) as { tokens: { name: string; issued_by: string | null }[] }
				).tokens;
			expect(await list()).toEqual([
				expect.objectContaining({ name: "自动化", issued_by: "老板" }),
			]);

			await db.query("update users set disabled_at = now() where id = $1", [boss]);
			// 项目令牌属于项目：签发人被停用，它照样有效；记录还在。
			expect((await call(bearer(created.token), "GET", "/orchestrations")).status).toBe(200);
			expect(await list()).toEqual([
				expect.objectContaining({ name: "自动化", issued_by: "老板" }),
			]);
			expect(
				(await db.query("select issued_by_user_id from api_tokens where name = '自动化'")).rows[0]
					.issued_by_user_id,
			).toBe(boss);

			// 个人令牌：签发人就是所属用户，不另记。
			const personal = await issue({ name: "我的" });
			const row = (
				await db.query("select issued_by_user_id from api_tokens where id = $1", [personal.id])
			).rows[0];
			expect(row.issued_by_user_id).toBeNull();
			const own = (await (await call(bearer(personal.token), "GET", "/account/tokens")).json()) as {
				tokens: { issued_by: string | null }[];
			};
			expect(own.tokens.every((t) => t.issued_by === null)).toBe(true);
		});
	});

	describe("令牌名称", () => {
		it("换行、制表符、转义序列（ESC）、DEL、NUL、行分隔符都拒绝（400），没有签出令牌；正常的名字（含中文、空格、emoji）可以", async () => {
			for (const name of [
				"带\n换行",
				"带\r回车",
				"带\t制表符",
				"\u001b[31m红色\u001b[0m",
				"带\u007fDEL",
				"带\u0000NUL",
				"带 行分隔符",
				"带\u0085下一行",
			]) {
				const personal = await call(loginCookie(adminCookie), "POST", "/account/tokens", { name });
				expect(personal.status, JSON.stringify(name)).toBe(400);
				const project = await call(loginCookie(adminCookie), "POST", "/projects/default/tokens", {
					name,
					scopes: ["read"],
				});
				expect(project.status, JSON.stringify(name)).toBe(400);
			}
			expect((await db.query("select count(*)::int as n from api_tokens")).rows[0].n).toBe(0);
			for (const name of ["我的电脑 2", "ci-main", "笔记本 💻", "a·b"]) {
				const res = await call(loginCookie(adminCookie), "POST", "/account/tokens", { name });
				expect(res.status, name).toBe(201);
			}
		});
	});

	describe("请求日志", () => {
		it("令牌放进了查询参数：地址在日志里被盖住，原值不在日志里", async () => {
			const { token } = await issue({ name: "脚本" });
			await call({}, "GET", `/orchestrations?token=${token}&x=1`);
			await call({}, "GET", `/runs?api_key=${token}`);
			await vi.waitFor(() => expect(logs.join("")).toContain("/orchestrations?token="));
			const output = logs.join("");
			expect(output).not.toContain(token);
			expect(output).toContain("******");
			// 别的查询参数照常。
			expect(output).toContain("x=1");
		});

		it("请求头不进日志：500 的错误日志里没有 Authorization 头和令牌", async () => {
			const { token } = await issue({ name: "脚本" });
			// 让场景的读出错（列改名，查询语句报错）：访问检查读的是令牌、用户、成员，先过得去，处理函数里才 500。
			await db.query("alter table orchestrations rename column name to name_moved");
			const res = await call(bearer(token), "GET", "/orchestrations");
			expect(res.status).toBe(500);
			await vi.waitFor(() => expect(logs.join("")).toContain("Failed query"));
			const output = logs.join("");
			expect(output).not.toContain(token);
			expect(output.toLowerCase()).not.toContain("authorization");
			expect(output.toLowerCase()).not.toContain("bearer");
		});
	});

	describe("打开的事件流定期重新检查凭据", () => {
		const waitEnded = (stream: SseClient) =>
			vi.waitFor(() => expect(stream.ended).toBe(true), { timeout: 5000 });
		const open = async (token: string) => {
			const { run } = await seedTask(cp, { agent: "agent-a", status: "running" });
			return SseClient.open(cp, `/runs/${run}/events`, bearer(token));
		};

		it("令牌过期了：用它打开的流关掉（没有谁吊销它，过期靠这一遍检查）；别的令牌的流不受影响", async () => {
			const short = await issue({ name: "短命", expires_in_days: 1 });
			const long = await issue({ name: "长命", expires_in_days: 30 });
			const streamShort = await open(short.token);
			const streamLong = await open(long.token);
			await streamShort.next("time");
			await streamLong.next("time");
			(cp.clock as ManualClock).advance(2 * DAY);
			await waitEnded(streamShort);
			expect(streamLong.ended).toBe(false);
		});

		it("令牌所属的用户在库里被停用（没有经过停用接口，没有广播）：他的令牌打开的流关掉", async () => {
			const id = await accounts.user("alice");
			await accounts.member("default", id, "editor");
			const token = await accounts.personalToken(id);
			const other = await accounts.user("bob");
			await accounts.member("default", other, "editor");
			const otherToken = await accounts.personalToken(other);
			const stream = await open(token);
			const otherStream = await open(otherToken);
			await stream.next("time");
			await otherStream.next("time");
			await db.query("update users set disabled_at = now() where id = $1", [id]);
			await waitEnded(stream);
			expect(otherStream.ended).toBe(false);
		});
	});
});
