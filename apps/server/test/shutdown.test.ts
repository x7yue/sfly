// 收到停止信号时关闭只做一次（#647）：重复的信号只记一句，关闭完成退出码 0，关闭出错记下来、退出码 1。
// 用假的 emitter、`exit` 和日志，不起进程；真正的进程里的接线在 `process-stream-errors.test.ts`。
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, installProcessGuards } from "../src/process-guards.js";
import { installShutdown, SHUTDOWN_TIMEOUT_MS } from "../src/shutdown.js";

function setup(close: () => Promise<void>, timeoutMs?: number) {
	const emitter = new EventEmitter();
	const logs: string[] = [];
	const errors: Array<[string, unknown?]> = [];
	const exits: number[] = [];
	let closes = 0;
	installShutdown({
		emitter: { on: (signal, listener) => emitter.on(signal, listener) },
		signals: ["SIGINT", "SIGTERM"],
		close: () => {
			closes += 1;
			return close();
		},
		exit: (code) => exits.push(code),
		log: (message) => logs.push(message),
		logError: (message, error) => errors.push([message, error]),
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	});
	return { emitter, logs, errors, exits, closes: () => closes };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("收到停止信号时关闭", () => {
	it("几个信号一起来（SIGINT、SIGTERM、SIGTERM）：关闭只做一次，只有一句「正在关闭」，其余各记一句「已经在关闭」，关完退出码 0、退出只调用一次", async () => {
		let finish: () => void = () => {};
		const closing = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const s = setup(() => closing);
		s.emitter.emit("SIGINT");
		s.emitter.emit("SIGTERM");
		s.emitter.emit("SIGTERM");
		expect(s.closes()).toBe(1);
		expect(s.logs).toEqual([
			"sfly: 收到 SIGINT，正在关闭",
			"sfly: 已经在关闭，忽略 SIGTERM",
			"sfly: 已经在关闭，忽略 SIGTERM",
		]);
		// 关闭还没完：不退出。
		await settle();
		expect(s.exits).toEqual([]);
		finish();
		await settle();
		expect(s.exits).toEqual([0]);
		// 关完之后再来信号：还是只记一句，不再关。
		s.emitter.emit("SIGINT");
		expect(s.closes()).toBe(1);
		expect(s.logs.at(-1)).toBe("sfly: 已经在关闭，忽略 SIGINT");
	});

	it("同一个信号来两次：第二次照样被处理（记一句），不是走默认处理", () => {
		const s = setup(() => new Promise(() => {}));
		s.emitter.emit("SIGTERM");
		s.emitter.emit("SIGTERM");
		expect(s.logs).toEqual(["sfly: 收到 SIGTERM，正在关闭", "sfly: 已经在关闭，忽略 SIGTERM"]);
		// 两个信号名都装了监听，每个监听可以被调用多次（不是 once）。
		expect(s.emitter.listenerCount("SIGINT")).toBe(1);
		expect(s.emitter.listenerCount("SIGTERM")).toBe(1);
	});

	it("关闭出错：记下错误、退出码 1，没有没人接的拒绝；之后的信号只记一句", async () => {
		const boom = new Error("关不掉");
		const s = setup(() => Promise.reject(boom));
		s.emitter.emit("SIGINT");
		await settle();
		expect(s.errors).toEqual([["sfly: 关闭时出错", boom]]);
		expect(s.exits).toEqual([1]);
		s.emitter.emit("SIGTERM");
		expect(s.closes()).toBe(1);
		expect(s.logs.at(-1)).toBe("sfly: 已经在关闭，忽略 SIGTERM");
	});

	it("关闭有上限：到时还没关完，记一句、以退出码 1 退出（不是 0）；期间重复的信号只记一句；之后关闭才完成也不再退出", async () => {
		let finish: () => void = () => {};
		const closing = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const s = setup(() => closing, 60);
		s.emitter.emit("SIGTERM");
		s.emitter.emit("SIGINT");
		s.emitter.emit("SIGINT");
		expect(s.logs).toEqual([
			"sfly: 收到 SIGTERM，正在关闭",
			"sfly: 已经在关闭，忽略 SIGINT",
			"sfly: 已经在关闭，忽略 SIGINT",
		]);
		// 上限之内：不退出。
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(s.exits).toEqual([]);
		// 到时：记一句、退出码 1，退出只调用一次。
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(s.exits).toEqual([1]);
		expect(s.errors).toHaveLength(1);
		expect(s.errors[0]?.[0]).toContain("还没有完成");
		// 到时之后关闭才完成：不再退出（进程已经退了；假的 exit 不会真的结束，这里确认没有第二次调用）。
		finish();
		await settle();
		expect(s.exits).toEqual([1]);
		expect(s.closes()).toBe(1);
	});

	it("在上限之内关完：退出码 0，不记超时，上限的计时器被清掉（之后不会再退出）", async () => {
		const s = setup(() => new Promise((resolve) => setTimeout(resolve, 20)), 80);
		s.emitter.emit("SIGINT");
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(s.exits).toEqual([0]);
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(s.exits).toEqual([0]);
		expect(s.errors).toEqual([]);
	});

	it("关闭出错发生在上限之后：已经以 1 退出，不再记「关闭时出错」", async () => {
		const s = setup(
			() => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("晚了")), 100)),
			30,
		);
		s.emitter.emit("SIGINT");
		await new Promise((resolve) => setTimeout(resolve, 160));
		expect(s.exits).toEqual([1]);
		expect(s.errors).toHaveLength(1);
		expect(s.errors[0]?.[0]).toContain("还没有完成");
	});
});

describe("停止信号的关闭和因错误的有序退出用同一个上限（默认值）", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("两个常量是同一个数", () => {
		expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(SHUTDOWN_TIMEOUT_MS);
	});

	it("关闭卡住不动（不传 timeoutMs）：停止信号的关闭和有序退出都在 SHUTDOWN_TIMEOUT_MS 毫秒整到时放弃，退出码 1，早一毫秒都不退", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		// 停止信号那一条。
		const s = setup(() => new Promise(() => {}));
		s.emitter.emit("SIGTERM");
		// 有序退出那一条。
		const proc = new EventEmitter();
		const guardExits: number[] = [];
		const guards = installProcessGuards({
			shutdown: () => new Promise(() => {}),
			proc: proc as unknown as NodeJS.Process,
			exit: (code) => guardExits.push(code),
		});
		guards.fatal("某个致命错误");

		await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS - 1);

		expect(s.exits).toEqual([]);
		expect(guardExits).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(s.exits).toEqual([1]);
		expect(guardExits).toEqual([1]);
		guards.uninstall();
	});
});
