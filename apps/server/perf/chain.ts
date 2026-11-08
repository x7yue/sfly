// 单链运行的耗时（纯逻辑，单测见 test/perf-chain.test.ts）：只用控制面已有的时间戳——运行的开始与结束、
// 每个任务的开始（Agent 上报执行器已启动、控制面记为 running）与结束（控制面收到结果）。
//
// 每节点端到端耗时取「相邻两个节点的开始时间之差」：从一个节点的执行器启动，到它退出、回报结果、控制面派发下一个
// 节点、Agent 启动下一个执行器，正好是链上一个节点的完整周期，与哪个时间戳偏早偏晚无关（两端是同一种时间戳）。
// 不用「整条链用时 ÷ 节点数」：它还包含触发运行到第一个节点开始、最后一个节点结束到运行结束，节点少时偏差大。
// 多次运行的差值放在一起取中位数：个别节点被机器上别的负载拖慢时，平均数会被拉高，中位数不会。
import { distribution } from "./latency.js";

/** 一个节点（链上一个任务）的开始与结束（毫秒）。 */
export interface ChainTask {
	startedMs: number;
	endedMs: number;
}

/** 一次单链运行：运行的开始与结束，以及链上的任务（按链上的顺序）。 */
export interface ChainRun {
	startedMs: number;
	endedMs: number;
	tasks: ChainTask[];
}

/** 几次同样的单链运行汇总出的耗时（毫秒）。 */
export interface ChainTimings {
	runs: number;
	/** 每节点端到端：相邻节点开始时间之差的中位数。 */
	perNodeMs: number;
	/** 相邻节点开始时间之差的 p95（最近秩法，同 latency.ts 的 distribution）。 */
	perNodeP95Ms: number;
	/** 每节点端到端的样本数（每次运行比节点数少 1）。 */
	samples: number;
	/** 整条链用时：运行开始到结束，各次运行的中位数。 */
	chainMs: number;
	/** 任务执行：任务开始到结束（执行器启动到控制面收到结果）的中位数。 */
	executionMs: number;
	/** 节点之间：上一个任务结束到下一个任务开始（控制面派发、Agent 准备并启动执行器）的中位数。 */
	betweenMs: number;
}

/** 中位数：样本数为偶数时取中间两个的平均；没有样本时为 NaN。 */
export function median(samples: readonly number[]): number {
	if (samples.length === 0) return Number.NaN;
	const sorted = [...samples].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** 相邻元素之差：`[b - a, c - b, …]`。 */
const gaps = <T>(items: readonly T[], diff: (prev: T, next: T) => number): number[] =>
	items.slice(1).map((next, i) => diff(items[i] as T, next));

/** 汇总几次单链运行；没有运行或每次运行都不到两个节点时为 null（算不出每节点耗时）。 */
export function chainTimings(runs: readonly ChainRun[]): ChainTimings | null {
	const perNode = runs.flatMap((r) => gaps(r.tasks, (a, b) => b.startedMs - a.startedMs));
	if (perNode.length === 0) return null;
	return {
		runs: runs.length,
		perNodeMs: median(perNode),
		perNodeP95Ms: distribution(perNode)?.p95 ?? Number.NaN,
		samples: perNode.length,
		chainMs: median(runs.map((r) => r.endedMs - r.startedMs)),
		executionMs: median(runs.flatMap((r) => r.tasks.map((t) => t.endedMs - t.startedMs))),
		betweenMs: median(runs.flatMap((r) => gaps(r.tasks, (a, b) => b.startedMs - a.endedMs))),
	};
}
