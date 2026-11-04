import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "#/lib/api";
import { useEventSource } from "#/lib/sse";
import { type LogChunk, type LogLine, taskLogsPath } from "./logs";

/** 完整日志（#18）：按偏移量分页读取历史，再接上实时流。字段与 apps/server/src/http/log-routes.ts 一致。 */

export const LOG_LEVELS: ReadonlyArray<LogLine["level"]> = ["debug", "info", "warn", "error"];
export const LOG_SOURCES: ReadonlyArray<LogLine["source"]> = ["stdout", "stderr", "sdk", "system"];

/** 空集合表示不筛选。 */
export interface LogFilter {
	levels: ReadonlySet<LogLine["level"]>;
	sources: ReadonlySet<LogLine["source"]>;
}

export interface LogPage {
	task_id: string;
	lines: Array<LogLine & { offset: number }>;
	start: number;
	end: number;
	size: number;
	last_seq: number;
	truncated: boolean;
	expired: boolean;
}

/** 每页行数。 */
const PAGE = 300;

export const taskLogDownloadPath = (taskId: string) => `/api/tasks/${taskId}/logs/download`;

const query = (filter: LogFilter, extra: Record<string, string | number>) => {
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
	if (filter.levels.size > 0) params.set("level", [...filter.levels].join(","));
	if (filter.sources.size > 0) params.set("source", [...filter.sources].join(","));
	return params.toString();
};

export const matchesFilter = (line: LogLine, filter: LogFilter) =>
	(filter.levels.size === 0 || filter.levels.has(line.level)) &&
	(filter.sources.size === 0 || filter.sources.has(line.source));

/** 按序号合并两组行（去重，结果按序号排序）。 */
export function mergeLines(a: LogLine[], b: LogLine[]): LogLine[] {
	if (b.length === 0) return a;
	const lastA = a.at(-1)?.seq ?? 0;
	const firstB = b[0]?.seq ?? 0;
	// 常见情况：新行都在已有行之后，或者更早的一页都在已有行之前。
	if (firstB > lastA) return [...a, ...b];
	if ((b.at(-1)?.seq ?? 0) < (a[0]?.seq ?? Number.POSITIVE_INFINITY)) return [...b, ...a];
	const bySeq = new Map<number, LogLine>();
	for (const line of a) bySeq.set(line.seq, line);
	for (const line of b) bySeq.set(line.seq, line);
	return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

export interface LogViewState {
	/** 已加载、符合筛选条件的行（按序号）。 */
	lines: LogLine[];
	loaded: boolean;
	/** 还有更早的行可以加载。 */
	hasOlder: boolean;
	loadingOlder: boolean;
	truncated: boolean;
	expired: boolean;
	error: string | null;
}

/**
 * 一个任务的完整日志：先读最后一页历史（按筛选条件，服务端筛选），再用 `after_seq` 接上实时流
 * （实时行在浏览器里按同样的条件筛选），按序号去重；`loadOlder()` 往前翻页。
 * 换任务时请换组件实例（key 用任务 ID）；筛选条件变化时重新加载。
 */
export function useLogView(taskId: string, filter: LogFilter) {
	const [state, setState] = useState<LogViewState>({
		lines: [],
		loaded: false,
		hasOlder: false,
		loadingOlder: false,
		truncated: false,
		expired: false,
		error: null,
	});
	/** 往前翻页的位置（字节偏移），以及实时流从哪个序号之后开始。 */
	const cursor = useRef({ start: 0, generation: 0, loadingOlder: false });
	const [stream, setStream] = useState<string | null>(null);
	const filterRef = useRef(filter);
	filterRef.current = filter;
	const filterKey = `${[...filter.levels].sort().join(",")}|${[...filter.sources].sort().join(",")}`;

	// biome-ignore lint/correctness/useExhaustiveDependencies: filterKey 代表 filter 的内容
	useEffect(() => {
		const generation = ++cursor.current.generation;
		cursor.current.loadingOlder = false;
		setStream(null);
		setState((s) => ({ ...s, lines: [], loaded: false, hasOlder: false, error: null }));
		apiGet<LogPage>(`/tasks/${taskId}/logs?${query(filterRef.current, { limit: PAGE })}`)
			.then((page) => {
				if (cursor.current.generation !== generation) return;
				cursor.current.start = page.start;
				setState((s) => ({
					...s,
					lines: mergeLines(s.lines, page.lines.map(stripOffset)),
					loaded: true,
					hasOlder: page.start > 0,
					truncated: page.truncated,
					expired: page.expired,
				}));
				setStream(`${taskLogsPath(taskId)}?after_seq=${page.last_seq}`);
			})
			.catch((error: Error) => {
				if (cursor.current.generation === generation)
					setState((s) => ({ ...s, loaded: true, error: error.message }));
			});
	}, [taskId, filterKey]);

	const onLogs = useCallback((data: unknown) => {
		const chunk = data as LogChunk;
		const fresh = chunk.lines.filter((l) => matchesFilter(l, filterRef.current));
		const truncated = chunk.lines.some((l) => l.source === "system");
		if (fresh.length === 0 && !truncated) return;
		setState((s) => ({
			...s,
			lines: mergeLines(s.lines, fresh),
			truncated: s.truncated || truncated,
		}));
	}, []);
	useEventSource(stream, { logs: onLogs });

	const loadOlder = useCallback(() => {
		const { start, generation, loadingOlder } = cursor.current;
		if (start <= 0 || loadingOlder) return;
		cursor.current.loadingOlder = true;
		setState((s) => ({ ...s, loadingOlder: true }));
		apiGet<LogPage>(
			`/tasks/${taskId}/logs?${query(filterRef.current, { limit: PAGE, before: start })}`,
		)
			.then((page) => {
				cursor.current.loadingOlder = false;
				if (cursor.current.generation !== generation) return;
				cursor.current.start = page.start;
				setState((s) => ({
					...s,
					lines: mergeLines(s.lines, page.lines.map(stripOffset)),
					hasOlder: page.start > 0,
					loadingOlder: false,
				}));
			})
			.catch((error: Error) => {
				cursor.current.loadingOlder = false;
				setState((s) => ({ ...s, loadingOlder: false, error: error.message }));
			});
	}, [taskId]);

	return { ...state, loadOlder };
}

function stripOffset({ offset: _, ...line }: LogLine & { offset: number }): LogLine {
	return line;
}
