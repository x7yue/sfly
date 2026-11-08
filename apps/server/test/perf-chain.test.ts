// 性能测试「短节点链路」（perf/items/10-short-node-chain.ts）从控制面时间戳算耗时的纯逻辑。
import { describe, expect, it } from "vitest";
import { type ChainRun, chainTimings, median } from "../perf/chain.js";

/** 一次运行：从 runStart 开始，每个任务在 starts[i] 开始、执行 exec 毫秒；运行在最后一个任务结束后 tail 毫秒结束。 */
function run(runStart: number, starts: number[], exec: number, tail = 5): ChainRun {
	const tasks = starts.map((s) => ({ startedMs: s, endedMs: s + exec }));
	return { startedMs: runStart, endedMs: (tasks.at(-1)?.endedMs ?? runStart) + tail, tasks };
}

describe("中位数（median）", () => {
	it("奇数个样本取中间那个，偶数个取中间两个的平均，与顺序无关", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(median([7])).toBe(7);
	});

	it("没有样本时为 NaN", () => {
		expect(median([])).toBeNaN();
	});
});

describe("单链运行的耗时（chainTimings）", () => {
	it("每节点端到端取相邻节点开始时间之差的中位数，不含触发运行到第一个节点开始的时间", () => {
		// 第一个节点在运行开始 500 ms 后才开始（安装、派发），之后每 40 ms 一个节点。
		const timings = chainTimings([run(0, [500, 540, 580, 620], 30)]);
		expect(timings).toMatchObject({ runs: 1, perNodeMs: 40, samples: 3, chainMs: 655 });
	});

	it("多次运行的差值放在一起取中位数，个别被拖慢的节点不影响结果；p95 取到慢的那些", () => {
		const fast = run(0, [10, 50, 90, 130, 170], 30);
		const slow = run(1000, [1010, 1050, 1350, 1390, 1430], 30);
		const timings = chainTimings([fast, slow]);
		// 差值：40 ×4、40、300、40、40 → 中位数 40，p95 是 300。
		expect(timings?.perNodeMs).toBe(40);
		expect(timings?.perNodeP95Ms).toBe(300);
		expect(timings?.samples).toBe(8);
	});

	it("整条链用时取各次运行（运行开始到结束）的中位数", () => {
		const timings = chainTimings([
			run(0, [10, 50], 30, 10), // 90
			run(0, [10, 50], 30, 30), // 110
			run(0, [10, 50], 30, 1000), // 1080
		]);
		expect(timings?.chainMs).toBe(110);
	});

	it("把每个节点分成任务执行（开始到结束）与节点之间（上一个结束到下一个开始）", () => {
		const timings = chainTimings([run(0, [0, 100, 200, 300], 70)]);
		expect(timings?.executionMs).toBe(70);
		expect(timings?.betweenMs).toBe(30);
		expect((timings?.executionMs ?? 0) + (timings?.betweenMs ?? 0)).toBe(timings?.perNodeMs);
	});

	it("没有运行、或每次运行都不到两个节点时算不出每节点耗时，为 null", () => {
		expect(chainTimings([])).toBeNull();
		expect(chainTimings([run(0, [10], 30), run(0, [], 0)])).toBeNull();
	});
});
