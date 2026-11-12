import {
	encodeRunLogScope,
	type LogLineView,
	type LogOrigin,
	logsApi,
	type RunLogLine,
	type RunLogScope,
} from "@sfly/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, callApi } from "#/lib/api";
import { useEventSource } from "#/lib/sse";
import {
	emptyRunBuffer,
	fromLatestPage,
	keepLatest,
	needsOlder,
	needsReload,
	olderCursor,
	type RunLogBuffer,
	withLiveLines,
	withOlderPage,
} from "./run-log-buffer";

const PAGE = 300;

/** 下载范围内整次运行合并后的日志（不受级别筛选影响）；`scope` 不给是全部节点。 */
export const runLogDownloadPath = (runId: string, scope: RunLogScope | undefined) =>
	apiUrl(logsApi.runDownload, {
		params: { id: runId },
		query: scope === undefined ? {} : { nodes: encodeRunLogScope(scope) },
	});

export interface RunLogs {
	lines: RunLogLine[];
	loaded: boolean;
	hasOlder: boolean;
	loadingOlder: boolean;
	loadOlder: () => void;
	truncatedTasks: LogOrigin[];
	expired: boolean;
	error: string | null;
}

/**
 * 一次运行里范围内节点合并后的日志（没选中节点时的日志视图）：先读最新一页，再从它的 `live_after` 接上实时推送（#225），
 * `loadOlder()` 用 before 游标往前翻页（#223）。
 * `scope` 是节点范围（不给是全部节点），`levels` 是级别筛选（空表示不筛选），读历史和实时推送都在服务端执行（#224）。
 * 运行、范围或级别变化时从最新一页重新读：游标只对同一组范围和级别有效。
 * 筛选很少匹配时一页可以一行都没有，这时自动接着往前读，直到读到行或读到开头；读取失败就停下，由用户点击重试。
 * 实时推送的行太多（或断线太久、控制面让重新读）时，断开实时推送、重新读最新一页再接上，读到之前照常显示已有的行。
 * 断线重连由浏览器的 EventSource 自己带上 Last-Event-ID 完成。状态的合并规则在 run-log-buffer.ts（有单测）。
 */
export function useRunLogs(
	runId: string,
	scope: RunLogScope | undefined,
	levels: readonly LogLineView["level"][],
): RunLogs {
	const [buffer, setBuffer] = useState<RunLogBuffer>(emptyRunBuffer);
	/** 实时推送从这里接上（最新一页的 live_after）；null：还没读到最新一页，或正在重新读，不连接。 */
	const [liveAfter, setLiveAfter] = useState<string | null>(null);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);
	/** 有一个读取（最新一页或更早的一页）还没返回：重新读最新一页期间不往前翻，旧缓冲区的游标不能用在新的上面。 */
	const loading = useRef(false);
	const bufferRef = useRef(buffer);
	bufferRef.current = buffer;
	const nodes = scope && encodeRunLogScope(scope);
	const level = levels.join(",");
	const filters = useMemo(
		() => ({ ...(nodes === undefined ? {} : { nodes }), ...(level ? { level } : {}) }),
		[nodes, level],
	);

	/** 读最新一页；fresh 时先清空（范围或级别变了），否则读到之前照常显示已有的行。 */
	const loadLatest = useCallback(
		(fresh: boolean) => {
			const current = ++generation.current;
			loading.current = true;
			setLiveAfter(null);
			setError(null);
			setLoadingOlder(false);
			if (fresh) setBuffer(emptyRunBuffer);
			callApi(logsApi.runPage, { params: { id: runId }, query: { ...filters, limit: PAGE } })
				.then((page) => {
					if (generation.current !== current) return;
					loading.current = false;
					setBuffer(fromLatestPage(page));
					if (!page.expired) setLiveAfter(page.live_after);
				})
				.catch((e: Error) => {
					if (generation.current !== current) return;
					loading.current = false;
					if (fresh) setBuffer({ ...emptyRunBuffer, loaded: true });
					setError(e.message);
				});
		},
		[runId, filters],
	);

	useEffect(() => loadLatest(true), [loadLatest]);

	useEventSource(
		logsApi.runEvents,
		liveAfter === null ? null : { params: { id: runId }, query: { ...filters, after: liveAfter } },
		{
			logs: (chunk) => setBuffer((b) => keepLatest(withLiveLines(b, chunk.lines))),
			reload: () => loadLatest(false),
		},
	);

	useEffect(() => {
		if (liveAfter !== null && needsReload(buffer)) loadLatest(false);
	}, [buffer, liveAfter, loadLatest]);

	const loadOlder = useCallback(() => {
		const before = olderCursor(bufferRef.current);
		if (before === null || loading.current) return;
		const current = generation.current;
		loading.current = true;
		setLoadingOlder(true);
		setError(null);
		callApi(logsApi.runPage, {
			params: { id: runId },
			query: { ...filters, limit: PAGE, before },
		})
			.then((page) => {
				if (generation.current === current) setBuffer((b) => withOlderPage(b, page));
			})
			.catch((e: Error) => generation.current === current && setError(e.message))
			.finally(() => {
				if (generation.current !== current) return;
				loading.current = false;
				setLoadingOlder(false);
			});
	}, [runId, filters]);

	useEffect(() => {
		if (error === null && needsOlder(buffer)) loadOlder();
	}, [buffer, error, loadOlder]);

	return {
		lines: buffer.lines,
		loaded: buffer.loaded,
		hasOlder: olderCursor(buffer) !== null,
		loadingOlder,
		loadOlder,
		truncatedTasks: buffer.truncatedTasks,
		expired: buffer.expired,
		error,
	};
}
