import { useCallback, useState } from "react";
import { useEventSource } from "#/lib/sse";
import type { RunView } from "./api";

/** 任务日志与进度（#10）。字段与 apps/server/src/logs/task-logs.ts 一致。 */

export interface LogLine {
	/** 任务内从 1 开始递增的序号，用来去重。 */
	seq: number;
	time: string;
	source: "stdout" | "stderr" | "sdk";
	level: "debug" | "info" | "warn" | "error";
	/** secret 参数的值已在控制面替换成掩码。 */
	text: string;
}

export interface LogChunk {
	task_id: string;
	lines: LogLine[];
	/** 第一行在日志文件中的字节偏移（#18 按偏移量分页时用）。 */
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

/** 浏览器里最多保留的日志行数（更早的行由 #18 的分页查看）。 */
export const TAIL_LIMIT = 2000;

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

/**
 * 订阅一个任务的日志尾部：连上时收到已有日志的尾部，之后实时追加；按序号去重，最多保留 {@link TAIL_LIMIT} 行。
 * 任务结束后流也保持打开（结果之后才到的日志照样追加），组件卸载时关闭。
 * 换任务时请换一个组件实例（key 用任务 ID），状态不会跨任务保留。
 */
export function useTaskLogs(taskId: string) {
	const [lines, setLines] = useState<LogLine[]>([]);
	const [loaded, setLoaded] = useState(false);
	const onLogs = useCallback((data: unknown) => {
		const chunk = data as LogChunk;
		setLines((current) => {
			const last = current.at(-1)?.seq ?? 0;
			const fresh = chunk.lines.filter((l) => l.seq > last);
			// 断线重连后的尾部可能和已有的行交错：按序号合并去重。
			const merged =
				fresh.length === chunk.lines.length
					? [...current, ...fresh]
					: mergeBySeq(current, chunk.lines);
			return merged.slice(-TAIL_LIMIT);
		});
		setLoaded(true);
	}, []);
	useEventSource(taskLogsPath(taskId), { logs: onLogs });
	return { lines, loaded };
}

function mergeBySeq(a: LogLine[], b: LogLine[]): LogLine[] {
	const bySeq = new Map<number, LogLine>();
	for (const line of a) bySeq.set(line.seq, line);
	for (const line of b) bySeq.set(line.seq, line);
	return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}
