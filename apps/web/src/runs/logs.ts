import type { RunView } from "./api";

/** 任务日志与进度（#10）。字段与 apps/server/src/logs/task-logs.ts 一致。 */

export interface LogLine {
	/** 任务内从 1 开始递增的序号，用来去重。 */
	seq: number;
	time: string;
	/** system：控制面写入的截断标记（#18）。 */
	source: "stdout" | "stderr" | "sdk" | "system";
	level: "debug" | "info" | "warn" | "error";
	/** secret 参数的值已在控制面替换成掩码。 */
	text: string;
}

export interface LogChunk {
	task_id: string;
	lines: LogLine[];
	/** 第一行在日志文件中的字节偏移。 */
	offset: number;
}

export interface TaskProgress {
	current: number;
	/** 总数；未知时为 null。 */
	total: number | null;
	message: string;
	time: string;
}

/** 运行 SSE 上的 `progress` 事件。 */
export interface ProgressEvent {
	run_id: string;
	chain_instance_id: string;
	node_id: string;
	task_id: string;
	progress: TaskProgress;
}

export const taskLogsPath = (taskId: string) => `/tasks/${taskId}/logs/events`;

/** 把一条进度推送合并进运行视图（只改对应尝试的 progress）。 */
export function applyProgress(run: RunView | undefined, event: ProgressEvent): RunView | undefined {
	if (!run) return run;
	return {
		...run,
		chains: run.chains.map((chain) =>
			chain.id !== event.chain_instance_id
				? chain
				: {
						...chain,
						nodes: chain.nodes.map((node) =>
							node.node_id !== event.node_id
								? node
								: {
										...node,
										attempts: node.attempts.map((a) =>
											a.task_id === event.task_id ? { ...a, progress: event.progress } : a,
										),
									},
						),
					},
		),
	};
}

/** 进度的百分比（0–100）；总数未知时为 null。 */
export function progressPercent(p: TaskProgress): number | null {
	if (p.total === null || p.total <= 0) return null;
	return Math.max(0, Math.min(100, (p.current / p.total) * 100));
}

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** 卡片上的进度文字：`67%`，总数未知时为当前值。 */
export function progressShort(p: TaskProgress): string {
	const percent = progressPercent(p);
	return percent === null ? num(p.current) : `${Math.floor(percent)}%`;
}

/** 完整的进度文字：`2 / 3 · 建立连接`。 */
export function progressLong(p: TaskProgress): string {
	const count = p.total === null ? num(p.current) : `${num(p.current)} / ${num(p.total)}`;
	return p.message ? `${count} · ${p.message}` : count;
}
