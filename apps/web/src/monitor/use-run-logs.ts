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
import {
	emptyRunBuffer,
	fromLatestPage,
	needsOlder,
	olderCursor,
	type RunLogBuffer,
	withOlderPage,
} from "./run-log-buffer";

/** 一页的行数。 */
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
 * 一次运行里范围内节点合并后的日志（没选中节点时的日志视图）：先读最新一页，`loadOlder()` 用 before 游标往前翻页（#223）。
 * `scope` 是节点范围（不给是全部节点），`levels` 是级别筛选（空表示不筛选），都在服务端执行（#224）。
 * 运行、范围或级别变化时从最新一页重新读：游标只对同一组范围和级别有效。
 * 筛选很少匹配时一页可以一行都没有，这时自动接着往前读，直到读到行或读到开头；读取失败就停下，由用户点击重试。
 * 状态的合并规则在 run-log-buffer.ts（有单测）。
 */
export function useRunLogs(
	runId: string,
	scope: RunLogScope | undefined,
	levels: readonly LogLineView["level"][],
): RunLogs {
	const [buffer, setBuffer] = useState<RunLogBuffer>(emptyRunBuffer);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);
	const loading = useRef(false);
	const bufferRef = useRef(buffer);
	bufferRef.current = buffer;
	const nodes = scope && encodeRunLogScope(scope);
	const level = levels.join(",");
	const query = useMemo(
		() => ({
			limit: PAGE,
			...(nodes === undefined ? {} : { nodes }),
			...(level ? { level } : {}),
		}),
		[nodes, level],
	);

	useEffect(() => {
		const current = ++generation.current;
		loading.current = false;
		setBuffer(emptyRunBuffer);
		setError(null);
		setLoadingOlder(false);
		callApi(logsApi.runPage, { params: { id: runId }, query })
			.then((page) => {
				if (generation.current === current) setBuffer(fromLatestPage(page));
			})
			.catch((e: Error) => {
				if (generation.current !== current) return;
				setBuffer({ ...emptyRunBuffer, loaded: true });
				setError(e.message);
			});
	}, [runId, query]);

	const loadOlder = useCallback(() => {
		const before = olderCursor(bufferRef.current);
		if (before === null || loading.current) return;
		const current = generation.current;
		loading.current = true;
		setLoadingOlder(true);
		setError(null);
		callApi(logsApi.runPage, { params: { id: runId }, query: { ...query, before } })
			.then((page) => {
				if (generation.current === current) setBuffer((b) => withOlderPage(b, page));
			})
			.catch((e: Error) => generation.current === current && setError(e.message))
			.finally(() => {
				if (generation.current !== current) return;
				loading.current = false;
				setLoadingOlder(false);
			});
	}, [runId, query]);

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
