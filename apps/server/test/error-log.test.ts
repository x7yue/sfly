// 出错时写进日志的数据库报错不带查询的参数（PR #555 的独立审查）：drizzle 的查询错误的 message 里带着参数，
// 写 `users` 表出错时密码的 scrypt 哈希会进日志；别的表的参数里有令牌的哈希、保密参数的默认值、飞书 Webhook 的地址。
// 保留 SQL 和数据库给的原因（错误码、约束名、表名、列名），去掉参数和 `detail`、`where`（里面带着值）。
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { inspect } from "node:util";
import { DrizzleQueryError } from "drizzle-orm/errors";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError, printError } from "../src/util/output.js";
import { safeError, sanitizeLogArgs, serializeError } from "../src/util/safe-error.js";
import { loginCookie } from "./support/credentials.js";
import { migrationsCopy, STATEMENT_BREAKPOINT } from "./support/migrations.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SECRET = "scrypt$ln=16,r=8,p=2$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA";

/** 像驱动给的那样：message、severity、code、detail 里带着值。 */
function pgError(): Error {
	return Object.assign(
		new Error('duplicate key value violates unique constraint "users_login_name_key"'),
		{
			severity: "ERROR",
			code: "23505",
			detail: "Key (login_name)=(xiaoming) already exists.",
			where: `SQL statement "insert ... ${SECRET}"`,
			schema: "public",
			table: "users",
			constraint: "users_login_name_key",
			routine: "_bt_check_unique",
		},
	);
}

describe("safeError", () => {
	it("drizzle 的查询错误：只留 SQL，参数没有了；沿着 cause 链处理 pg 的错误，只留数据库给的原因", () => {
		const error = new DrizzleQueryError(
			'insert into "users" ("id", "password_hash") values ($1, $2)',
			["id-1", SECRET],
			pgError(),
		);
		expect(error.message).toContain(SECRET);
		const safe = safeError(error) as Error & { cause: Error & Record<string, unknown> };
		expect(safe.message).toBe(
			'Failed query: insert into "users" ("id", "password_hash") values ($1, $2)',
		);
		expect(safe.stack).not.toContain(SECRET);
		expect(safe.cause.message).toBe(
			'duplicate key value violates unique constraint "users_login_name_key"',
		);
		expect(safe.cause).toMatchObject({
			code: "23505",
			severity: "ERROR",
			table: "users",
			constraint: "users_login_name_key",
		});
		expect(safe.cause).not.toHaveProperty("detail");
		expect(safe.cause).not.toHaveProperty("where");
		expect(JSON.stringify(serializeError(error))).not.toContain(SECRET);
		expect(JSON.stringify(serializeError(error))).not.toContain("xiaoming");
		expect(JSON.stringify(serializeError(error))).toContain("23505");
	});

	it("别的错误原样返回（同一个对象），不是错误的值原样返回", () => {
		const plain = new TypeError("x is not a function");
		expect(safeError(plain)).toBe(plain);
		expect(safeError("字符串")).toBe("字符串");
		expect(safeError(undefined)).toBeUndefined();
		expect(serializeError(plain)).toMatchObject({
			type: "TypeError",
			message: "x is not a function",
		});
		expect(serializeError("字符串")).toMatchObject({ message: "字符串" });
	});

	it("别的错误的 cause 里有数据库错误：外层换成去掉参数的 cause，外层自己的信息还在", () => {
		const inner = new DrizzleQueryError("update users set a = $1", [SECRET], pgError());
		const outer = new Error("保存失败", { cause: inner });
		const out = JSON.stringify(serializeError(outer));
		expect(out).toContain("保存失败");
		expect(out).toContain("update users set a = $1");
		expect(out).not.toContain(SECRET);
	});

	it("记日志的参数：error 本身、{ err } 里的错误都去掉参数（pino 用错误自己的 message 当 msg，不是序列化之后的）", () => {
		const error = new DrizzleQueryError("insert into users values ($1)", [SECRET], pgError());
		const [direct] = sanitizeLogArgs([error]) as [Error];
		expect(direct.message).toBe("Failed query: insert into users values ($1)");
		const [merged, text] = sanitizeLogArgs([{ err: error, reqId: "r1" }, "回填失败"]) as [
			{ err: Error; reqId: string },
			string,
		];
		expect(merged.err.message).toBe("Failed query: insert into users values ($1)");
		expect(merged.reqId).toBe("r1");
		expect(text).toBe("回填失败");
		// 别的参数原样。
		const plain = ["普通的一行", { a: 1 }];
		expect(sanitizeLogArgs(plain)).toBe(plain);
	});

	it("cause 链有环也不死循环", () => {
		const a = new Error("a");
		const b = new Error("b", { cause: a });
		(a as { cause?: unknown }).cause = b;
		expect(() => serializeError(a)).not.toThrow();
	});
});

