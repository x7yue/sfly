import { describe, expect, it } from "vitest";
import { liveRunIds, MAX_LIVE_RUN_STREAMS, type RunProbe } from "./live-runs";

// 会话页上哪几个运行开事件流（#551）：浏览器对同源只给 6 条连接（整个浏览器共用，不分标签页），会话页自己已占一条（会话的事件流），
// 人常常还开着一个运行监控标签页。在跑的运行每个再开一条的话，五个在跑的运行就把发送、停止、结束会话的请求饿死。
// 所以最近的两个、第一次读到「在跑」的运行开，其余的靠定时重新读。

const runs = (count: number) =>
	Array.from({ length: count }, (_, n) => ({ seq: 10 + n, runId: `run-${n + 1}` }));
const allRunning = (_id: string): RunProbe => "running";
const pick = (list: ReturnType<typeof runs>, probe: (id: string) => RunProbe, limit?: number) =>
	[...liveRunIds(list, probe, limit)].sort();

describe("会话页上哪几个运行开事件流", () => {
	it("上限是 2：会话的事件流 1 条、运行的 2 条、一个运行监控标签页 1 条，六条连接里给页面的请求留两条（定 3 只剩一条）", () => {
		expect(MAX_LIVE_RUN_STREAMS).toBe(2);
		// 整个浏览器共用 6 条：会话页最多占 1 + 上限，再加一个运行监控标签页的 1 条，剩下的要大于 1。
		expect(6 - (1 + MAX_LIVE_RUN_STREAMS + 1)).toBeGreaterThanOrEqual(2);
	});

	it("在跑的运行不多于上限：都开", () => {
		expect(pick(runs(1), allRunning)).toEqual(["run-1"]);
		expect(pick(runs(2), allRunning)).toEqual(["run-1", "run-2"]);
		expect(liveRunIds([], allRunning).size).toBe(0);
	});

	it("在跑的运行多于上限：最近的两个开（事件序号大的），其余的不开", () => {
		expect(pick(runs(6), allRunning)).toEqual(["run-5", "run-6"]);
	});

	it("结束了的运行不占名额：名额留给更早的、还在跑的", () => {
		const status = (id: string): RunProbe =>
			id === "run-5" || id === "run-6" ? "success" : "running";
		expect(pick(runs(6), status)).toEqual(["run-3", "run-4"]);
	});

	it("取消了的、失败了的也都是结束了的", () => {
		const status = (id: string): RunProbe =>
			id === "run-6" ? "cancelled" : id === "run-5" ? "failed" : "running";
		expect(pick(runs(6), status)).toEqual(["run-3", "run-4"]);
	});

	it("一个结束了就释放名额，下一个在跑的接上：名额里始终是最近的、还在跑的两个", () => {
		const finished = new Set<string>();
		const status = (id: string): RunProbe => (finished.has(id) ? "success" : "running");
		const now = () => pick(runs(5), status);
		expect(now()).toEqual(["run-4", "run-5"]);
		finished.add("run-5");
		expect(now()).toEqual(["run-3", "run-4"]);
		finished.add("run-3");
		expect(now()).toEqual(["run-2", "run-4"]);
		finished.add("run-4").add("run-2").add("run-1");
		expect(now()).toEqual([]);
	});

	describe("第一次读到「在跑」才给名额", () => {
		it("还在读第一次的（刚打开页面）一个也不给：先靠轮询", () => {
			expect(liveRunIds(runs(5), () => "loading").size).toBe(0);
		});

		it("运行都已结束的会话：打开后一个名额也不给（没有一条运行事件流）", () => {
			expect(liveRunIds(runs(6), () => "success").size).toBe(0);
		});

		it("读不到的运行（运行已经被清理）不占名额，也不挡着更早的、读到了在跑的", () => {
			const status = (id: string): RunProbe =>
				id === "run-5" || id === "run-6" ? "unreadable" : "running";
			expect(pick(runs(6), status)).toEqual(["run-3", "run-4"]);
		});

		it("更近的运行还在读第一次时，更早的先等着：不会先给更早的、又被更近的挤掉（开了又关一条没必要的流）", () => {
			// 第一次读的回应先后不一：更早的 run-1 先读到「在跑」，最近的 run-3 还在读。
			const arriving = new Map<string, RunProbe>([
				["run-1", "running"],
				["run-2", "loading"],
				["run-3", "loading"],
			]);
			const probe = (id: string): RunProbe => arriving.get(id) ?? "loading";
			expect(pick(runs(3), probe)).toEqual([]);
			// 最近的读到了在跑：它先占；它之后还在读的挡着更早的。
			arriving.set("run-3", "running");
			expect(pick(runs(3), probe)).toEqual(["run-3"]);
			// 都读完了：最近的两个在跑的。
			arriving.set("run-2", "running");
			expect(pick(runs(3), probe)).toEqual(["run-2", "run-3"]);
			// 每个运行从没有名额到有名额只变一次：run-1 一直没有被给过。
		});

		it("最近的已结束时更早的才往下：已结束算有了结果，不挡后面的", () => {
			const status = (id: string): RunProbe =>
				id === "run-3" ? "success" : id === "run-2" ? "loading" : "running";
			expect(pick(runs(3), status)).toEqual([]);
			expect(pick(runs(3), (id) => (id === "run-3" ? "success" : "running"))).toEqual([
				"run-1",
				"run-2",
			]);
		});
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
		expect([...liveRunIds(list, allRunning)].sort()).toEqual(["a", "b"]);
	});
});
