// 助手服务往终端写东西的统一出口（#693）：出口文件自己只有登记的那几个声明直接往终端写；错误在出口里换成一行打过码、
// 截过的说明；打印错误的每一处都走它。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ASSISTANT_SECRET_ENV, SECRET_MASK } from "@sfly/schema";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/bus.js";
import { describeError, printError, writeLog, writeRawLog } from "../src/output.js";
import { LOG_TEXT_LIMIT } from "../src/redact.js";
import { createAssistantServer } from "../src/server.js";
import type { SessionManager } from "../src/sessions.js";
import { eventually } from "./support/eventually.js";
import { Harness } from "./support/harness.js";
import { pluginHitLines } from "./support/plugin-lint.js";

/** 一个带凭据形状、很长的错误：上游的错误原文、连接上的报错都可能是这样。 */
const { leaky, failing } = vi.hoisted(() => ({
	leaky: () =>
		new Error(
			`请求失败：发往 https://user:hunter2@example.invalid/v1，带着 Bearer tok-abc.def-123 ${"x".repeat(900)}`,
		),
	/** 这些文件名的写入流一建好就出错（错误是 {@link leaky}）：会话的文件写不了时日志里的那一行。 */
	failing: new Set<string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		createWriteStream: (path: string, options?: Parameters<typeof fs.createWriteStream>[1]) => {
			if (!failing.has(basename(String(path)))) return fs.createWriteStream(path, options);
			const stream = new Writable({ write: (_chunk, _encoding, done) => done() });
			setImmediate(() => stream.destroy(leaky()));
			return stream;
		},
	};
});

const OUTPUT = new URL("../src/output.ts", import.meta.url);

/** 截住这段时间里写到标准错误的东西（测试不在规则的范围里）。 */
function captureStderr() {
	const written: string[] = [];
	const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		written.push(String(chunk));
		return true;
	});
	return { written, restore: () => spy.mockRestore() };
}

afterEach(() => {
	vi.restoreAllMocks();
});

function expectScrubbed(text: string) {
	expect(text).not.toContain("tok-abc.def-123");
	expect(text).not.toContain("hunter2");
	expect(text).toContain(SECRET_MASK);
	expect(text).toContain("后面截掉了");
	expect(text).not.toContain("\n    at ");
}

describe("出口的函数", () => {
	it("describeError：只取 message（不带堆栈），按形状打码，截到上限；不是错误的值按字符串处理", () => {
		const shown = describeError(leaky());
		expectScrubbed(shown);
		expect(
			shown.startsWith(
				`请求失败：发往 https://${SECRET_MASK}@example.invalid/v1，带着 Bearer ${SECRET_MASK} xxx`,
			),
		).toBe(true);
		expect(shown.length).toBeLessThan(LOG_TEXT_LIMIT + 40);
		expect(describeError("字符串的原因 Bearer zzz")).toBe(`字符串的原因 Bearer ${SECRET_MASK}`);
		expect(describeError(new Error("短的"))).toBe("短的");
		expect(
			describeError(new Error('上游回了 {"authorization":"Basic dXNlcjpwYXNz"}')),
		).not.toContain("dXNlcjpwYXNz");
	});

	it("printError、writeRawLog：一行，行首是时间，原文打过码、截过；writeLog 原样写一行", () => {
		const out = captureStderr();
		printError("拒绝启动", leaky());
		writeRawLog(`工作台 a:1 这次命令的连接出错：${leaky().message}`);
		writeLog("助手服务在 :8090");
		out.restore();
		expect(out.written).toHaveLength(3);
		for (const line of out.written) {
			expect(line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z [^\n]*\n$/);
		}
		expect(out.written[0]).toContain(" 拒绝启动：请求失败：");
		expectScrubbed(out.written[0] ?? "");
		expect(out.written[1]).toContain(" 工作台 a:1 这次命令的连接出错：请求失败：");
		expectScrubbed(out.written[1] ?? "");
		expect(out.written[2]).toMatch(/Z 助手服务在 :8090\n$/);
	});
});