describe("请求出错时的日志", () => {
	let cp: TestControlPlane | undefined;
	afterEach(async () => {
		await cp?.close();
		cp = undefined;
	});

	it("写 users 表的语句出错（500）：日志里有 SQL 和数据库给的原因，没有密码哈希、没有登录名", async () => {
		const logs: string[] = [];
		const stream = new Writable({
			write(chunk, _encoding, done) {
				logs.push(String(chunk));
				done();
			},
		});
		cp = await startTestControlPlane({
			initialAdmin: { loginName: "root", password: "admin-password-1" },
			logger: { stream },
		});
		const c = cp;
		const login = await c.fetch("/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ login_name: "root", password: "admin-password-1" }),
		});
		const cookie = /sfly_login=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
		// 让写 users 表的语句出错：把一列改名（建用户的 insert 引用的列不存在了；访问检查读用户时不用这一列，先过得去）。
		const db = new pg.Client({ connectionString: c.database.url });
		await db.connect();
		await db.query("alter table users rename column login_name to login_name_moved");
		await db.end();
		const res = await c.fetch("/users", {
			method: "POST",
			headers: { "content-type": "application/json", ...loginCookie(cookie) },
			body: JSON.stringify({
				login_name: "secretly",
				display_name: "名字",
				password: "plain-password-value-1",
			}),
		});
		expect(res.status).toBe(500);
		// 响应里也只有统一的说明。
		expect(await res.text()).not.toMatch(/scrypt|insert/);
		const output = logs.join("");
		expect(output).toContain("Failed query");
		expect(output).toContain('insert into \\"users\\"');
		// 数据库给的原因（列不存在的错误码）。
		expect(output).toContain("42703");
		// 参数不在日志里：哈希串、登录名、明文密码都没有。
		expect(output).not.toContain("scrypt$");
		expect(output).not.toContain("secretly");
		expect(output).not.toContain("plain-password-value-1");
	});
});

describe("safeError 的两类遗漏（#578）", () => {
	it("聚合的错误（AggregateError）把里面的每一个错误也去掉参数：指标写入失败那一类，参数里有运行和任务的编号、指标的标签和数值", () => {
		const params = ["run-id-1", "task-id-1", "tps", "label-value-xyz", 42];
		const failed = new DrizzleQueryError(
			"insert into metric_segments values ($1, $2)",
			params,
			pgError(),
		);
		const aggregate = new AggregateError([failed, new Error("普通的错误")], "指标写入失败");
		const safe = safeError(aggregate) as AggregateError;
		expect(safe).toBeInstanceOf(AggregateError);
		expect(safe.message).toBe("指标写入失败");
		expect(safe.errors).toHaveLength(2);
		expect((safe.errors[0] as Error).message).toBe(
			"Failed query: insert into metric_segments values ($1, $2)",
		);
		// 里面不需要处理的错误原样（同一个对象）。
		expect(safe.errors[1]).toBe(aggregate.errors[1]);
		const printed = inspect(safe, { depth: 10 }) + JSON.stringify(serializeError(aggregate));
		expect(printed).not.toContain("label-value-xyz");
		expect(printed).not.toContain("run-id-1");
		expect(printed).toContain("Failed query");
		expect(printed).toContain("普通的错误");
		// 序列化后里面的错误还在（带着去掉参数的 message）。
		expect(serializeError(aggregate)).toMatchObject({
			errors: [{ message: expect.stringContaining("Failed query") }, { message: "普通的错误" }],
		});
	});

	it("聚合的错误套在别的错误的 cause 里、聚合里再套聚合：一样处理；里面没有要处理的就原样返回", () => {
		const failed = new DrizzleQueryError("update t set a = $1", ["secret-aaa"], pgError());
		const nested = new Error("外层", {
			cause: new AggregateError([new AggregateError([failed], "内层")], "中层"),
		});
		expect(inspect(safeError(nested), { depth: 12 })).not.toContain("secret-aaa");
		const clean = new AggregateError([new Error("a"), new TypeError("b")], "没有数据库错误");
		expect(safeError(clean)).toBe(clean);
	});

	it("数据库把值直接写进错误信息本身的那类（类别 22：类型不对的输入）：值去掉，说明留着", () => {
		const uuid = Object.assign(
			new Error('invalid input syntax for type uuid: "7f3-secret-value\\"with-quote"'),
			{ severity: "ERROR", code: "22P02", routine: "string_to_uuid" },
		);
		const safe = safeError(uuid) as Error & { code: string };
		expect(safe.message).toBe('invalid input syntax for type uuid: "…"');
		expect(safe.stack).not.toContain("secret-value");
		expect(safe.code).toBe("22P02");
		const bytes = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), {
			severity: "ERROR",
			code: "22021",
		});
		expect((safeError(bytes) as Error).message).toBe('invalid byte sequence for encoding "…": 0x…');
		// 经 drizzle 包着时（外层是查询错误、cause 是 pg 的错误）里面的也处理。
		const wrapped = new DrizzleQueryError(
			"select * from t where id = $1",
			["secret-value-q"],
			uuid,
		);
		const printed =
			inspect(safeError(wrapped), { depth: 10 }) + JSON.stringify(serializeError(wrapped));
		expect(printed).not.toContain("secret-value");
		expect(printed).toContain("22P02");
	});

	it("别的类别的数据库错误（约束、列不存在……）的 message 里只有名字，不动", () => {
		const safe = safeError(pgError()) as Error;
		expect(safe.message).toBe(
			'duplicate key value violates unique constraint "users_login_name_key"',
		);
		const missing = Object.assign(new Error('column "login_name" does not exist'), {
			severity: "ERROR",
			code: "42703",
		});
		expect((safeError(missing) as Error).message).toBe('column "login_name" does not exist');
	});
});

