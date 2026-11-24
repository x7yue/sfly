// 主机上的重置命令（ADR 0029「认证的几处细节」）：管理员忘了密码时，在控制面所在的主机上执行
// `node main.mjs reset-password <登录名>`：能登录主机就已经是最高权限。直接测命令本身（不起控制面）。
import { Readable, Writable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccountService } from "../src/auth/accounts.js";
import { type ResetPasswordIo, runResetPassword } from "../src/auth/reset-password-cli.js";
import { type Database, openDatabase } from "../src/db/database.js";
import { ManualClock } from "./support/manual-clock.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const SMALL = { logN: 10, r: 8, p: 1 } as const;

describe("reset-password 命令", () => {
	let testDb: TestDatabase;
	let database: Database;
	let accounts: AccountService;

	beforeEach(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		accounts = new AccountService({ db: database.db, clock: new ManualClock(), scrypt: SMALL });
		await accounts.createUser({
			loginName: "root",
			displayName: "管理员",
			password: "old-password-1",
			isPlatformAdmin: true,
		});
	});
	afterAll(async () => {
		await database?.close();
		await testDb?.drop();
	});

	const capture = () => {
		const out: string[] = [];
		const err: string[] = [];
		const sink = (lines: string[]) =>
			new Writable({
				write(chunk, _encoding, done) {
					lines.push(String(chunk));
					done();
				},
			});
		return { out, err, stdout: sink(out), stderr: sink(err) };
	};
	const io = (
		stdin: string | undefined,
		extra: Partial<ResetPasswordIo> = {},
	): ResetPasswordIo & { out: string[]; err: string[] } => {
		const cap = capture();
		return {
			databaseUrl: testDb.url,
			stdin: Readable.from(stdin === undefined ? [] : [stdin]),
			stdinIsTty: false,
			stdout: cap.stdout,
			stderr: cap.stderr,
			scrypt: SMALL,
			...extra,
			out: cap.out,
			err: cap.err,
		};
	};

	it("--password-stdin：从标准输入读一行新密码，重置之后新密码能登录、旧密码不行", async () => {
		const run = io("brand-new-pass-1\n");
		expect(await runResetPassword(["root", "--password-stdin"], run)).toBe(0);
		expect(run.out.join("")).toContain("已重置 root 的密码");
		expect(run.out.join("") + run.err.join("")).not.toContain("brand-new-pass-1");
		expect((await accounts.login("root", "brand-new-pass-1", "127.0.0.1")).ok).toBe(true);
		expect((await accounts.login("root", "old-password-1", "127.0.0.1")).ok).toBe(false);
	});

	it("他已有的登录全部注销", async () => {
		const first = await accounts.login("root", "old-password-1", "10.0.0.1");
		expect(first.ok).toBe(true);
		const run = io("brand-new-pass-1\n");
		expect(await runResetPassword(["root", "--password-stdin"], run)).toBe(0);
		const rows = await database.pool.query(
			"select count(*)::int as n from logins where revoked_at is null",
		);
		expect(rows.rows[0].n).toBe(0);
	});

	it("没有这个用户：退出码 1，说明；登录名不区分大小写", async () => {
		const missing = io("brand-new-pass-1\n");
		expect(await runResetPassword(["nobody", "--password-stdin"], missing)).toBe(1);
		expect(missing.err.join("")).toContain("没有登录名是 nobody 的用户");
		const upper = io("brand-new-pass-1\n");
		expect(await runResetPassword(["ROOT", "--password-stdin"], upper)).toBe(0);
	});

	it("密码太短：退出码 1，不改密码", async () => {
		const run = io("short\n");
		expect(await runResetPassword(["root", "--password-stdin"], run)).toBe(1);
		expect(run.err.join("")).toContain("至少 8 个字符");
		expect((await accounts.login("root", "old-password-1", "127.0.0.1")).ok).toBe(true);
	});

	it("没有登录名、没有给密码的来源：退出码 2，打印用法；标准输入不是终端又没写 --password-stdin 时不卡住", async () => {
		const noName = io(undefined);
		expect(await runResetPassword([], noName)).toBe(2);
		expect(noName.err.join("")).toContain("用法");
		const noSource = io(undefined);
		expect(await runResetPassword(["root"], noSource)).toBe(2);
		expect(noSource.err.join("")).toContain("--password-stdin");
	});

	it("在终端里交互输入：输入两遍，不一致时重来不改；一致时重置；输入不回显（由 readHidden 负责）", async () => {
		const answers = [
			"first-attempt-1",
			"different-attempt-1",
			"same-password-1",
			"same-password-1",
		];
		const asked: string[] = [];
		const run = io(undefined, {
			stdinIsTty: true,
			readHidden: async (prompt) => {
				asked.push(prompt);
				return answers.shift() ?? "";
			},
		});
		expect(await runResetPassword(["root"], run)).toBe(0);
		expect(asked).toHaveLength(4);
		expect(run.err.join("")).toContain("两次输入不一致");
		expect((await accounts.login("root", "same-password-1", "127.0.0.1")).ok).toBe(true);
		expect((await accounts.login("root", "first-attempt-1", "127.0.0.1")).ok).toBe(false);
	});

	it("写库失败（#578）：退出码 1、没有改动，操作者的终端上只有去掉参数的说明：没有新密码，也没有它的哈希", async () => {
		// 让更新 users 的语句出错（触发器抛异常）：drizzle 的错误里带着这条语句的参数，新密码的 scrypt 哈希在里面。
		await database.pool.query(
			`create function refuse_user_update() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`,
		);
		await database.pool.query(
			"create trigger refuse_user_update before update on users for each row execute function refuse_user_update()",
		);
		const run = io("brand-new-pass-1\n");
		expect(await runResetPassword(["root", "--password-stdin"], run)).toBe(1);
		const shown = run.out.join("") + run.err.join("");
		expect(shown).toContain("重置密码失败（没有改动）");
		// 去掉参数之后还留着语句和数据库给的原因。
		expect(shown).toContain("Failed query");
		expect(shown).not.toContain("scrypt$");
		expect(shown).not.toContain("brand-new-pass-1");
		await database.pool.query("drop trigger refuse_user_update on users");
		expect((await accounts.login("root", "old-password-1", "127.0.0.1")).ok).toBe(true);
	});

	it("连不上数据库：退出码 1，说明原因，不抛未处理的错误", async () => {
		const run = io("brand-new-pass-1\n", {
			databaseUrl: "postgres://nobody:nobody@127.0.0.1:1/nothing",
		});
		expect(await runResetPassword(["root", "--password-stdin"], run)).toBe(1);
		expect(run.err.join("")).toContain("连不上数据库");
	});
});
