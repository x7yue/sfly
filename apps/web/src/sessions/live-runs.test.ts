import type { RunStatus } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { liveRunIds, MAX_LIVE_RUN_STREAMS } from "./live-runs";

// 会话页上哪几个运行开事件流（#551）：浏览器对同源只给 6 条连接，会话页自己已占一条（会话的事件流），
// 在跑的运行每个再开一条的话，五个在跑的运行就把发送、停止、结束会话的请求饿死。所以最近的几个在跑的运行开，其余的靠定时重新读。

const runs = (count: number) =>
	Array.from({ length: count }, (_, n) => ({ seq: 10 + n, runId: `run-${n + 1}` }));
const allRunning = (_id: string): RunStatus | undefined => "running";

describe("会话页上哪几个运行开事件流", () => {
	it("上限是 3：会话页自己的事件流加三条运行的，六条连接里留两条给页面的请求", () => {
		expect(MAX_LIVE_RUN_STREAMS).toBe(3);
	});

	it("在跑的运行不多于上限：都开", () => {
		expect([...liveRunIds(runs(2), allRunning)].sort()).toEqual(["run-1", "run-2"]);
		expect(liveRunIds([], allRunning).size).toBe(0);
	});

	it("在跑的运行多于上限：最近的几个开（事件序号大的），其余的不开", () => {
		expect([...liveRunIds(runs(6), allRunning)].sort()).toEqual(["run-4", "run-5", "run-6"]);
	});

	it("结束了的运行不占名额：名额留给更早的、还在跑的", () => {
		const status = (id: string): RunStatus =>
			id === "run-5" || id === "run-6" ? "success" : "running";
		expect([...liveRunIds(runs(6), status)].sort()).toEqual(["run-2", "run-3", "run-4"]);
	});

	it("还没读到状态的运行当作在跑（和定时重新读的规则一样），读到结束了才让出名额", () => {
		const unknown = (): RunStatus | undefined => undefined;
		expect([...liveRunIds(runs(5), unknown)].sort()).toEqual(["run-3", "run-4", "run-5"]);
	});

	it("取消了的、失败了的也都是结束了的", () => {
		const status = (id: string): RunStatus =>
			id === "run-6" ? "cancelled" : id === "run-5" ? "failed" : "running";
		expect([...liveRunIds(runs(6), status)].sort()).toEqual(["run-2", "run-3", "run-4"]);
	});

	it("同一个运行在清单里出现两次只占一个名额；清单不要求按序号排好", () => {
		const list = [
			{ seq: 30, runId: "a" },
			{ seq: 10, runId: "b" },
			{ seq: 20, runId: "a" },
			{ seq: 5, runId: "c" },
			{ seq: 6, runId: "d" },
		];
		expect([...liveRunIds(list, allRunning, 3)].sort()).toEqual(["a", "b", "d"]);
	});
});
