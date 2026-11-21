// 登录的限速、并发、来源地址和事件流的复审意见（PR #555 的独立审查）：真实控制面和数据库。
// 1. 限速把「在途」的尝试也算进去，并发的错密码绕不过；
// 2. 反向代理后面取来源地址：可信代理的层数或地址段，客户端自己写的 X-Forwarded-For 首段不作数；
// 3. 打开着的事件流定期重新检查凭据：主机上重置密码、直接改库停用、空闲期限到了，都会被关掉；
// 4. 密码验证有并发上限：登录风暴期间读文件的接口不被拖慢，队列满了回 503；
// 5. 登出总是清掉 Cookie（哪怕这次请求没被当作已登录）。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { runResetPassword } from "../src/auth/reset-password-cli.js";
import { loginCookie, TestAccounts } from "./support/credentials.js";
import type { ManualClock } from "./support/manual-clock.js";
import { seedTask } from "./support/seed-task.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const ADMIN = { loginName: "root", password: "admin-password-1" };
const JSON_HEADERS = { "content-type": "application/json" };

let cp: TestControlPlane | undefined;
afterEach(async () => {
	await cp?.close();
	cp = undefined;
});

const post = (
	c: TestControlPlane,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
) =>
	c.fetch(path, {
		method: "POST",
		headers: { ...JSON_HEADERS, ...headers },
		body: JSON.stringify(body),
	});
const wrongLogin = (
	c: TestControlPlane,
	headers: Record<string, string> = {},
	name = ADMIN.loginName,
) => post(c, "/auth/login", { login_name: name, password: "wrong-password-0" }, headers);
const cookieOf = (res: Response) =>
	/sfly_login=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
const statuses = (responses: Response[]) => {
	const counts = new Map<number, number>();
	for (const res of responses) counts.set(res.status, (counts.get(res.status) ?? 0) + 1);
	return counts;
};

describe("登录限速：在途的尝试也算（并发绕不过）", () => {
	it("同一个登录名、同一个来源地址并发 40 次错密码：放行的不超过限速允许的次数，其余是 429", async () => {
		cp = await startTestControlPlane({ initialAdmin: ADMIN });
		const results = await Promise.all(
			Array.from({ length: 40 }, () => wrongLogin(cp as TestControlPlane)),
		);
		const counts = statuses(results);
		// 前 5 次失败不限制，第 6 次起要等：并发的也一样，最多放行 6 次（5 次免费加越线的那一次）。
		expect(counts.get(401) ?? 0).toBeLessThanOrEqual(6);
		expect(counts.get(429) ?? 0).toBeGreaterThanOrEqual(34);
		expect([...counts.keys()].sort()).toEqual([401, 429]);
	});

	it("并发的错密码里夹着对的密码：对的那一次成功，不被在途的计数拖进限速", async () => {
		cp = await startTestControlPlane({ initialAdmin: ADMIN });
		const c = cp;
		const results = await Promise.all([
			wrongLogin(c),
			wrongLogin(c),
			post(c, "/auth/login", { login_name: ADMIN.loginName, password: ADMIN.password }),
			wrongLogin(c),
		]);
		expect(results.map((r) => r.status)).toEqual([401, 401, 200, 401]);
		// 成功之后这个（用户、地址）清零：又能试 5 次。
		for (let i = 0; i < 5; i++) expect((await wrongLogin(c)).status).toBe(401);
	});
});

