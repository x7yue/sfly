import { type LogLineView, logsApi } from "@sfly/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, callApi } from "#/lib/api";
import { useEventSource } from "#/lib/sse";
import {
	emptyBuffer,
	fromLatestPage,
	fromLocatedPage,
	type LogBuffer,
	reachedEnd,
	withLive,
	withNewerPage,
	withOlderPage,
} from "./log-buffer";

/** 每页行数。 */
const PAGE = 300;

/** 分页请求的查询：每页 {@link PAGE} 行，加上级别筛选（`levelKey` 为空表示不筛选）和位置（定位的时刻，或往前、往后翻页的起点）。 */
const pageQuery = (
	levelKey: string,
	position: { at?: string; before?: number; after?: number },
) => ({ limit: PAGE, ...(levelKey ? { level: levelKey } : {}), ...position });

export const taskLogDownloadPath = (taskId: string) =>
	apiUrl(logsApi.download, { params: { id: taskId } });

export interface TaskLogs extends LogBuffer {
	loadingOlder: boolean;
	loadingNewer: boolean;
	error: string | null;
	loadOlder: () => void;
	loadNewer: () => void;
}

/** 要在日志里定位的时刻（控制面时间，毫秒）；`request` 变了就重新定位（monitor-state.tsx 的 logMoment）。 */
export interface LogMoment {
	at: number;
	request: number;
}

/**
 * 一个任务的日志：先读最后一页历史（levels 为空表示不筛选，服务端筛选），再用 `after_seq` 接上实时流，
 * `loadOlder()` 往前翻页。状态的合并规则在 log-buffer.ts（有单测）。任务或筛选条件变化时重新加载。
 *
 * 给了 `moment` 时先读包含那一刻的一页（#347）：它在日志中间，之后还有行（`hasNewer`）时不连实时流，
 * `loadNewer()` 用 `after` 往后翻页，读到文件末尾后再接上实时流，之后与最后一页的情形相同。
 */
export function useTaskLogs(
	taskId: string,
	levels: readonly LogLineView["level"][],
	moment: LogMoment | null = null,
): TaskLogs {
	const [buffer, setBuffer] = useState<LogBuffer>(emptyBuffer);
	/** 实时流从这个序号之后接上；null 表示还没读到历史（或还没往后翻到末尾），不连接。 */
	const [afterSeq, setAfterSeq] = useState<number | null>(null);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [loadingNewer, setLoadingNewer] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);
	const bufferRef = useRef(buffer);
	bufferRef.current = buffer;
	const levelKey = levels.join(",");
	const at = moment === null ? null : new Date(moment.at).toISOString();
	const request = moment?.request;
	const accept = useRef<(line: LogLineView) => boolean>(() => true);
	accept.current = (line) => levelKey === "" || levelKey.split(",").includes(line.level);

	// biome-ignore lint/correctness/useExhaustiveDependencies: request 变了（同一时刻再次请求）也要重新定位
	useEffect(() => {
		const current = ++generation.current;
		setBuffer(emptyBuffer);
		setAfterSeq(null);
		setError(null);
		setLoadingOlder(false);
		setLoadingNewer(false);
		callApi(logsApi.page, {
			params: { id: taskId },
			query: pageQuery(levelKey, at ? { at } : {}),
		})
			.then((page) => {
				if (generation.current !== current) return;
				setBuffer(page.locate ? fromLocatedPage(page) : fromLatestPage(page));
				if (!page.locate || reachedEnd(page)) setAfterSeq(page.last_seq);
			})
			.catch((e: Error) => {
				if (generation.current !== current) return;
				setBuffer({ ...emptyBuffer, loaded: true });
				setError(e.message);
			});
	}, [taskId, levelKey, at, request]);

	useEventSource(
		logsApi.events,
		afterSeq === null ? null : { params: { id: taskId }, query: { after_seq: String(afterSeq) } },
		{ logs: (chunk) => setBuffer((b) => withLive(b, chunk, accept.current)) },
	);

	const loadOlder = useCallback(() => {
		const { start, hasOlder } = bufferRef.current;
		if (!hasOlder || loadingOlder) return;
		const current = generation.current;
		setLoadingOlder(true);
		callApi(logsApi.page, {
			params: { id: taskId },
			query: pageQuery(levelKey, { before: start }),
		})
			.then((page) => {
				if (generation.current !== current) return;
				setBuffer((b) => withOlderPage(b, page));
			})
			.catch((e: Error) => generation.current === current && setError(e.message))
			.finally(() => generation.current === current && setLoadingOlder(false));
	}, [taskId, levelKey, loadingOlder]);

	const loadNewer = useCallback(() => {
		const { end, hasNewer } = bufferRef.current;
		if (!hasNewer || loadingNewer) return;
		const current = generation.current;
		setLoadingNewer(true);
		callApi(logsApi.page, {
			params: { id: taskId },
			query: pageQuery(levelKey, { after: end }),
		})
			.then((page) => {
				if (generation.current !== current) return;
				setBuffer((b) => withNewerPage(b, page));
				if (reachedEnd(page)) setAfterSeq(page.last_seq);
			})
			.catch((e: Error) => generation.current === current && setError(e.message))
			.finally(() => generation.current === current && setLoadingNewer(false));
	}, [taskId, levelKey, loadingNewer]);

	return { ...buffer, loadingOlder, loadingNewer, error, loadOlder, loadNewer };
}
