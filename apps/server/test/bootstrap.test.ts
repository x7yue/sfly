// 第一个管理员怎么来（ADR 0029「认证的几处细节」）：环境变量给出的初始管理员只在没有任何用户时生效；
// 控制面启动时有了用户就不再生成初始化码。直接在数据库上测启动时的那一步（bootstrapFirstAdmin）。
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccountService } from "../src/auth/accounts.js";
import { bootstrapFirstAdmin, parseInitialAdmin } from "../src/auth/bootstrap.js";
import { SETUP_CODE_FILE, SetupCode } from "../src/auth/setup-code.js";
import { type Database, openDatabase } from "../src/db/database.js";
import { ManualClock } from "./support/manual-clock.js";
import { makeTempDir } from "./support/temp-dir.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const SMALL = { logN: 10, r: 8, p: 1 } as const;

describe("初始管理员的环境变量", () => {
	it("两个都没设置：没有初始管理员；只设置一个、登录名不合规矩、密码太短都报错退出，不悄悄走初始化码", () => {
		expect(parseInitialAdmin({})).toBeUndefined();
		expect(parseInitialAdmin({ SFLY_ADMIN_LOGIN: "", SFLY_ADMIN_PASSWORD: "" })).toBeUndefined();
		expect(() => parseInitialAdmin({ SFLY_ADMIN_LOGIN: "root" })).toThrow(/要一起设置/);
		expect(() => parseInitialAdmin({ SFLY_ADMIN_PASSWORD: "long-enough-1" })).toThrow(/要一起设置/);
		expect(() =>
			parseInitialAdmin({ SFLY_ADMIN_LOGIN: "Root-1", SFLY_ADMIN_PASSWORD: "long-enough-1" }),
		).toThrow(/小写字母、数字和下划线/);
		expect(() =>
			parseInitialAdmin({ SFLY_ADMIN_LOGIN: "root", SFLY_ADMIN_PASSWORD: "short" }),
		).toThrow(/密码要 8–128/);
	});

	it("设置对了：登录名、密码、显示名（默认同登录名）", () => {
		expect(
			parseInitialAdmin({ SFLY_ADMIN_LOGIN: "root", SFLY_ADMIN_PASSWORD: "long-enough-1" }),
		).toEqual({ loginName: "root", password: "long-enough-1", displayName: undefined });
		expect(
			parseInitialAdmin({
				SFLY_ADMIN_LOGIN: "root",
				SFLY_ADMIN_PASSWORD: "long-enough-1",
				SFLY_ADMIN_DISPLAY_NAME: "管理员",
			}),
		).toMatchObject({ displayName: "管理员" });
	});

	it("显示名在读环境变量这一步不检查（升级前设过不合格的值的部署，库里已经有用户时不该因此起不来）：原样带出去，到建初始管理员时才查", () => {
		const env = (name: string) => ({
			SFLY_ADMIN_LOGIN: "root",
			SFLY_ADMIN_PASSWORD: "long-enough-1",
			SFLY_ADMIN_DISPLAY_NAME: name,
		});
		for (const name of [
			"老\u200b板",
			"老\u202e板",
			"老\n板",
			"x".repeat(200),
			"👩\u200d💻 程序员",
		]) {
			expect(parseInitialAdmin(env(name)), JSON.stringify(name)).toMatchObject({
				displayName: name,
			});
		}
	});
});

