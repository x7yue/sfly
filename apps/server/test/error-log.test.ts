// 出错时写进日志的数据库报错不带查询的参数（PR #555 的独立审查）：drizzle 的查询错误的 message 里带着参数，
// 写 `users` 表出错时密码的 scrypt 哈希会进日志；别的表的参数里有令牌的哈希、secret 参数的默认值、飞书 Webhook 的地址。
// 保留 SQL 和数据库给的原因（错误码、约束名、表名、列名），去掉参数和 `detail`、`where`（里面带着值）。
import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { inspect } from "node:util";
import { DrizzleQueryError } from "drizzle-orm/errors";
import pg from "pg";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError, printError } from "../src/util/output.js";
import { safeError, sanitizeLogArgs, serializeError } from "../src/util/safe-error.js";
import { loginCookie } from "./support/credentials.js";
import { migrationsCopy, STATEMENT_BREAKPOINT } from "./support/migrations.js";
import { pluginHitLines } from "./support/plugin-lint.js";
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

	it("错误自己别的属性里的错误也去掉参数（放在 err 或 error 键下，序列化时不原样抄进日志）", () => {
		const original = new DrizzleQueryError("insert into users values ($1)", [SECRET], pgError());
		const outer = Object.assign(new Error("外层"), { original });
		const shown = JSON.stringify(serializeError(outer));
		expect(shown).not.toContain(SECRET);
		expect(shown).not.toContain("xiaoming");
		expect(shown).toContain("外层");
		expect(shown).toContain("insert into users values ($1)");
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

	it("数据库把值直接写进错误信息本身的那类（类别 22：类型不对的输入）：message 整句换成错误码加报错的函数，不解析信息", () => {
		const uuid = Object.assign(
			new Error('invalid input syntax for type uuid: "7f3-secret-value\\"with-quote"'),
			{ severity: "ERROR", code: "22P02", routine: "string_to_uuid" },
		);
		const safe = safeError(uuid) as Error & { code: string; routine: string };
		expect(safe.message).toBe("Database data exception [22P02] in string_to_uuid");
		expect(safe.stack).not.toContain("secret-value");
		expect(safe.code).toBe("22P02");
		expect(safe.routine).toBe("string_to_uuid");
		// 没有 routine 时只有错误码。
		const bytes = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), {
			severity: "ERROR",
			code: "22021",
		});
		expect((safeError(bytes) as Error).message).toBe("Database data exception [22021]");
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
		// 给操作者的一行说明里带着报错的函数，排查时看得出是哪一步。
		expect(describeError(wrapped)).toContain("string_to_uuid");
		expect(describeError(wrapped)).not.toContain("secret-value");
	});

	it("类别 22 去值和数据库的消息语言、值的括法无关：换了语言、引号怎么写、值里有引号换行、根本不括的，一个字都不留", () => {
		// 数据库的消息是翻译过的：德语 »值«、法语 « 值 »、日语 「値」、中文 “值”，也有不括的；值里可以有引号、换行、反斜杠。
		const messages = [
			'invalid input syntax for type uuid: "a"b-secret-v1"',
			'invalid input syntax for type json: "{"k": "secret-v2"}"',
			'invalid value "x"y-secret-v3" for "YYYY"',
			'malformed array literal: "{"secret-v4","b"}"',
			'ungültige Eingabesyntax für Typ uuid: »ab"secret-v5"cd«',
			"ungültige Eingabesyntax für Typ uuid: »ab\nsecret-v6\nzz«",
			"syntaxe en entrée invalide pour le type uuid : « secret-v7 »",
			"型uuidの入力構文が不正です: 「secret-v8」",
			"类型 uuid 的输入语法无效: “secret-v9”",
			"Wert »secret-v10« ist außerhalb des gültigen Bereichs für Typ integer",
			"invalid input syntax for type integer: secret-v11",
			"character with byte sequence 0xc3 0xa9 secret-v12 in encoding UTF8",
		];
		for (const message of messages) {
			const error = Object.assign(new Error(message), {
				severity: "ERROR",
				code: "22P02",
				routine: "string_to_uuid",
			});
			const safe = safeError(error) as Error;
			expect(safe.message, message).toBe("Database data exception [22P02] in string_to_uuid");
			const shown = [
				safe.stack,
				inspect(safe, { depth: 5 }),
				JSON.stringify(serializeError(error)),
				describeError(error),
			].join("\n");
			expect(shown, message).not.toMatch(/secret-v|0xc3|0xa9/);
		}
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

describe("错误套得很深、聚合里套错误（#578）", () => {
	it("cause 链比展开的层数还长：超过的那一层不原样放行，里面的查询参数也不在输出里", () => {
		let error: unknown = new DrizzleQueryError("select 1 where a = $1", [SECRET], pgError());
		for (let level = 0; level < 12; level++) error = new Error(`第 ${level} 层`, { cause: error });
		const safe = safeError(error);
		const shown = inspect(safe, { depth: 40 }) + JSON.stringify(serializeError(error));
		expect(shown).not.toContain(SECRET);
		expect(shown).not.toContain("xiaoming");
		// 外面几层还在。
		expect(shown).toContain("第 11 层");
	});

	it("聚合的错误在很深的一层：一样不放行", () => {
		const failed = new DrizzleQueryError("select 1 where a = $1", [SECRET], pgError());
		let error: unknown = new AggregateError([failed], "里面");
		for (let level = 0; level < 12; level++) error = new Error(`第 ${level} 层`, { cause: error });
		expect(inspect(safeError(error), { depth: 40 })).not.toContain(SECRET);
		expect(JSON.stringify(serializeError(error))).not.toContain(SECRET);
	});
});

describe("记日志的参数（#578）：日志库是第二条出口", () => {
	const query = () => new DrizzleQueryError("insert into users values ($1)", [SECRET], pgError());
	const text = (value: unknown) => inspect(value, { depth: 10 });

	it("错误放在别的键里、放在后面的参数里、放在嵌套的对象和数组里：都去掉参数", () => {
		const cases: unknown[][] = [
			[{ error: query() }, "失败了"],
			[{ cause: query(), reqId: "r1" }, "失败了"],
			[{ detail: { failure: query() } }, "失败了"],
			[{ errors: [query(), new Error("别的")] }, "失败了"],
			["失败了：%s", query()],
			["失败了", { a: 1 }, query()],
			[{ err: query() }, "失败了", query()],
		];
		for (const args of cases) {
			const out = sanitizeLogArgs(args);
			expect(text(out), text(args)).not.toContain(SECRET);
			expect(text(out), text(args)).toContain("Failed query");
			expect(out).toHaveLength(args.length);
		}
		// 其余的内容原样。
		const [merged] = sanitizeLogArgs([{ error: query(), reqId: "r1", n: 3 }]) as [
			{ error: Error; reqId: string; n: number },
		];
		expect(merged.reqId).toBe("r1");
		expect(merged.n).toBe(3);
		expect(merged.error.message).toBe("Failed query: insert into users values ($1)");
	});

	it("里面没有错误的参数原样返回（同一个对象），不是普通对象的（类的实例）不动；对象里有环也不死循环", () => {
		const plain = [{ a: { b: [1, 2, { c: "x" }] } }, "说明", 3];
		expect(sanitizeLogArgs(plain)).toBe(plain);
		class Holder {
			readonly error = query();
		}
		const holder = new Holder();
		expect(sanitizeLogArgs([holder])[0]).toBe(holder);
		const loop: Record<string, unknown> = { name: "loop" };
		loop.self = loop;
		expect(() => sanitizeLogArgs([loop, query()])).not.toThrow();
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
			expect(describeError("字符串")).toBe("字符串");
			expect(describeError(new Error("普通"))).toBe("普通");
		} finally {
			spy.mockRestore();
		}
	});
});

describe("describeError：给操作者看的一行说明带着原因（#578）", () => {
	it("写库失败：语句之后接着数据库给的原因（去掉参数之后最里层的那一个），不带参数", () => {
		const refused = Object.assign(new Error("refused"), { severity: "ERROR", code: "P0001" });
		const error = new DrizzleQueryError("update users set a = $1", [SECRET], refused);
		const shown = describeError(error);
		expect(shown).toContain("Failed query: update users set a = $1");
		expect(shown).toContain("refused");
		expect(shown).toContain("P0001");
		expect(shown).not.toContain(SECRET);
		// 约束冲突：原因里是约束名，没有值。
		const conflict = describeError(
			new DrizzleQueryError("insert into users values ($1)", [SECRET], pgError()),
		);
		expect(conflict).toContain('violates unique constraint "users_login_name_key"');
		// 数据库报错的函数也带上（排查时看得出是哪一步）。
		expect(conflict).toContain("_bt_check_unique");
		expect(conflict).not.toContain(SECRET);
		expect(conflict).not.toContain("xiaoming");
	});

	it("连不上数据库（聚合的错误，自己的 message 是空的）：每个成员的原因都接上", () => {
		const refuse = (address: string) =>
			Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: "ECONNREFUSED" });
		const aggregate = new AggregateError([refuse("::1:5432"), refuse("127.0.0.1:5432")], "");
		const shown = describeError(
			new DrizzleQueryError("select * from users where login_name = $1", [SECRET], aggregate),
		);
		expect(shown).toContain("Failed query: select * from users where login_name = $1");
		expect(shown).toContain("connect ECONNREFUSED ::1:5432");
		expect(shown).toContain("connect ECONNREFUSED 127.0.0.1:5432");
		expect(shown).not.toContain(SECRET);
		// 没有外层语句、直接是聚合的错误。
		expect(describeError(aggregate)).toContain("connect ECONNREFUSED 127.0.0.1:5432");
	});

	it("普通的错误带 cause：外层的说明之后接最里层的原因；没有 cause 的就是它自己的 message；原因和说明相同不重复", () => {
		expect(describeError(new Error("外层", { cause: new Error("内层") }))).toBe(
			"外层（原因：内层）",
		);
		expect(describeError(new Error("只有一层"))).toBe("只有一层");
		expect(describeError(new Error("同一句", { cause: new Error("同一句") }))).toBe("同一句");
		expect(describeError(new Error("外层", { cause: "字符串的原因" }))).toBe(
			"外层（原因：字符串的原因）",
		);
	});
});

