import type { LogOrigin, RunView } from "./http/runs.js";

/**
 * 按运行合并日志的排序（#220，docs/ARCHITECTURE.md §6.3）。控制面的分页、实时推送、下载和前端插入实时行
 * 都用这里的同一个全序，所以往前读、往后读、插入得到的顺序相同：
 *
 * 1. 排序时间：这一行的控制面时间；没有控制面时间的旧行（升级之前写入的，只会是文件开头的若干行）用任务开始时间。
 * 2. 排序时间相同时按任务在运行视图里的位置（{@link RunLogTask.rank}）：链、链上的节点、尝试。
 * 3. 同一个任务内按 seq。
 *
 * 控制面写入时保证同一个任务内控制面时间随 seq 不减（后一行折算出的时间更早时记成上一行的时间），
 * 所以这个顺序在每个任务内就是 seq 顺序。
 */

/** 合并日志里的一个任务。 */
export interface RunLogTask {
	origin: LogOrigin;
	/** 排序时间相同时的先后：任务在运行视图里的位置，从 0 开始。 */
	rank: number;
	/** 任务开始时间（毫秒，没有开始时间时用排队时间）：旧行的排序时间。 */
	startMs: number;
}

/** 一行在合并日志里的排序键。 */
export interface RunLogKey {
	time: number;
	rank: number;
	seq: number;
}

/** 运行里的全部任务，按运行视图里链（`run.chains`）、链上的节点、尝试的顺序。 */
export function runLogTasks(run: RunView): RunLogTask[] {
	const tasks: RunLogTask[] = [];
	for (const chain of run.chains) {
		for (const node of chain.nodes) {
			for (const attempt of node.attempts) {
				tasks.push({
					origin: {
						task_id: attempt.task_id,
						chain_instance_id: chain.id,
						subflow: chain.name,
						node_id: node.node_id,
						attempt: attempt.attempt,
					},
					rank: tasks.length,
					startMs: Date.parse(attempt.started_at ?? attempt.queued_at),
				});
			}
		}
	}
	return tasks;
}

export const runLogKey = (
	line: { seq: number; time: string | null },
	task: Pick<RunLogTask, "rank" | "startMs">,
): RunLogKey => ({
	time: line.time === null ? task.startMs : Date.parse(line.time),
	rank: task.rank,
	seq: line.seq,
});

/** 负数：a 排在 b 前面。 */
export const compareRunLogKeys = (a: RunLogKey, b: RunLogKey): number =>
	a.time - b.time || a.rank - b.rank || a.seq - b.seq;