describe("打印错误的每一处都走出口", () => {
	it("处理请求出错（500）：日志里的原因打过码、截过，回应里没有原因", async () => {
		const logs: string[] = [];
		const sessions = {
			abort: () => {
				throw leaky();
			},
		} as unknown as SessionManager;
		const server = createAssistantServer({
			secret: "s".repeat(32),
			bus: new EventBus(),
			sessions,
			versions: { assistant: "0.0.0-test", pi: "0.0.0" },
			modelsFile: "/nonexistent/models.json",
			log: (message) => logs.push(message),
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const { port } = server.address() as { port: number };
			const res = await fetch(`http://127.0.0.1:${port}/sessions/${crypto.randomUUID()}/abort`, {
				method: "POST",
				headers: { authorization: `Bearer ${"s".repeat(32)}` },
				body: JSON.stringify({ turn: 1 }),
			});
			expect(res.status).toBe(500);
			expect(await res.text()).not.toContain("请求失败");
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatch(/^处理 POST \/sessions\/[0-9a-f-]+\/abort 出错：请求失败：/);
			expectScrubbed(logs[0] ?? "");
		} finally {
			server.close();
		}
	});

	it("拒绝启动（配置不对）：标准错误上一行，行首是时间，经 printError", () => {
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", fileURLToPath(new URL("../src/main.ts", import.meta.url))],
			{
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				env: { PATH: process.env.PATH, [ASSISTANT_SECRET_ENV]: "short" },
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(
			new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z 拒绝启动：${ASSISTANT_SECRET_ENV} 至少要 `),
		);
		expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
	});

	describe("写会话的文件失败", () => {
		let h: Harness;
		beforeAll(async () => {
			h = await Harness.start({
				piArgv: [process.execPath, join(import.meta.dirname, "support", "fake-pi.mjs")],
			});
		});
		afterAll(async () => {
			await h?.close();
		});

		it("events.jsonl、pi-stderr.log 写不了：各一行，原因是错误打过码、截过的一行说明", async () => {
			const id = crypto.randomUUID();
			failing.add("events.jsonl").add("pi-stderr.log");
			try {
				expect((await h.prompt(id, { text: "settle" })).status).toBe(202);
				await eventually(() => {
					for (const name of ["events.jsonl", "pi-stderr.log"]) {
						const lines = h.logs.filter((l) => l.includes(`写 ${name} 失败`));
						expect(lines, name).toHaveLength(1);
						expect(lines[0]).toMatch(new RegExp(`^会话 ${id}：写 ${name} 失败：请求失败：`));
						expectScrubbed(lines[0] ?? "");
					}
				});
			} finally {
				failing.clear();
			}
		});
	});
});

describe("统一的出口文件自己", () => {
	/**
	 * 出口文件里每个顶层的语句：声明有名字，别的语句（默认导出、顶层的表达式语句……）叫「（语句种类）」；记下函数的参数类型
	 * 文字、函数体里有没有 `forLog(`。「直接往终端写」不自己判断：用 lint 规则 no-direct-output 跑这个文件的副本（换个文件名，
	 * 规则就不把它当出口文件排除），命中的行落在哪个顶层语句里，那个语句就是「直接往终端写」的（和控制面
	 * apps/server/test/error-log.test.ts 的同一个做法）。
	 */
	function declarations(text = readFileSync(OUTPUT, "utf8")) {
		const source = ts.createSourceFile("output.ts", text, ts.ScriptTarget.Latest, true);
		const hits = pluginHitLines(
			"no-direct-output",
			"apps/assistant/src/output-under-test.ts",
			text,
		);
		const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;
		const found: { name: string; params: string[]; terminal: boolean; scrubs: boolean }[] = [];
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
				scrubs: fn?.body?.getText(source).includes("forLog(") ?? false,
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
				add("（导入）", statement);
			} else {
				add(`（${ts.SyntaxKind[statement.kind]}）`, statement);
			}
		}
		return found;
	}

	// 登记的是「能往终端写的声明，各自收什么」。以后在出口文件里加一个直接打印的函数，这条就红：要么登记在这里（审查时看得见
	// 它收什么、是不是过了 forLog），要么不要加。lint 规则把这个文件整个排除在外，管不到它自己，所以由这里用同一条规则查。
	const REGISTERED: Record<string, string[]> = {
		writeLog: ["string"],
	};

	it("直接往终端写的声明只有登记的这几个（按 lint 规则认的写法判断）", () => {
		const printing = declarations()
			.filter((d) => d.terminal)
			.map((d) => d.name)
			.sort();
		expect(
			printing,
			"apps/assistant/src/output.ts 里新加了直接往终端写的声明（或把已有的删了）：在这个测试的 REGISTERED 里登记它收什么参数；收错误的要先过 forLog。",
		).toEqual(Object.keys(REGISTERED).sort());
	});

	it("守卫自己：出口文件里加默认导出的箭头函数、顶层直接打印的语句、不在登记里的函数，命中都落在没登记的语句里", () => {
		const original = readFileSync(OUTPUT, "utf8");
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

	it("登记的函数收的参数和登记的一样；收的不只是字符串的要先过 forLog", () => {
		for (const d of declarations().filter((d) => d.terminal)) {
			expect(d.params, `${d.name} 的参数`).toEqual(REGISTERED[d.name]);
			if (d.params.some((type) => type !== "string")) {
				expect(d.scrubs, `${d.name} 收的参数不只是字符串，却没有过 forLog`).toBe(true);
			}
		}
	});
});