describe("统一的出口文件自己（#578）", () => {
	/**
	 * 出口文件里每个顶层的语句：声明（函数、变量、类、导入）有名字，别的语句（默认导出、顶层的表达式语句……）叫「（语句种类）」；
	 * 记下起止行、函数的参数类型文字、函数体里有没有 `safeError(`。
	 * 「直接往终端写」不自己判断：用 lint 规则 no-direct-output 跑这个文件的副本（换个文件名，规则就不把它当出口文件排除），
	 * 规则认的写法——包括 `const { stderr } = process`、`import { stderr } from "node:process"`、`writeSync(2, …)`、类的方法——
	 * 这里同样认，命中的行落在哪个顶层语句里，那个语句就是「直接往终端写」的。**每个命中都要落在登记的声明里**：
	 * 落在别的语句里（默认导出的箭头函数、顶层直接打印的语句）也算，名字不在登记的里面，测试红。
	 */
	function declarations(
		text = readFileSync(new URL("../src/util/output.ts", import.meta.url), "utf8"),
	) {
		const source = ts.createSourceFile("output.ts", text, ts.ScriptTarget.Latest, true);
		const hits = pluginHitLines(
			"no-direct-output",
			"apps/server/src/util/output-under-test.ts",
			text,
		);
		const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;
		const found: {
			name: string;
			params: string[];
			terminal: boolean;
			scrubs: boolean;
		}[] = [];
		const add = (
			name: string,
			node: ts.Node,
			fn?: ts.SignatureDeclaration & { body?: ts.Node },
		) => {
			const start = lineOf(node.getStart(source));
			const end = lineOf(node.getEnd());
			found.push({
				name,
				params: fn
					? fn.parameters.map((p) => p.type?.getText(source) ?? "（没写类型）")
					: ["（不是函数）"],
				terminal: hits.some((line) => line >= start && line <= end),
				scrubs: fn?.body?.getText(source).includes("safeError(") ?? false,
			});
		};
		for (const statement of source.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name) {
				add(statement.name.text, statement, statement);
			} else if (ts.isClassDeclaration(statement) && statement.name) {
				add(statement.name.text, statement);
			} else if (ts.isVariableStatement(statement)) {
				for (const declaration of statement.declarationList.declarations) {
					const init = declaration.initializer;
					const fn =
						init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
					add(declaration.name.getText(source), declaration, fn);
				}
			} else if (ts.isImportDeclaration(statement)) {
				// 导入本身命中（`import { stderr } from "node:process"`）：算在一个叫「（导入）」的声明里，一定不在登记的里面。
				add("（导入）", statement);
			} else {
				// 默认导出的箭头函数、顶层的表达式语句等：命中落在这里也是「直接往终端写」，一定不在登记的里面。
				add(`（${ts.SyntaxKind[statement.kind]}）`, statement);
			}
		}
		return found;
	}

	// 登记的是「能往终端写的声明，各自收什么」。以后在出口文件里加一个直接打印的函数，这条就红：要么登记在这里（审查时看得见它收什么、
	// 是不是过了 safeError），要么不要加。lint 规则 no-direct-output 把这个文件整个排除在外，管不到它自己，所以由这里用同一条规则查。
	const REGISTERED: Record<string, string[]> = {
		printError: ["string", "unknown"],
		printWarning: ["string"],
		printInfo: ["string"],
		writeStdout: ["string"],
		terminalStreams: [],
	};

	it("直接往终端写的声明只有登记的这几个（按 lint 规则认的写法判断，含类的方法、解构、导入）", () => {
		const printing = declarations()
			.filter((d) => d.terminal)
			.map((d) => d.name)
			.sort();
		expect(
			printing,
			"apps/server/src/util/output.ts 里新加了直接往终端写的声明（或把已有的删了）：在这个测试的 REGISTERED 里登记它收什么参数；收错误的要先过 safeError。",
		).toEqual(Object.keys(REGISTERED).sort());
	});

	it("守卫自己：出口文件里加默认导出的箭头函数、顶层直接打印的语句、不在登记里的函数，命中都落在没登记的语句里", () => {
		const original = readFileSync(new URL("../src/util/output.ts", import.meta.url), "utf8");
		const printing = (extra: string) =>
			declarations(`${original}\n${extra}\n`)
				.filter((d) => d.terminal)
				.map((d) => d.name)
				.filter((name) => !(name in REGISTERED));
		expect(printing("export default (error: unknown) => { console.error(error); };")).toEqual([
			"（ExportAssignment）",
		]);
		expect(printing('process.on("warning", (warning) => { console.error(warning); });')).toEqual([
			"（ExpressionStatement）",
		]);
		expect(
			printing("export function sneaky(text: string) { process.stderr.write(text); }"),
		).toEqual(["sneaky"]);
		expect(printing("")).toEqual([]);
	});

	it("登记的函数收的参数和登记的一样；只收字符串的不会打印错误对象，收错误的（unknown）先过 safeError", () => {
		for (const d of declarations().filter((d) => d.terminal)) {
			expect(d.params, `${d.name} 的参数`).toEqual(REGISTERED[d.name]);
			if (d.params.some((type) => type !== "string")) {
				expect(
					d.scrubs || d.params.length === 0,
					`${d.name} 收的参数不只是字符串，却没有过 safeError`,
				).toBe(true);
			}
		}
	});

	it("守卫自己认得出规则认的那几种新写法：解构、导入、writeSync、类的方法（在副本里加一个函数试）", () => {
		const base = readFileSync(new URL("../src/util/output.ts", import.meta.url), "utf8");
		const hit = (extra: string) =>
			pluginHitLines(
				"no-direct-output",
				"apps/server/src/util/output-under-test.ts",
				`${base}\n${extra}`,
			);
		const before = hit("").length;
		for (const extra of [
			"export function a(error: unknown) { const { stderr } = process; stderr.write(String(error)); }",
			'import { stderr } from "node:process";',
			"export function b(error: unknown) { writeSync(2, String(error)); }",
			"export class C { m(error: unknown) { console.error(error); } }",
			"export const d = (error: unknown) => process.emitWarning(String(error));",
		]) {
			expect(hit(extra).length, extra).toBeGreaterThan(before);
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