describe("启动时建第一个管理员（bootstrapFirstAdmin）", () => {
	let testDb: TestDatabase;
	let database: Database;
	let dataDir: string;
	let accounts: AccountService;
	let setupCode: SetupCode;
	const logged: string[] = [];

	beforeEach(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		dataDir = await makeTempDir("sfly-bootstrap-");
		const clock = new ManualClock();
		setupCode = new SetupCode(dataDir);
		accounts = new AccountService({ db: database.db, clock, setupCode, scrypt: SMALL });
		logged.length = 0;
	});
	afterAll(async () => {
		await database?.close();
		await testDb?.drop();
		await rm(dataDir, { recursive: true, force: true });
	});

	const run = (initialAdmin?: { loginName: string; password: string; displayName?: string }) =>
		bootstrapFirstAdmin({
			accounts,
			setupCode,
			initialAdmin,
			log: (message) => logged.push(message),
		});
	const users = async () => (await accounts.listUsers()).map((u) => u.loginName);

	it("没有用户、没有环境变量：生成初始化码并告诉运维（日志里有码和文件位置）", async () => {
		await run();
		const code = (await readFile(join(dataDir, SETUP_CODE_FILE), "utf8")).trim();
		expect(logged.join("\n")).toContain(code);
		expect(logged.join("\n")).toContain(join(dataDir, SETUP_CODE_FILE));
		expect(setupCode.verify(code)).toBe(true);
		expect(await users()).toEqual([]);
	});

	it("没有用户、给了环境变量：直接建出平台管理员，不生成初始化码，已有的码文件删掉", async () => {
		await run();
		expect(existsSync(join(dataDir, SETUP_CODE_FILE))).toBe(true);
		await run({ loginName: "root", password: "long-enough-1", displayName: "管理员" });
		expect(await users()).toEqual(["root"]);
		expect((await accounts.listUsers())[0]).toMatchObject({
			displayName: "管理员",
			isPlatformAdmin: true,
		});
		expect(existsSync(join(dataDir, SETUP_CODE_FILE))).toBe(false);
		expect(setupCode.active).toBe(false);
		const login = await accounts.login("root", "long-enough-1", "127.0.0.1");
		expect(login.ok).toBe(true);
	});

	it("已有用户时环境变量不生效：不建第二个管理员，不改已有用户的密码，日志里说忽略了；也不生成初始化码，旧的码文件删掉", async () => {
		await run({ loginName: "root", password: "long-enough-1" });
		await run({ loginName: "intruder", password: "another-pass-1" });
		expect(await users()).toEqual(["root"]);
		expect(logged.join("\n")).toContain("忽略 SFLY_ADMIN_LOGIN");
		expect((await accounts.login("intruder", "another-pass-1", "127.0.0.1")).ok).toBe(false);
		// 就算旧的码文件还在（上次启动时还没有用户），有了用户的这次启动把它删掉。
		await setupCode.issue();
		await run();
		expect(existsSync(join(dataDir, SETUP_CODE_FILE))).toBe(false);
		expect(setupCode.active).toBe(false);
	});

	it("没有用户、显示名不合格（和建用户、改显示名同一个检查）：不启动，没有建出用户；合格的（零宽连接符拼出的表情、波斯文）照常", async () => {
		for (const displayName of [
			"老\u200b板",
			"老\u202e板",
			"老\n板",
			"x".repeat(200),
			"老\u{e0067}板",
			"\u200d板",
		]) {
			await expect(
				run({ loginName: "root", password: "long-enough-1", displayName }),
				JSON.stringify(displayName),
			).rejects.toThrow(/SFLY_ADMIN_DISPLAY_NAME 不合规矩/);
			expect(await users()).toEqual([]);
		}
		// 报错说出第几个字符、哪个码位。
		await expect(
			run({ loginName: "root", password: "long-enough-1", displayName: "老\u200b板" }),
		).rejects.toThrow(/显示名的第 2 个字符是 U\+200B/);
		await run({ loginName: "root", password: "long-enough-1", displayName: "👩\u200d💻 程序员" });
		expect(await users()).toEqual(["root"]);
	});

	it("已经有用户时显示名不检查：升级前设过不合格的 SFLY_ADMIN_DISPLAY_NAME 的部署照常起来，日志里说忽略了环境变量", async () => {
		await run({ loginName: "root", password: "long-enough-1" });
		await expect(
			run({ loginName: "root", password: "long-enough-1", displayName: "老\u200b板" }),
		).resolves.toBeUndefined();
		expect(await users()).toEqual(["root"]);
		expect(logged.join("\n")).toContain("忽略 SFLY_ADMIN_LOGIN");
	});

	it("初始化码：大小写、连字符、空白不敏感；换新码后旧码作废；discard 之后一律不对", async () => {
		const first = await setupCode.issue();
		expect(setupCode.verify(first)).toBe(true);
		expect(setupCode.verify(first.toLowerCase().replaceAll("-", " "))).toBe(true);
		expect(setupCode.verify("")).toBe(false);
		const second = await setupCode.issue();
		expect(setupCode.verify(first)).toBe(false);
		expect(setupCode.verify(second)).toBe(true);
		await setupCode.discard();
		expect(setupCode.verify(second)).toBe(false);
	});
});
