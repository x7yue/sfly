// 进程级的未捕获异常和未处理的拒绝（#563）：记一条带上下文的错误日志，有序关闭，以退出码 1 退出，不继续运行、不吞掉。
// 两层：用假的进程对象和退出函数测逻辑（关闭的顺序、超时、关闭时又出错、日志不带保密的值）；起一个真实的进程测
// 「真的以退出码 1 退出」（Node 默认的行为是未捕获的异常退出，这里装了处理之后仍然要退出，而且先关闭、先记日志）。
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { inspect, promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installProcessGuards } from "../src/process-guards.js";

const run = promisify(execFile);
const serverDir = join(import.meta.dirname, "..");

describe("installProcessGuards（假的进程）", () => {
	let proc: EventEmitter;
	let exits: number[];
	let logs: unknown[][];
	let uninstall: (() => void) | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		proc = new EventEmitter();
		exits = [];
		logs = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logs.push(args);
		});
	});
	afterEach(() => {
		uninstall?.();
		uninstall = undefined;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	const install = (shutdown: () => Promise<void>, timeoutMs?: number) => {
		uninstall = installProcessGuards({
			shutdown,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
			proc: proc as unknown as NodeJS.Process,
			exit: (code) => {
				exits.push(code);
			},
		});
	};
	const settle = () => vi.advanceTimersByTimeAsync(0);

	it.each([
		["uncaughtException", "未捕获的异常"],
		["unhandledRejection", "未处理的 Promise 拒绝"],
	])("%s：先记日志（带上下文和错误），再有序关闭，关闭结束之后以退出码 1 退出", async (event, what) => {
		const order: string[] = [];
		install(async () => {
			order.push("shutdown");
			expect(exits).toEqual([]); // 关闭结束之前不退出
		});
		const error = new Error("某个缺陷");

		proc.emit(event, error);
		await settle();

		expect(order).toEqual(["shutdown"]);
		expect(exits).toEqual([1]);
		const first = logs[0] ?? [];
		expect(String(first[0])).toContain(what);
		expect(String(first[0])).toContain("退出码 1");
		expect(first[1]).toBe(error);
	});

	it("关闭卡住：等满 timeoutMs 就退出，并写明是超时", async () => {
		install(() => new Promise<void>(() => {}), 5_000);

		proc.emit("uncaughtException", new Error("缺陷"));
		await vi.advanceTimersByTimeAsync(4_999);
		expect(exits).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);

		expect(exits).toEqual([1]);
		expect(logs.some((l) => String(l[0]).includes("5000 毫秒还没有结束"))).toBe(true);
	});

	it("关闭本身出错：记一条日志，照样以退出码 1 退出", async () => {
		install(async () => {
			throw new Error("关不掉");
		});

		proc.emit("uncaughtException", new Error("缺陷"));
		await settle();

		expect(exits).toEqual([1]);
		expect(logs.some((l) => String(l[0]).includes("有序关闭时出错"))).toBe(true);
	});

	it("关闭过程中又来一个错误：只记日志，不开始第二次关闭，也不提前退出", async () => {
		let release: () => void = () => {};
		let shutdowns = 0;
		install(() => {
			shutdowns++;
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		});

		proc.emit("uncaughtException", new Error("第一个"));
		proc.emit("unhandledRejection", new Error("第二个"));
		await settle();

		expect(shutdowns).toBe(1);
		expect(exits).toEqual([]);
		expect(logs.some((l) => String(l[0]).includes("正在退出时又出了一个错误"))).toBe(true);
		release();
		await settle();
		expect(exits).toEqual([1]);
	});

	it("数据库错误里的参数不进日志（过 safeError）：保密的值、密码的哈希", async () => {
		install(async () => {});
		// drizzle 的查询错误：message 和属性里都带着这次查询的参数。
		const queryError = Object.assign(
			new Error(
				'Failed query: insert into "users" ("password_hash") values ($1)\nparams: scrypt$secret-hash-value',
			),
			{
				query: 'insert into "users" ("password_hash") values ($1)',
				params: ["scrypt$secret-hash-value"],
			},
		);

		proc.emit("unhandledRejection", queryError);
		await settle();

		// console.error 实际打印的样子（util.inspect 会把错误的属性也打出来）。
		const printed = inspect(logs, { depth: 8 });
		expect(printed).toContain("insert into");
		expect(printed).not.toContain("scrypt$secret-hash-value");
	});

	it("卸掉之后不再处理", async () => {
		install(async () => {});
		uninstall?.();
		uninstall = undefined;

		expect(proc.listenerCount("uncaughtException")).toBe(0);
		expect(proc.listenerCount("unhandledRejection")).toBe(0);
	});
});

describe("installProcessGuards（真实的进程）", () => {
	/** 起一个装了处理的进程，`body` 是装好之后在里面执行的代码；返回退出码和输出。 */
	async function runScript(body: string) {
		const script = `
			import { installProcessGuards } from "./src/process-guards.ts";
			installProcessGuards({
				timeoutMs: 400,
				shutdown: async () => { console.error("shutdown-called"); ${body.includes("hang") ? "await new Promise(() => {});" : ""} },
			});
			setInterval(() => {}, 1000); // 像控制面一样有东西让进程活着
			${body}
		`;
		try {
			await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				cwd: serverDir,
				timeout: 30_000,
			});
			return { code: 0, output: "" };
		} catch (error) {
			const failed = error as { code?: number | string; stderr?: string; stdout?: string };
			return { code: failed.code, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
		}
	}

	it("未捕获的异常：记日志、先关闭、以退出码 1 退出（不是继续运行）", async () => {
		const result = await runScript('setTimeout(() => { throw new Error("boom-uncaught"); }, 50);');

		expect(result.code).toBe(1);
		expect(result.output).toContain("boom-uncaught");
		expect(result.output).toContain("未捕获的异常");
		expect(result.output.indexOf("未捕获的异常")).toBeLessThan(
			result.output.indexOf("shutdown-called"),
		);
	}, 60_000);

	it("未处理的 Promise 拒绝：同样以退出码 1 退出", async () => {
		const result = await runScript(
			'setTimeout(() => { Promise.reject(new Error("boom-rejection")); }, 50);',
		);

		expect(result.code).toBe(1);
		expect(result.output).toContain("boom-rejection");
		expect(result.output).toContain("未处理的 Promise 拒绝");
		expect(result.output).toContain("shutdown-called");
	}, 60_000);

	it("关闭卡住：等满超时（这里 400 毫秒）就退出，退出码仍是 1", async () => {
		const result = await runScript(
			'/* hang */ setTimeout(() => { throw new Error("boom-hang"); }, 50);',
		);

		expect(result.code).toBe(1);
		expect(result.output).toContain("400 毫秒还没有结束，直接退出");
	}, 60_000);
});

describe("main.ts 装了进程级的处理", () => {
	it("控制面启动之后装上（关闭用控制面自己的 close）", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(join(serverDir, "src", "main.ts"), "utf8");

		expect(source).toMatch(/installProcessGuards\(\{\s*shutdown: \(\) => controlPlane\.close\(\)/);
	});
});