describe("统一的出口（#578）", () => {
	it("printError 打印前去掉数据库参数：打出去的参数里没有哈希；describeError 是给操作者看的一行说明", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const error = new DrizzleQueryError("insert into users values ($1)", [SECRET], pgError());
			printError("写库失败：", error);
			printError("只有说明");
			const calls = spy.mock.calls;
			expect(calls[0]?.[0]).toBe("写库失败：");
			expect(inspect(calls, { depth: 10 })).not.toContain(SECRET);
			expect(inspect(calls, { depth: 10 })).toContain("Failed query");
			expect(calls[1]).toEqual(["只有说明"]);
			expect(describeError(error)).toBe("Failed query: insert into users values ($1)");
			expect(describeError("字符串")).toBe("字符串");
			expect(describeError(new Error("普通"))).toBe("普通");
		} finally {
			spy.mockRestore();
		}
	});
});

describe("启动失败时的错误（#578）", () => {
	it("用环境变量建第一个管理员时写库失败：启动失败，抛出的错误（含它被打印的各种样子）里没有密码的哈希，也没有明文密码", async () => {
		// 让建用户的语句出错：迁移里多一个触发器，往 users 里插入就抛异常（drizzle 的错误里带着这条语句的参数，密码的 scrypt 哈希在里面）。
		const dir = await migrationsCopy();
		const journal = JSON.parse(await readFile(join(dir, "meta", "_journal.json"), "utf8")) as {
			entries: { tag: string }[];
		};
		const last = join(dir, `${journal.entries.at(-1)?.tag}.sql`);
		await writeFile(
			last,
			`${await readFile(last, "utf8")}${STATEMENT_BREAKPOINT}
CREATE FUNCTION refuse_user_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$;
${STATEMENT_BREAKPOINT}
CREATE TRIGGER refuse_user_insert BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION refuse_user_insert();`,
		);
		try {
			let caught: unknown;
			try {
				await startTestControlPlane({
					initialAdmin: { loginName: "root", password: "admin-password-secret-1" },
					migrationsDir: dir,
				});
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(Error);
			const shown = [
				(caught as Error).message,
				(caught as Error).stack,
				inspect(caught, { depth: 12 }),
				JSON.stringify(serializeError(caught)),
			].join("\n");
			// 去掉参数之后还留着语句和数据库给的原因，操作者看得出是哪一步、为什么。
			expect(shown).toContain("Failed query");
			expect(shown).toContain("P0001");
			expect(shown).not.toContain("scrypt$");
			expect(shown).not.toContain("admin-password-secret-1");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
