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
/** 浏览器里最多保留的行数：实时追加超过时丢掉最早的行（仍可向上滚动重新加载）。 */
export const MAX_LOADED_LINES = 5000;

/** 已加载的一行及其在日志文件中的字节偏移（用于翻页和补缺口）。 */
type LoadedLine = LogLine & { offset: number };

const encoder = new TextEncoder();
/** 一行在日志文件中占的字节数（文件是 JSONL，与服务端 log-routes.ts 的计算一致）。 */
const lineBytes = (line: LogLine) => encoder.encode(`${JSON.stringify(line)}\n`).length;

/** 实时推送的一批行加上偏移，并算出这批行之后的偏移。 */
function withOffsets(chunk: LogChunk): { lines: LoadedLine[]; end: number } {
	let offset = chunk.offset;
	const lines = chunk.lines.map((line) => {
		const loaded = { ...line, offset };
		offset += lineBytes(line);
		return loaded;
	});
	return { lines, end: offset };
}

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
export function mergeLines<L extends LogLine>(a: L[], b: L[]): L[] {
	if (b.length === 0) return a;
	const lastA = a.at(-1)?.seq ?? 0;
	const firstB = b[0]?.seq ?? 0;
	// 常见情况：新行都在已有行之后，或者更早的一页都在已有行之前。
	if (firstB > lastA) return [...a, ...b];
	if ((b.at(-1)?.seq ?? 0) < (a[0]?.seq ?? Number.POSITIVE_INFINITY)) return [...b, ...a];
	const bySeq = new Map<number, L>();
	for (const line of a) bySeq.set(line.seq, line);
	for (const line of b) bySeq.set(line.seq, line);
	return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

export interface LogViewState {
	/** 已加载、符合筛选条件的行（按序号），最多 {@link MAX_LOADED_LINES} 行。 */
	lines: LoadedLine[];
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
	/**
	 * start：往前翻页的位置（字节偏移）；end：已加载的行在文件里的结束位置（之前的行都已加载或可往前翻到）。
	 */
	const cursor = useRef({ start: 0, end: 0, generation: 0, loadingOlder: false });
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
				cursor.current.end = page.end;
				setState((s) => ({
					...s,
					lines: mergeLines(s.lines, page.lines),
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

	/** 追加行；超过上限时丢掉最早的行，并从第一条保留的行往前翻页。 */
	const append = useCallback((fresh: LoadedLine[]) => {
		if (fresh.length === 0) return;
		setState((s) => {
			const merged = mergeLines(s.lines, fresh);
			if (merged.length <= MAX_LOADED_LINES) return { ...s, lines: merged };
			const kept = merged.slice(-MAX_LOADED_LINES);
			// 重复调用时结果相同（StrictMode 下更新函数可能执行两次）。
			cursor.current.start = kept[0]?.offset ?? cursor.current.start;
			return { ...s, lines: kept, hasOlder: true };
		});
	}, []);

	const onLogs = useCallback(
		(data: unknown) => {
			const chunk = data as LogChunk;
			const { lines: all, end } = withOffsets(chunk);
			if (all.length > 0 && chunk.offset > cursor.current.end) {
				// 历史页读完到实时流连上（或断线重连）期间写入太多，实时流的第一批没有从缺口处开始：
				// 丢掉已加载的行，从这一批往前翻页，保证已加载的行在文件里是连续的。
				cursor.current.start = chunk.offset;
				setState((s) => ({ ...s, lines: [], hasOlder: true }));
			}
			if (all.length > 0) cursor.current.end = Math.max(cursor.current.end, end);
			const truncated = chunk.lines.some((l) => l.source === "system");
			append(all.filter((l) => matchesFilter(l, filterRef.current)));
			if (truncated) setState((s) => ({ ...s, truncated: true }));
		},
		[append],
	);
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
					lines: mergeLines(page.lines, s.lines),
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
