import type { LogOrigin, RunLogLine, RunLogTaskOrder, RunView } from "./http/runs.js";

/**
 * 按运行合并日志的排序（#220，docs/ARCHITECTURE.md §6.3）。控制面的分页、实时推送、下载和前端插入实时行
 * 都用这里的同一个比较函数。一行的排序键只由行本身决定（每行带着 {@link RunLogTaskOrder}）：
 *
 * 1. 排序时间：这一行的控制面时间；没有控制面时间的旧行（升级之前写入的，只会是文件开头的若干行）用任务开始时间。
 * 2. 排序时间相同时按链（层级、开始时间、链路实例 ID）、节点在链上的位置、尝试序号：这些都不随运行的推进而改变，
 *    之后才出现的尝试和子流程实例不影响已有的行之间的先后。
 * 3. 同一个任务内按 seq。
 *
 * 不同任务之间按排序键多路归并，同一个任务内永远按 seq：控制面写入时把比上一行早不到 2 秒的控制面时间记成上一行的，
 * 所以一个任务的排序键通常随 seq 不减，归并结果就是按排序键排好的顺序；早得更多时保留原值（task-logs.ts），
 * 这个任务在那里的排序键会倒退，它的行仍按 seq，与别的任务交错的位置可能随读取方向不同。
 */

/** 合并日志里的一个任务：它的行的来源，和这些行排序要用的信息。 */
export interface RunLogTask {
	origin: LogOrigin;
	order: RunLogTaskOrder;
}

/** 一行在合并日志里的排序键。 */
export interface RunLogKey {
	time: number;
	chainDepth: number;
	chainStartedMs: number;
	chainInstanceId: string;
	nodeIndex: number;
	attempt: number;
	seq: number;
}

/** 运行里的全部任务，按运行视图里链（`run.chains`）、链上的节点、尝试的顺序。 */
export function runLogTasks(run: RunView): RunLogTask[] {
	return run.chains.flatMap((chain) =>
		chain.nodes.flatMap((node, nodeIndex) =>
			node.attempts.map((attempt) => ({
				origin: {
					task_id: attempt.task_id,
					chain_instance_id: chain.id,
					subflow: chain.name,
					node_id: node.node_id,
					attempt: attempt.attempt,
				},
				order: {
					chain_depth: chain.depth,
					chain_started_at: chain.started_at,
					node_index: nodeIndex,
					task_started_at: attempt.started_at ?? attempt.queued_at,
				},
			})),
		),
	);
}

export const runLogKey = (
	line: Pick<
		RunLogLine,
		| "seq"
		| "time"
		| "chain_instance_id"
		| "attempt"
		| "chain_depth"
		| "chain_started_at"
		| "node_index"
		| "task_started_at"
	>,
): RunLogKey => ({
	time: Date.parse(line.time ?? line.task_started_at),
	chainDepth: line.chain_depth,
	chainStartedMs: Date.parse(line.chain_started_at),
	chainInstanceId: line.chain_instance_id,
	nodeIndex: line.node_index,
	attempt: line.attempt,
	seq: line.seq,
});

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 负数：a 排在 b 前面。 */
export const compareRunLogKeys = (a: RunLogKey, b: RunLogKey): number =>
	a.time - b.time ||
	a.chainDepth - b.chainDepth ||
	a.chainStartedMs - b.chainStartedMs ||
	compareText(a.chainInstanceId, b.chainInstanceId) ||
	a.nodeIndex - b.nodeIndex ||
	a.attempt - b.attempt ||
	a.seq - b.seq;
