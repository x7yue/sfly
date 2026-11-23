// 收到停止信号时关闭只做一次（#647）：重复的信号只记一句，关闭完成退出码 0，关闭出错记下来、退出码 1。
// 用假的 emitter、`exit` 和日志，不起进程；真正的进程里的接线在 `process-stream-errors.test.ts`。
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installShutdown } from "../src/shutdown.js";

function setup(close: () => Promise<void>) {
	const emitter = new EventEmitter();
	const logs: string[] = [];
	const errors: Array<[string, unknown]> = [];
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
});
