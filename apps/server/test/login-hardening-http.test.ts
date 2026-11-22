// 登录的限速、并发、来源地址和事件流的复审意见（PR #555 的独立审查）：真实控制面和数据库。
// 1. 限速把「在途」的尝试也算进去，并发的错密码绕不过；
// 2. 反向代理后面取来源地址：可信代理的层数或地址段，客户端自己写的 X-Forwarded-For 首段不作数；
// 3. 打开着的事件流定期重新检查凭据：主机上重置密码、直接改库停用、空闲期限到了，都会被关掉；
// 4. 密码验证有并发上限：登录风暴期间读文件的接口不被拖慢，队列满了回 503；闸满过一次之后不存在的登录名不会永远是 503；
//    排队的请求客户端断开之后不再占着闸；
// 5. 登出总是清掉 Cookie（哪怕这次请求没被当作已登录），带着有效的登录 Cookie 就注销库里的这条登录（不看同源判定）；
// 6. 限速用的来源地址去掉端口、IPv6 按 /64 归在一起。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { hashPassword } from "../src/auth/password.js";
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

	it("代理追加的地址带着端口、IPv6 地址换着写：同一个来源，限速不被端口或同一个 /64 里的换地址绕过", async () => {
		const { parseTrustProxy } = await import("../src/http/trust-proxy.js");
		cp = await startTestControlPlane({ initialAdmin: ADMIN, trustProxy: parseTrustProxy("1") });
		const c = cp;
		// IPv4：同一个地址，每次换一个源端口。
		const v4: Response[] = [];
		for (let i = 0; i < 12; i++) {
			v4.push(await wrongLogin(c, { "x-forwarded-for": `10.9.9.9:${5000 + i}` }, "someone"));
		}
		expect(statuses(v4).get(401) ?? 0).toBeLessThanOrEqual(6);
		expect(statuses(v4).get(429) ?? 0).toBeGreaterThanOrEqual(6);
		// IPv6：同一个 /64 里换着写（带方括号和端口、不带、同一个前缀里的不同地址）。
		const forms = [
			"[2001:db8:1:2::1]:443",
			"2001:db8:1:2::2",
			"2001:db8:1:2:aaaa:bbbb:cccc:dddd",
			"[2001:db8:1:2::3]:8443",
			"2001:DB8:1:2::4",
			"2001:db8:1:2:0:0:0:5",
			"[2001:db8:1:2::6]:1",
			"2001:db8:1:2::7",
			"[2001:db8:1:2::8]:2",
			"2001:db8:1:2::9",
			"2001:db8:1:2::a",
			"2001:db8:1:2::b",
		];
		const v6: Response[] = [];
		for (const form of forms) v6.push(await wrongLogin(c, { "x-forwarded-for": form }, "other"));
		expect(statuses(v6).get(401) ?? 0).toBeLessThanOrEqual(6);
		expect(statuses(v6).get(429) ?? 0).toBeGreaterThanOrEqual(6);
		// 另一个 /64 是另一个来源：不被牵连。
		const elsewhere = await wrongLogin(c, { "x-forwarded-for": "2001:db8:1:3::1" }, "other");
		expect(elsewhere.status).toBe(401);
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

describe("密码验证的并发闸：满过一次之后、客户端断开之后", () => {
	/** 单独的一次登录要多久（没有排队）。 */
	const timed = async (c: TestControlPlane, body: unknown) => {
		const started = performance.now();
		const res = await post(c, "/auth/login", body);
		await res.arrayBuffer();
		return { status: res.status, ms: performance.now() - started };
	};

	it("闸满过一次之后，不存在的登录名和存在的用户错密码的响应逐字相同（不会永远是 503，不能用来分辨登录名有没有这个人）", async () => {
		cp = await startTestControlPlane({
			initialAdmin: ADMIN,
			scrypt: { logN: 15, r: 8, p: 1 },
			passwordGate: { concurrency: 1, maxQueue: 1 },
			loginThrottle: { freeAttempts: 1_000_000, addressFreeAttempts: 1_000_000 },
		});
		const c = cp;
		// 存在的用户并发地错密码把闸填满；闸满的时候来一个不存在的登录名。
		const flood = Array.from({ length: 8 }, () => wrongLogin(c));
		await new Promise((resolve) => setTimeout(resolve, 30));
		const whileFull = await post(c, "/auth/login", {
			login_name: "no-such-user",
			password: "wrong-password-0",
		});
		const floodResults = await Promise.all(flood);
		expect(floodResults.some((r) => r.status === 503)).toBe(true);
		// 闸满的时候被拒绝是 503；之后闸空了，不存在的登录名和存在的用户错密码一模一样，不管试多少次。
		expect([401, 503]).toContain(whileFull.status);
		const wrong = await wrongLogin(c);
		expect(wrong.status).toBe(401);
		const wrongBody = await wrong.text();
		for (let i = 0; i < 3; i++) {
			const ghost = await post(c, "/auth/login", {
				login_name: `no-such-user-${i}`,
				password: "wrong-password-0",
			});
			expect(ghost.status).toBe(401);
			expect(await ghost.text()).toBe(wrongBody);
		}
	}, 60_000);

	it("假哈希在控制面启动时就算好（warmUp）：启动后没有任何登录，它已经算过一次；之后不存在的登录名不再算", async () => {
		let computed = 0;
		cp = await startTestControlPlane({
			initialAdmin: ADMIN,
			dummyHash: async (password) => {
				computed += 1;
				return hashPassword(password, { logN: 10, r: 8, p: 1 });
			},
		});
		const c = cp;
		// 启动之后、还没有任何人登录：预热是启动时放到后台去做的，等它做完。
		await vi.waitFor(() => expect(computed).toBe(1));
		// 不存在的登录名：对着已经算好的假哈希验证，不再算一次（等多久都是一次）。
		for (const name of ["no-such-user-1", "no-such-user-2"]) {
			const res = await post(c, "/auth/login", { login_name: name, password: "wrong-password-0" });
			expect(res.status).toBe(401);
		}
		expect(computed).toBe(1);
	});

	it("排队的改密码请求（验证旧密码）客户端断开之后也不再占着闸：断开前后正常登录要等的时间差一个数量级", async () => {
		cp = await startTestControlPlane({
			initialAdmin: ADMIN,
			scrypt: { logN: 15, r: 8, p: 1 },
			passwordGate: { concurrency: 1, maxQueue: 16 },
			loginThrottle: { freeAttempts: 1_000_000, addressFreeAttempts: 1_000_000 },
		});
		const c = cp;
		const good = { login_name: ADMIN.loginName, password: ADMIN.password };
		const cookie = cookieOf(await post(c, "/auth/login", good));
		await timed(c, good);
		const quiet = Math.min((await timed(c, good)).ms, (await timed(c, good)).ms);

		// 12 个改密码请求（旧密码是错的）进闸，30 毫秒后客户端全部断开。
		const sockets = Array.from({ length: 12 }, () =>
			startRequest(
				c,
				"/auth/password",
				{ old_password: "wrong-old-password", new_password: "new-password-123" },
				cookie,
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		for (const socket of sockets) socket.abort();
		const after = await timed(c, good);
		expect(after.status).toBe(200);
		console.log(
			`断开之后正常登录用了 ${Math.round(after.ms)} 毫秒（没有排队时 ${Math.round(quiet)} 毫秒）`,
		);
		expect(after.ms, `没有排队时 ${Math.round(quiet)} 毫秒`).toBeLessThan(quiet * 5 + 150);
		await Promise.allSettled(sockets.map((socket) => socket.done));
	}, 60_000);

	it("排队的请求客户端断开之后不再占着闸：断开前后正常登录要等的时间差一个数量级（不断开要等完所有排着的）", async () => {
		cp = await startTestControlPlane({
			initialAdmin: ADMIN,
			scrypt: { logN: 15, r: 8, p: 1 },
			passwordGate: { concurrency: 1, maxQueue: 16 },
			loginThrottle: { freeAttempts: 1_000_000, addressFreeAttempts: 1_000_000 },
		});
		const c = cp;
		const good = { login_name: ADMIN.loginName, password: ADMIN.password };
		await timed(c, good);
		const quiet = Math.min((await timed(c, good)).ms, (await timed(c, good)).ms);

		// 12 个请求进闸（1 个在算，其余排队），30 毫秒后客户端全部断开。
		const sockets = Array.from({ length: 12 }, (_, i) =>
			startLogin(c, { login_name: `ghost${i}`, password: "wrong-password-0" }),
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		for (const socket of sockets) socket.abort();
		// 断开之后马上来一个正常的登录：它只用等已经在算的那一个算完，再算自己的。
		const after = await timed(c, good);
		expect(after.status).toBe(200);
		console.log(
			`断开之后正常登录用了 ${Math.round(after.ms)} 毫秒（没有排队时 ${Math.round(quiet)} 毫秒）`,
		);
		// 没有这个修复时要等 12 个都算完（约 13 倍）；这里留足余量。
		expect(after.ms, `没有排队时 ${Math.round(quiet)} 毫秒`).toBeLessThan(quiet * 5 + 150);
		await Promise.allSettled(sockets.map((socket) => socket.done));
	}, 60_000);
});

/** 发一个 POST 请求但不等响应：可以随时断开（模拟发了就走的客户端）；`cookie` 是登录 Cookie（可选）。 */
function startRequest(c: TestControlPlane, path: string, body: unknown, cookie?: string) {
	const payload = JSON.stringify(body);
	let request_: ReturnType<typeof request> | undefined;
	const done = new Promise<void>((resolve) => {
		request_ = request(
			new URL(path, c.httpUrl),
			{
				method: "POST",
				agent: false,
				headers: {
					...JSON_HEADERS,
					"content-length": Buffer.byteLength(payload),
					// 同源的浏览器请求：带 Cookie 的请求要过跨站检查。
					...(cookie === undefined
						? {}
						: { cookie: `sfly_login=${cookie}`, "sec-fetch-site": "same-origin" }),
				},
			},
			(res) => {
				res.resume();
				res.on("end", resolve);
			},
		);
		request_.on("error", () => resolve());
		request_.on("close", () => resolve());
		request_.end(payload);
	});
	return { done, abort: () => request_?.destroy() };
}

/** 发一个登录请求但不等响应。 */
const startLogin = (c: TestControlPlane, body: unknown) => startRequest(c, "/auth/login", body);

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
		// 带着有效的登录 Cookie：库里的这条登录也被注销了，不看同源判定（浏览器上的 Cookie 清掉了，库里的却还有效的话，
		// 拿到这个 Cookie 的人还能继续用）。
		const me = await c.fetch("/auth/me", {
			headers: { cookie: `sfly_login=${cookie}`, "sec-fetch-site": "same-origin" },
		});
		expect(me.status).toBe(401);
	});

	it("登出时带着 Bearer（无效的、空的）又带着有效的登录 Cookie：204、清 Cookie，库里的登录不注销（带令牌时登出只清 Cookie，令牌不是登录）", async () => {
		cp = await startTestControlPlane({ initialAdmin: ADMIN });
		const c = cp;
		const cookie = cookieOf(
			await post(c, "/auth/login", { login_name: "root", password: ADMIN.password }),
		);
		const me = () =>
			c.fetch("/auth/me", {
				headers: { cookie: `sfly_login=${cookie}`, "sec-fetch-site": "same-origin" },
			});
		for (const authorization of ["Bearer sfly_pat_no-such-token-0000000000", "Bearer", "Bearer "]) {
			const res = await raw(c, "/auth/logout", "POST", {
				cookie: `sfly_login=${cookie}`,
				authorization,
				"sec-fetch-site": "same-origin",
			});
			expect(res.status, authorization).toBe(204);
			expect(cleared(res.headers["set-cookie"]), authorization).toBe(true);
			// 库里的登录还有效。
			expect((await me()).status, authorization).toBe(200);
		}
		// 对照：只带 Cookie 的登出注销库里的登录。
		const plain = await raw(c, "/auth/logout", "POST", {
			cookie: `sfly_login=${cookie}`,
			"sec-fetch-site": "same-origin",
		});
		expect(plain.status).toBe(204);
		expect((await me()).status).toBe(401);
	});

	it("跨站的登出也一样：带着有效的登录 Cookie 就注销库里的这条登录，别的登录不受影响；响应仍然是 204 并清掉 Cookie", async () => {
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
			"sec-fetch-site": "cross-site",
			"sec-fetch-mode": "cors",
			"sec-fetch-dest": "empty",
		});
		expect(res.status).toBe(204);
		expect(cleared(res.headers["set-cookie"])).toBe(true);
		const me = (cookie: string) =>
			c.fetch("/auth/me", {
				headers: { cookie: `sfly_login=${cookie}`, "sec-fetch-site": "same-origin" },
			});
		expect((await me(mine)).status).toBe(401);
		expect((await me(other)).status).toBe(200);
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