describe("反向代理后面的来源地址（SFLY_TRUST_PROXY）", () => {
	/** 模拟代理：客户端自己写的首段是伪造的，代理在后面追加它看到的真实地址。 */
	const forged = (i: number) => ({ "x-forwarded-for": `198.51.100.${i % 250}, 203.0.113.9` });

	it("信任一层代理：取代理追加的那个地址，客户端自带的首段不改变限速用的地址", async () => {
		const { parseTrustProxy } = await import("../src/http/trust-proxy.js");
		cp = await startTestControlPlane({ initialAdmin: ADMIN, trustProxy: parseTrustProxy("1") });
		const c = cp;
		const results: Response[] = [];
		for (let i = 0; i < 12; i++) results.push(await wrongLogin(c, forged(i)));
		const counts = statuses(results);
		expect(counts.get(401) ?? 0).toBeLessThanOrEqual(6);
		expect(counts.get(429) ?? 0).toBeGreaterThanOrEqual(6);
	});

	it("信任代理的地址段：同样取代理追加的那个地址", async () => {
		const { parseTrustProxy } = await import("../src/http/trust-proxy.js");
		cp = await startTestControlPlane({
			initialAdmin: ADMIN,
			trustProxy: parseTrustProxy("127.0.0.1,::1,::ffff:127.0.0.1"),
		});
		const c = cp;
		const results: Response[] = [];
		for (let i = 0; i < 12; i++) results.push(await wrongLogin(c, forged(i)));
		expect(statuses(results).get(429) ?? 0).toBeGreaterThanOrEqual(6);
	});

	it("没有配置：X-Forwarded-For 不作数，来源地址是 TCP 对端；换着写首段也绕不过", async () => {
		cp = await startTestControlPlane({ initialAdmin: ADMIN });
		const c = cp;
		const results: Response[] = [];
		for (let i = 0; i < 12; i++) results.push(await wrongLogin(c, forged(i)));
		expect(statuses(results).get(429) ?? 0).toBeGreaterThanOrEqual(6);
	});

	it("配了地址段、但直连的对端不在段里：X-Forwarded-For 不作数（直连的客户端伪造不了来源）", async () => {
		const { parseTrustProxy } = await import("../src/http/trust-proxy.js");
		cp = await startTestControlPlane({
			initialAdmin: ADMIN,
			trustProxy: parseTrustProxy("10.99.0.0/16"),
		});
		const c = cp;
		const results: Response[] = [];
		for (let i = 0; i < 12; i++) results.push(await wrongLogin(c, forged(i)));
		expect(statuses(results).get(429) ?? 0).toBeGreaterThanOrEqual(6);
	});
});

describe("打开着的事件流定期重新检查凭据", () => {
	const waitEnded = (stream: SseClient, timeout = 5000) =>
		vi.waitFor(() => expect(stream.ended).toBe(true), { timeout });

	async function setup() {
		cp = await startTestControlPlane({ initialAdmin: ADMIN, streamRecheckMs: 100 });
		const c = cp;
		const login = async (name: string, password: string) =>
			cookieOf(await post(c, "/auth/login", { login_name: name, password }));
		const admin = await login(ADMIN.loginName, ADMIN.password);
		// 两个编辑者（不是项目的成员，读运行的事件流会是 404）。
		const accounts = new TestAccounts(c.database.url);
		for (const name of ["xiaoming", "xiaohong"]) {
			const made = await post(
				c,
				"/users",
				{ login_name: name, display_name: name, password: "user-password-1" },
				loginCookie(admin),
			);
			expect(made.status).toBe(201);
			await accounts.member("default", ((await made.json()) as { id: string }).id, "editor");
		}
		await accounts.close();
		const { run } = await seedTask(c, { agent: "agent-a", status: "running" });
		const open = async (cookie: string) => {
			const stream = await SseClient.open(c, `/runs/${run}/events`, loginCookie(cookie));
			await stream.next("time");
			return stream;
		};
		return { c, login, open, admin };
	}
	const db = async (c: TestControlPlane) => {
		const client = new pg.Client({ connectionString: c.database.url });
		await client.connect();
		return client;
	};

	it("主机上的 reset-password 命令（另一个进程，控制面收不到通知）：他的流在间隔内被关，别人的流不受影响", async () => {
		const { c, login, open } = await setup();
		const mine = await open(await login("xiaoming", "user-password-1"));
		const theirs = await open(await login("xiaohong", "user-password-1"));
		const out = new Writable({ write: (_chunk, _encoding, done) => done() });
		const code = await runResetPassword(["xiaoming", "--password-stdin"], {
			databaseUrl: c.database.url,
			stdin: Readable.from(["brand-new-pass-1\n"]),
			stdinIsTty: false,
			stdout: out,
			stderr: out,
			scrypt: { logN: 10, r: 8, p: 1 },
		});
		expect(code).toBe(0);
		await waitEnded(mine);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(theirs.ended).toBe(false);
		theirs.close();
	});

	it("直接改库：停用、吊销登录，他的流在间隔内被关", async () => {
		const { c, login, open } = await setup();
		const disabled = await open(await login("xiaoming", "user-password-1"));
		const revoked = await open(await login("xiaohong", "user-password-1"));
		const client = await db(c);
		try {
			await client.query("update users set disabled_at = now() where login_name = 'xiaoming'");
			await client.query(
				"update logins set revoked_at = now() where user_id = (select id from users where login_name = 'xiaohong')",
			);
		} finally {
			await client.end();
		}
		await waitEnded(disabled);
		await waitEnded(revoked);
	});

	it("空闲期限到了：登录没人用着，流在间隔内被关；用着的（登录被续期）不关", async () => {
		const { c, login, open } = await setup();
		const clock = c.clock as ManualClock;
		const idle = await open(await login("xiaoming", "user-password-1"));
		clock.advance(13 * 3_600_000);
		await waitEnded(idle);
	});

	it("停用后再启用：没被吊销的登录恢复可用，新打开的流不会被关（停用是可撤回的暂停）", async () => {
		const { c, login, open, admin } = await setup();
		const cookie = await login("xiaoming", "user-password-1");
		const client = await db(c);
		const id = (await client.query("select id from users where login_name = 'xiaoming'")).rows[0]
			.id as string;
		await client.end();
		const first = await open(cookie);
		expect((await post(c, `/users/${id}/disable`, {}, loginCookie(admin))).status).toBe(200);
		await waitEnded(first);
		expect((await post(c, `/users/${id}/enable`, {}, loginCookie(admin))).status).toBe(200);
		const again = await open(cookie);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(again.ended).toBe(false);
		again.close();
	});
});

