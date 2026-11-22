// 账号服务里限速、并发闸和登录标识的行为（PR #555 的独立审查，三处没有测试守着的和限速、并发闸的服务层测试）：
// - 被限速的请求不去验证密码（把限速挪到验证之后，这条会红）；
// - 并发的错密码放行的次数不超过限速允许的（失败等算完才记，这条会红）；
// - 算不过来被拒绝的尝试不算失败；
// - 每次登录签发新的、不同的标识（改成「用户 ID 加时间」，同一个时刻两次登录的标识相同，这条会红）；
// - 登录、初始化、改密码、建用户、重置密码都走同一个并发闸；
// - 并发闸满的那一刻第一次碰到不存在的登录名，之后闸空了，不存在的登录名和存在的用户错密码的结果逐字相同
//   （假哈希不缓存被闸拒绝的结果，不然不存在的登录名永远是 503，能用来分辨登录名有没有这个人）；
// - 排队中的请求，客户端断开（中止信号）之后不再占着闸，也把限速里的在途占位还回去。
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DbAccessStore } from "../src/auth/access-store.js";
import { AccountService } from "../src/auth/accounts.js";
import { hashCredential } from "../src/auth/credential-hash.js";
import { LoginThrottle } from "../src/auth/login-throttle.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { PasswordGate, PasswordGateAborted, PasswordGateBusy } from "../src/auth/password-gate.js";
import { SetupCode } from "../src/auth/setup-code.js";
import { type Database, openDatabase } from "../src/db/database.js";
import { ManualClock } from "./support/manual-clock.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const SMALL = { logN: 10, r: 8, p: 1 } as const;
const PASSWORD = "alice-password-1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("账号服务：限速、并发闸、登录标识", () => {
	let testDb: TestDatabase;
	let database: Database;
	let clock: ManualClock;
	let throttle: LoginThrottle;
	let verifyCalls: number;
	let dataDir: string;

	beforeEach(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		clock = new ManualClock();
		throttle = new LoginThrottle(clock);
		verifyCalls = 0;
		dataDir = await mkdtemp(join(tmpdir(), "sfly-throttle-"));
	});
	afterEach(async () => {
		await database?.close();
		await testDb?.drop();
		await rm(dataDir, { recursive: true, force: true });
	});

	/** 数着验证次数的账号服务；`delayMs` 让验证慢一点，并发的请求才会真的重叠。 */
	const service = (
		options: {
			delayMs?: number;
			/** 验证一直等到它完成：让一次验证占着闸，测试里想占多久占多久。 */
			hold?: Promise<void>;
			gate?: PasswordGate;
			setupCode?: SetupCode;
			/** 算假哈希用的函数（默认真的算）。 */
			dummyHash?: (password: string) => Promise<string>;
		} = {},
	) =>
		new AccountService({
			db: database.db,
			clock,
			scrypt: SMALL,
			throttle,
			...(options.gate ? { passwordGate: options.gate } : {}),
			...(options.setupCode ? { setupCode: options.setupCode } : {}),
			...(options.dummyHash ? { dummyHash: options.dummyHash } : {}),
			verify: async (password, stored) => {
				verifyCalls += 1;
				if (options.hold) await options.hold;
				if (options.delayMs) await sleep(options.delayMs);
				return verifyPassword(password, stored);
			},
		});
	const withAlice = async (accounts: AccountService) => {
		await accounts.createUser({
			loginName: "alice",
			displayName: "爱丽丝",
			password: PASSWORD,
			isPlatformAdmin: false,
		});
		return accounts;
	};

	it("被限速的请求不去验证密码：限速在验证之前，被限速之后验证的次数不再增加", async () => {
		const accounts = await withAlice(service());
		const results = [];
		for (let i = 0; i < 12; i++)
			results.push(await accounts.login("alice", "wrong-password-0", "10.0.0.1"));
		const invalid = results.filter((r) => !r.ok && r.reason === "invalid").length;
		const throttled = results.filter((r) => !r.ok && r.reason === "throttled").length;
		// 前 5 次失败不限制，第 6 次越线，之后全是 429；被限速的没有去验证。
		expect(invalid).toBe(6);
		expect(throttled).toBe(6);
		expect(verifyCalls).toBe(6);
		// 限速期间连对的密码也不放行、也不验证。
		const right = await accounts.login("alice", PASSWORD, "10.0.0.1");
		expect(right).toMatchObject({ ok: false, reason: "throttled" });
		expect(verifyCalls).toBe(6);
	});

	it("并发的错密码：放行（去验证）的不超过限速允许的次数，其余是限速", async () => {
		const accounts = await withAlice(service({ delayMs: 20 }));
		const results = await Promise.all(
			Array.from({ length: 40 }, () => accounts.login("alice", "wrong-password-0", "10.0.0.1")),
		);
		const invalid = results.filter((r) => !r.ok && r.reason === "invalid").length;
		expect(invalid).toBeLessThanOrEqual(6);
		expect(results.filter((r) => !r.ok && r.reason === "throttled")).toHaveLength(40 - invalid);
		expect(verifyCalls).toBe(invalid);
	});

	it("并发的尝试里夹着对的密码：对的成功并清零，不被同时在途的错密码拖进限速", async () => {
		const accounts = await withAlice(service({ delayMs: 10 }));
		const results = await Promise.all([
			accounts.login("alice", "wrong-password-0", "10.0.0.1"),
			accounts.login("alice", "wrong-password-0", "10.0.0.1"),
			accounts.login("alice", PASSWORD, "10.0.0.1"),
			accounts.login("alice", "wrong-password-0", "10.0.0.1"),
		]);
		expect(results.map((r) => r.ok)).toEqual([false, false, true, false]);
		for (let i = 0; i < 5; i++) {
			expect(await accounts.login("alice", "wrong-password-0", "10.0.0.1")).toMatchObject({
				reason: "invalid",
			});
		}
	});

	it("算不过来被拒绝（并发闸满了）：抛 PasswordGateBusy，不算失败的尝试，占的位还回去", async () => {
		const gate = new PasswordGate({ concurrency: 1, maxQueue: 0 });
		const accounts = await withAlice(service({ delayMs: 80, gate }));
		const first = accounts.login("alice", "wrong-password-0", "10.0.0.1");
		await sleep(20);
		await expect(accounts.login("alice", "wrong-password-0", "10.0.0.2")).rejects.toBeInstanceOf(
			PasswordGateBusy,
		);
		await first;
		// 被拒绝的那个（用户、地址）和地址整体都没有留下失败：10.0.0.2 上还能连着试到限速的次数。
		expect(throttle.retryAfterMs("alice", "10.0.0.2")).toBe(0);
		expect(throttle.retryAfterMs("someone", "10.0.0.2")).toBe(0);
		let invalid = 0;
		for (let i = 0; i < 6; i++) {
			const result = await accounts.login("alice", "wrong-password-0", "10.0.0.2");
			if (!result.ok && result.reason === "invalid") invalid++;
		}
		expect(invalid).toBe(6);
	});

	it("每次登录签发新的、不同的标识：同一个用户、同一个（手动）时刻登录两次，两个 Cookie 不同、两条登录都有效", async () => {
		const accounts = await withAlice(service());
		const first = await accounts.login("alice", PASSWORD, "10.0.0.1");
		const second = await accounts.login("alice", PASSWORD, "10.0.0.1");
		if (!first.ok || !second.ok) throw new Error("登录应该成功");
		expect(first.login.cookie).not.toBe(second.login.cookie);
		// 随机的：长度够，不是用户 ID 和时间拼出来的。
		for (const { login } of [first, second]) {
			expect(login.cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(login.cookie).not.toContain(login.user.id);
		}
		const store = new DbAccessStore(database.db);
		const a = await store.loginByCookieHash(hashCredential(first.login.cookie));
		const b = await store.loginByCookieHash(hashCredential(second.login.cookie));
		expect(a?.id).toBeDefined();
		expect(b?.id).toBeDefined();
		expect(a?.id).not.toBe(b?.id);
		expect([a?.revokedAt, b?.revokedAt]).toEqual([null, null]);
		// 一个登出，另一个不受影响。
		await accounts.logout(first.login.user.id, a?.id ?? "");
		expect(
			(await store.loginByCookieHash(hashCredential(first.login.cookie)))?.revokedAt,
		).not.toBeNull();
		expect(
			(await store.loginByCookieHash(hashCredential(second.login.cookie)))?.revokedAt,
		).toBeNull();
	});

	it("登录、初始化、改密码（验证旧密码、算新密码）、建用户、重置密码都走同一个并发闸", async () => {
		const gate = new PasswordGate();
		const spy = vi.spyOn(gate, "run");
		const setupCode = new SetupCode(dataDir);
		const code = await setupCode.issue();
		const accounts = service({ gate, setupCode });
		const calls = () => spy.mock.calls.length;

		// 初始化：算新管理员密码的哈希。
		const setup = await accounts.setup(
			{ code, loginName: "boss", displayName: "老板", password: "boss-password-1" },
			"10.0.0.1",
		);
		expect(setup.ok).toBe(true);
		expect(calls()).toBe(1);
		// 建用户、重置密码：各算一次哈希。
		const created = await accounts.createUser({
			loginName: "alice",
			displayName: "爱丽丝",
			password: PASSWORD,
			isPlatformAdmin: false,
		});
		expect(calls()).toBe(2);
		await accounts.resetPassword(created.id, "reset-password-1");
		expect(calls()).toBe(3);
		// 登录：验证一次；登录名不存在的也验证一次（对着假哈希验证）。假哈希本身只算一次、不过闸：
		// 闸满的那一刻它不能被拒绝（见下面「闸满过一次之后」那条）。
		await accounts.login("alice", "reset-password-1", "10.0.0.1");
		expect(calls()).toBe(4);
		await accounts.login("nobody", "x-password-1", "10.0.0.1");
		expect(calls()).toBe(5);
		await accounts.login("nobody", "x-password-1", "10.0.0.1");
		expect(calls()).toBe(6);
		// 改密码：验证旧密码一次，算新密码一次。
		const beforeChange = calls();
		const changed = await accounts.changePassword(
			created.id,
			randomUUID(),
			"reset-password-1",
			"another-password-2",
			"10.0.0.1",
		);
		expect(changed.ok).toBe(true);
		expect(calls()).toBe(beforeChange + 2);
	});

	it("闸满过一次之后：不存在的登录名和存在的用户错密码的结果逐字相同，不会永远是 503（假哈希不缓存被拒绝的结果）", async () => {
		const gate = new PasswordGate({ concurrency: 1, maxQueue: 0 });
		const release = deferred();
		const accounts = await withAlice(service({ hold: release.promise, gate }));
		// 一次验证占住闸；这时第一次碰到不存在的登录名：这一次没有去验证，503。
		const occupying = accounts.login("alice", "wrong-password-0", "10.0.0.1");
		await vi.waitFor(() => expect(gate.active).toBe(1));
		await expect(accounts.login("ghost", "wrong-password-0", "10.0.0.2")).rejects.toBeInstanceOf(
			PasswordGateBusy,
		);
		release.resolve();
		await occupying;
		// 闸空了：之后不存在的登录名得到的结果，和存在的用户错密码一模一样（同一个形状，连着几次都一样）。
		const wrongPassword = await accounts.login("alice", "wrong-password-0", "10.0.0.3");
		for (let i = 0; i < 3; i++) {
			const ghost = await accounts.login("ghost", "wrong-password-0", `10.0.1.${i}`);
			expect(ghost).toEqual(wrongPassword);
		}
		expect(wrongPassword).toEqual({ ok: false, reason: "invalid" });
	});

	it("假哈希算失败了也不缓存：下一次重新算，不会永远带着那次的失败", async () => {
		let calls = 0;
		const accounts = await withAlice(
			service({
				dummyHash: async (password) => {
					calls += 1;
					if (calls === 1) throw new Error("算假哈希时出错");
					return hashPassword(password, SMALL);
				},
			}),
		);
		await expect(accounts.login("ghost", "wrong-password-0", "10.0.0.1")).rejects.toThrow(
			"算假哈希时出错",
		);
		expect(await accounts.login("ghost", "wrong-password-0", "10.0.0.1")).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(calls).toBe(2);
	});

	it("排队中的登录请求，客户端断开之后：不去验证、抛 PasswordGateAborted，限速里的在途占位还回去", async () => {
		const gate = new PasswordGate({ concurrency: 1, maxQueue: 16 });
		const release = deferred();
		const accounts = await withAlice(service({ hold: release.promise, gate }));
		const occupying = accounts.login("alice", PASSWORD, "10.0.0.1");
		await vi.waitFor(() => expect(gate.active).toBe(1));
		const verifiedBefore = verifyCalls;
		// 8 个来源地址各排着一个错密码（每个地址只有一次尝试，限速不会先拦下它们），然后全部断开。
		const controllers = Array.from({ length: 8 }, () => new AbortController());
		const queued = controllers.map((controller, i) =>
			accounts.login("alice", `wrong-password-${i}`, `10.0.9.${i}`, controller.signal).then(
				() => "completed",
				(error: unknown) => error,
			),
		);
		await vi.waitFor(() => expect(gate.waiting).toBe(8));
		expect(gate.waiting).toBe(8);
		for (const controller of controllers) controller.abort();
		const outcomes = await Promise.all(queued);
		expect(outcomes.every((error) => error instanceof PasswordGateAborted)).toBe(true);
		expect(gate.waiting).toBe(0);
		release.resolve();
		await occupying;
		// 一次都没有验证；占的位都还了：断开的那个地址上还能连着试到限速的次数（断开的那一次不算失败，
		// 占位没还的话只能试 5 次）。
		expect(verifyCalls).toBe(verifiedBefore);
		for (let i = 0; i < 8; i++) expect(throttle.retryAfterMs("alice", `10.0.9.${i}`)).toBe(0);
		let invalid = 0;
		for (let i = 0; i < 6; i++) {
			const result = await accounts.login("alice", "wrong-password-0", "10.0.9.0");
			if (!result.ok && result.reason === "invalid") invalid++;
		}
		expect(invalid).toBe(6);
	});

	it("排队中的改密码请求（验证旧密码），客户端断开之后：同样不验证、把占位还回去", async () => {
		const gate = new PasswordGate({ concurrency: 1, maxQueue: 16 });
		const release = deferred();
		const accounts = await withAlice(service({ hold: release.promise, gate }));
		const id = (await accounts.findByLoginName("alice"))?.id ?? "";
		const occupying = accounts.login("alice", PASSWORD, "10.0.0.1");
		await vi.waitFor(() => expect(gate.active).toBe(1));
		const verifiedBefore = verifyCalls;
		const controller = new AbortController();
		const queued = accounts
			.changePassword(
				id,
				randomUUID(),
				"wrong-old-password",
				"new-password-123",
				"10.0.0.7",
				controller.signal,
			)
			.then(
				() => "completed",
				(error: unknown) => error,
			);
		await vi.waitFor(() => expect(gate.waiting).toBe(1));
		controller.abort();
		expect(await queued).toBeInstanceOf(PasswordGateAborted);
		release.resolve();
		await occupying;
		expect(verifyCalls).toBe(verifiedBefore);
		expect(throttle.retryAfterMs(`password:${id}`, "10.0.0.7")).toBe(0);
	});

	it("改密码：旧密码并发地猜也受限速（占位在验证之前）；旧密码对了之后限速清零", async () => {
		const accounts = await withAlice(service({ delayMs: 20 }));
		const id = (await accounts.findByLoginName("alice"))?.id ?? "";
		const results = await Promise.all(
			Array.from({ length: 30 }, () =>
				accounts.changePassword(
					id,
					randomUUID(),
					"wrong-old-password",
					"new-password-123",
					"10.0.0.1",
				),
			),
		);
		const wrong = results.filter((r) => !r.ok && r.reason === "wrong_password").length;
		expect(wrong).toBeLessThanOrEqual(6);
		expect(results.filter((r) => !r.ok && r.reason === "throttled")).toHaveLength(30 - wrong);
		expect(verifyCalls).toBe(wrong);
	});

	it("初始化码并发地猜也受限速：猜错的次数不超过限速允许的", async () => {
		const setupCode = new SetupCode(dataDir);
		await setupCode.issue();
		const accounts = service({ setupCode });
		const results = await Promise.all(
			Array.from({ length: 30 }, (_, i) =>
				accounts.setup(
					{
						code: `AAAA-BBBB-CCCC-DDDD-${String(1000 + i)}`,
						loginName: "boss",
						displayName: "老板",
						password: "boss-password-1",
					},
					"10.0.0.1",
				),
			),
		);
		const bad = results.filter((r) => !r.ok && r.reason === "bad_code").length;
		expect(bad).toBeLessThanOrEqual(6);
		expect(results.filter((r) => !r.ok && r.reason === "throttled")).toHaveLength(30 - bad);
	});
});
