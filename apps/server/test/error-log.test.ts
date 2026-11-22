// 出错时写进日志的数据库报错不带查询的参数（PR #555 的独立审查）：drizzle 的查询错误的 message 里带着参数，
// 写 `users` 表出错时密码的 scrypt 哈希会进日志；别的表的参数里有令牌的哈希、保密参数的默认值、飞书 Webhook 的地址。
// 保留 SQL 和数据库给的原因（错误码、约束名、表名、列名），去掉参数和 `detail`、`where`（里面带着值）。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { DrizzleQueryError } from "drizzle-orm/errors";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { safeError, sanitizeLogArgs, serializeError } from "../src/util/safe-error.js";
import { loginCookie } from "./support/credentials.js";
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

describe("控制面往标准错误写的错误都过 safeError", () => {
	const SRC = join(import.meta.dirname, "..", "src");

	/** 源码里每一处 `console.error(…)` 调用（括号配平，跨行的也取全）：文件和调用的文字。 */
	function consoleErrorCalls(): { file: string; call: string }[] {
		const found: { file: string; call: string }[] = [];
		for (const entry of readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
			if (!entry.endsWith(".ts")) continue;
			const text = readFileSync(join(SRC, entry), "utf8");
			for (
				let at = text.indexOf("console.error(");
				at !== -1;
				at = text.indexOf("console.error(", at + 1)
			) {
				let depth = 0;
				let end = at + "console.error".length;
				for (; end < text.length; end++) {
					if (text[end] === "(") depth++;
					if (text[end] === ")" && --depth === 0) break;
				}
				found.push({ file: entry, call: text.slice(at, end + 1) });
			}
		}
		return found;
	}

	it("每一处 console.error 的参数里都有 safeError(…)：数据库错误带着语句的参数，原样打印会把密码哈希、令牌哈希、保密参数的值带进日志；新加的打印不过它，这条就红", () => {
		const calls = consoleErrorCalls();
		// 认得出写法：控制面的统一出口 logError、SSE 主题的监听器至少两处，找不到说明这条测试自己坏了。
		expect(calls.length).toBeGreaterThanOrEqual(2);
		const unsafe = calls.filter(({ call }) => !call.includes("safeError("));
		expect(unsafe.map(({ file, call }) => `${file}: ${call.replace(/\s+/g, " ")}`)).toEqual([]);
	});
});