describe("密码验证的并发上限", () => {
	it("登录风暴期间读文件的接口不被拖慢（真实的 scrypt 参数，限速放开，只看并发闸）", async () => {
		// 读文件的接口：下载 SDK 的 wheel，每次请求都从磁盘读（走 libuv 的线程池，和 scrypt 同一个）。
		const dir = await mkdtemp(join(tmpdir(), "sfly-storm-"));
		const wheel = `sfly-${packageJson.version}-py3-none-any.whl`;
		await writeFile(join(dir, wheel), "wheel".repeat(1000));
		try {
			cp = await startTestControlPlane({
				initialAdmin: ADMIN,
				sdkWheelDir: dir,
				scrypt: { logN: 16, r: 8, p: 2 },
				loginThrottle: { freeAttempts: 1_000_000, addressFreeAttempts: 1_000_000 },
			});
			const c = cp;
			const readFile = async () => {
				const started = performance.now();
				const res = await c.fetch(`/sdk/python/${packageJson.version}/${wheel}`);
				expect(res.status).toBe(200);
				await res.arrayBuffer();
				return performance.now() - started;
			};
			// 先量一下没有风暴时读文件的接口要多久。
			await readFile();
			const quiet = Math.max(await readFile(), await readFile(), await readFile());
			expect(quiet).toBeLessThan(200);
			// 风暴：一百多个并发登录，各用不同的登录名（不存在的用户也要验证一次假哈希）。分几批发出，免得把监听的积压队列挤爆。
			const storm: Promise<number>[] = [];
			for (let wave = 0; wave < 6; wave++) {
				for (let i = 0; i < 20; i++) {
					storm.push(
						post(c, "/auth/login", {
							login_name: `user${wave}x${i}`,
							password: "wrong-password-0",
						}).then(
							(r) => r.status,
							() => 0,
						),
					);
				}
				await new Promise((resolve) => setTimeout(resolve, 15));
			}
			const latencies: number[] = [];
			const deadline = Date.now() + 2500;
			while (Date.now() < deadline) {
				latencies.push(await readFile());
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const codes = await Promise.all(storm);
			const slowest = Math.max(...latencies);
			console.log(
				`登录风暴期间读文件的接口：最慢 ${Math.round(slowest)} 毫秒（没有风暴时 ${Math.round(quiet)} 毫秒）`,
			);
			// 没有闸时读文件的接口排在一百多个 scrypt 后面（几秒到十几秒）；有闸时只和两个并发的哈希抢线程池。
			expect(slowest, `读文件的接口最慢 ${Math.round(slowest)} 毫秒`).toBeLessThan(1000);
			// 满了的直接拒绝（503），不是 401：没有去算哈希。
			expect(new Set(codes).has(503)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);

	it("队列满了：直接回 503，带 Retry-After 和说明；被拒绝的不记限速（不算失败的尝试）", async () => {
		cp = await startTestControlPlane({
			initialAdmin: ADMIN,
			scrypt: { logN: 15, r: 8, p: 1 },
			passwordGate: { concurrency: 1, maxQueue: 1 },
		});
		const c = cp;
		const responses = await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				post(c, "/auth/login", { login_name: `user${i}`, password: "wrong-password-0" }),
			),
		);
		const busy = responses.filter((r) => r.status === 503);
		expect(busy.length).toBeGreaterThanOrEqual(1);
		for (const res of busy) {
			expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
			expect(await res.json()).toMatchObject({ error: { code: "server_busy" } });
		}
		// 没有哪个被拒绝的请求是 401（401 是算过哈希的）以外的别的状态。
		expect(new Set(responses.map((r) => r.status))).toEqual(new Set([401, 503]));
		// 等闸空下来之后，被拒绝的登录名没有留下失败记录：用对的密码照常登录。
		const ok = await post(c, "/auth/login", {
			login_name: ADMIN.loginName,
			password: ADMIN.password,
		});
		expect(ok.status).toBe(200);
	}, 60_000);
});

/** 用 node:http 发请求：Node 自带的 fetch 会改 Sec-Fetch-* 头，这里要模拟没有这些头的浏览器（http 加 IP 访问）。 */
function raw(
	c: TestControlPlane,
	path: string,
	method: string,
	headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
	return new Promise((resolve, reject) => {
		const req = request(new URL(path, c.httpUrl), { method, headers }, (res) => {
			res.resume();
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
		});
		req.on("error", reject);
		req.end();
	});
}

describe("登出总是清掉 Cookie", () => {
	const cleared = (setCookie: string | string[] | undefined) => {
		const text = [setCookie ?? ""].flat().join("\n");
		return /sfly_login=;/.test(text) && /(Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(text);
	};

	it("没有被当作已登录的登出（浏览器没发 Sec-Fetch-*、Origin 对不上公开地址）：204，Cookie 照样被清掉", async () => {
		cp = await startTestControlPlane({
			initialAdmin: ADMIN,
			publicHttpUrl: "http://sfly.example:8080",
		});
		const c = cp;
		const cookie = cookieOf(
			await post(c, "/auth/login", { login_name: "root", password: ADMIN.password }),
		);
		// 内网用 http 加 IP 访问：浏览器不发 Sec-Fetch-Site，Origin 是页面实际的地址，和公开地址对不上。
		const res = await raw(c, "/auth/logout", "POST", {
			cookie: `sfly_login=${cookie}`,
			origin: "http://10.1.2.3:8080",
		});
		expect(res.status).toBe(204);
		expect(cleared(res.headers["set-cookie"])).toBe(true);
	});

	it("没有 Cookie、Cookie 已经失效的登出：也是 204 并清掉 Cookie（登出是幂等的）", async () => {
		cp = await startTestControlPlane({ initialAdmin: ADMIN });
		const c = cp;
		const none = await raw(c, "/auth/logout", "POST", { "sec-fetch-site": "same-origin" });
		expect(none.status).toBe(204);
		expect(cleared(none.headers["set-cookie"])).toBe(true);
		const stale = await raw(c, "/auth/logout", "POST", {
			cookie: "sfly_login=no-such-login",
			"sec-fetch-site": "same-origin",
		});
		expect(stale.status).toBe(204);
		expect(cleared(stale.headers["set-cookie"])).toBe(true);
	});

	it("同源的登出照常注销这个登录（库里吊销），Cookie 清掉；别的登录不受影响", async () => {
		cp = await startTestControlPlane({ initialAdmin: ADMIN });
		const c = cp;
		const mine = cookieOf(
			await post(c, "/auth/login", { login_name: "root", password: ADMIN.password }),
		);
		const other = cookieOf(
			await post(c, "/auth/login", { login_name: "root", password: ADMIN.password }),
		);
		const res = await raw(c, "/auth/logout", "POST", {
			cookie: `sfly_login=${mine}`,
			"sec-fetch-site": "same-origin",
		});
		expect(res.status).toBe(204);
		expect(cleared(res.headers["set-cookie"])).toBe(true);
		const me = (cookie: string) => c.fetch("/auth/me", { headers: loginCookie(cookie) });
		expect((await me(mine)).status).toBe(401);
		expect((await me(other)).status).toBe(200);
	});
});

describe("登录状态里带出控制面认的公开地址（浏览器据此提示「请用 … 打开」）", () => {
	it("配了公开地址：带出它（原样，去掉末尾的斜杠）和控制面看到的 Host；不带凭据就能读", async () => {
		cp = await startTestControlPlane({
			initialAdmin: ADMIN,
			publicHttpUrl: "http://sfly.example:8080/",
		});
		const res = await cp.fetch("/auth/status");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			setup_required: false,
			public_url: "http://sfly.example:8080",
			request_host: new URL(cp.httpUrl).host,
		});
	});

	it("没配公开地址：public_url 是 null，只带控制面看到的 Host（跨站检查用 Host 兜底）", async () => {
		cp = await startTestControlPlane({ initialAdmin: ADMIN });
		const res = await cp.fetch("/auth/status", { headers: { host: "sfly.internal:8080" } });
		expect(await res.json()).toMatchObject({
			public_url: null,
			request_host: expect.any(String),
		});
		const raw = await cp.fetch("/auth/status");
		expect(((await raw.json()) as { request_host: string }).request_host).toBe(
			new URL(cp.httpUrl).host,
		);
	});
});
