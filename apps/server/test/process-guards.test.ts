// 进程级的未捕获异常和未处理的拒绝（#563）：记一条带上下文的错误日志，有序关闭，以退出码 1 退出，不继续运行、不吞掉。
// 两层：用假的进程对象和退出函数测逻辑（关闭的顺序、超时、关闭时又出错、日志不带数据库的参数）；起一个真实的进程测
// 「真的以退出码 1 退出」（Node 默认的行为是未捕获的异常退出，这里装了处理之后仍然要退出，而且先关闭、先记日志）。
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installProcessGuards, type ProcessGuards } from "../src/process-guards.js";
import { createTestDatabase } from "./support/test-database.js";

const run = promisify(execFile);
const serverDir = join(import.meta.dirname, "..");

describe("installProcessGuards（假的进程）", () => {
	let proc: EventEmitter;
	let exits: number[];
	let logs: unknown[][];
	let guards: ProcessGuards | undefined;

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
		guards?.uninstall();
		guards = undefined;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	const install = (shutdown: () => Promise<void>, timeoutMs?: number) => {
		guards = installProcessGuards({
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

	it("数据库错误里的参数不进日志（过 safeError）：密码的哈希", async () => {
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

	it("fatal：借出去的数据库连接出错之类、不是进程级事件的退出理由：同样先记日志、有序关闭、退出码 1，第二次只记日志", async () => {
		let shutdowns = 0;
		install(async () => {
			shutdowns++;
		});
		const error = new Error("连接断了");

		guards?.fatal("数据库连接在使用中断开", error);
		guards?.fatal("数据库连接在使用中断开", new Error("又一个"));
		await settle();

		expect(shutdowns).toBe(1);
		expect(exits).toEqual([1]);
		expect(String(logs[0]?.[0])).toContain("数据库连接在使用中断开");
		expect(String(logs[0]?.[0])).toContain("退出码 1");
		expect(logs[0]?.[1]).toBe(error);
		expect(logs.some((l) => String(l[0]).includes("正在退出时又出了一个错误"))).toBe(true);
	});

	describe.each([
		["uncaughtException", "未捕获的异常"],
		["unhandledRejection", "未处理的 Promise 拒绝"],
	])("%s：处理函数自己出错也保证退出", (event) => {
		/** 读 `cause` 就抛异常的错误：`safeError` 读它时抛（拒绝的原因可以是任何东西）。 */
		const hostile = () =>
			Object.defineProperty(new Error("敌意的错误"), "cause", {
				get() {
					throw new Error("读 cause 时抛了");
				},
			});

		it("记日志时抛了异常：只记一行说明，照常有序关闭、以退出码 1 退出", async () => {
			let shutdowns = 0;
			install(async () => {
				shutdowns++;
			});

			proc.emit(event, hostile());
			await settle();

			expect(shutdowns).toBe(1);
			expect(exits).toEqual([1]);
			expect(logs.some((l) => String(l[0]).includes("记不出来"))).toBe(true);
		});

		it("记日志的 console.error 本身一直抛：什么都记不出来，仍然退出码 1", async () => {
			install(async () => {});
			vi.spyOn(console, "error").mockImplementation(() => {
				throw new Error("标准错误关了");
			});

			proc.emit(event, new Error("缺陷"));
			await settle();

			expect(exits).toEqual([1]);
		});

		it("关闭同步抛异常：记一行，退出码 1", async () => {
			install(() => {
				throw new Error("同步抛的");
			});

			proc.emit(event, new Error("缺陷"));
			await settle();

			expect(exits).toEqual([1]);
			expect(logs.some((l) => String(l[0]).includes("有序关闭时出错"))).toBe(true);
		});

		it("记日志抛异常又赶上关闭卡住：计时器是先起的，到时间照样退出", async () => {
			install(() => new Promise<void>(() => {}), 3_000);

			proc.emit(event, hostile());
			await vi.advanceTimersByTimeAsync(2_999);
			expect(exits).toEqual([]);
			await vi.advanceTimersByTimeAsync(1);

			expect(exits).toEqual([1]);
		});

		it("原因不是 Error（普通对象、字符串）：日志里只有类型，没有里面的值", async () => {
			install(async () => {});

			proc.emit(event, { token: "secret-token-value", password: "secret-password-value" });
			proc.emit(event, "secret-string-value");
			await settle();

			const printed = inspect(logs, { depth: 8 });
			expect(printed).toContain("不是 Error，类型 object");
			expect(printed).not.toContain("secret-token-value");
			expect(printed).not.toContain("secret-password-value");
			expect(printed).not.toContain("secret-string-value");
			expect(exits).toEqual([1]);
		});
	});

	it("卸掉之后不再处理", async () => {
		install(async () => {});
		guards?.uninstall();
		guards = undefined;

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

	/** 读 `cause` 就抛异常的错误（`safeError` 读它时抛）：记日志这一步会抛。 */
	const HOSTILE =
		'const hostile = () => Object.defineProperty(new Error("hostile-error"), "cause", { get() { throw new Error("getter-threw"); } });';

	it("未捕获的异常，而且记日志时抛了异常：仍然以退出码 1 退出（Node 默认是退出码 7、不经过关闭）", async () => {
		const result = await runScript(`${HOSTILE} setTimeout(() => { throw hostile(); }, 50);`);

		expect(result.code).toBe(1);
		expect(result.output).toContain("记不出来");
		expect(result.output).toContain("shutdown-called");
	}, 60_000);

	it("未处理的拒绝，而且记日志时抛了异常：仍然退出（以前进程会一直活着）", async () => {
		const result = await runScript(
			`${HOSTILE} setTimeout(() => { Promise.reject(hostile()); }, 50);`,
		);

		expect(result.code).toBe(1);
		expect(result.output).toContain("记不出来");
		expect(result.output).toContain("shutdown-called");
	}, 60_000);

	it("原因是普通对象：日志里只有类型，没有里面的值", async () => {
		const result = await runScript(
			'setTimeout(() => { Promise.reject({ token: "secret-token-value" }); }, 50);',
		);

		expect(result.code).toBe(1);
		expect(result.output).toContain("不是 Error，类型 object");
		expect(result.output).not.toContain("secret-token-value");
	}, 60_000);

	it("关闭卡住：等满超时（这里 400 毫秒）就退出，退出码仍是 1", async () => {
		const result = await runScript(
			'/* hang */ setTimeout(() => { throw new Error("boom-hang"); }, 50);',
		);

		expect(result.code).toBe(1);
		expect(result.output).toContain("400 毫秒还没有结束，直接退出");
	}, 60_000);
});

describe("main.ts 装了进程级的处理（真实的控制面进程）", () => {
	/**
	 * 真的 `src/main.ts`（和 `pnpm start` 一样从源码、连真的数据库）启动之后，在同一个进程里执行 `body`；
	 * 返回退出码和输出。进程自己退出，没退出就超时。
	 */
	async function runMainThen(body: string) {
		const database = await createTestDatabase("sfly_guards");
		const dataDir = await mkdtemp(join(tmpdir(), "sfly-guards-"));
		const script = `await import("./src/main.ts"); ${body}`;
		try {
			await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				cwd: serverDir,
				timeout: 60_000,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: process.env.HOME ?? "",
					DATABASE_URL: database.url,
					SFLY_DATA_DIR: dataDir,
					SFLY_HTTP_HOST: "127.0.0.1",
					SFLY_GRPC_HOST: "127.0.0.1",
					SFLY_HTTP_PORT: "0",
					SFLY_GRPC_PORT: "0",
				},
			});
			return { code: 0, output: "" };
		} catch (error) {
			const failed = error as { code?: number | string; stderr?: string; stdout?: string };
			return { code: failed.code, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
		} finally {
			await rm(dataDir, { recursive: true, force: true });
			await database.drop();
		}
	}

	it("未捕获的异常：控制面起来之后，进程记日志、有序关闭（控制面真的关了）、以退出码 1 退出", async () => {
		const result = await runMainThen(
			'setTimeout(() => { throw new Error("boom-main-uncaught"); }, 1500);',
		);

		expect(result.code, result.output).toBe(1);
		expect(result.output).toContain("sfly control plane");
		expect(result.output).toContain("boom-main-uncaught");
		expect(result.output).toContain("未捕获的异常");
	}, 90_000);

	it("未处理的拒绝：同样", async () => {
		const result = await runMainThen(
			'setTimeout(() => { Promise.reject(new Error("boom-main-rejection")); }, 1500);',
		);

		expect(result.code, result.output).toBe(1);
		expect(result.output).toContain("boom-main-rejection");
		expect(result.output).toContain("未处理的 Promise 拒绝");
	}, 90_000);
});
