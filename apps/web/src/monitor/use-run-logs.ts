import { type LogOrigin, logsApi, type RunLogLine } from "@sfly/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { callApi } from "#/lib/api";
import {
	emptyRunBuffer,
	fromLatestPage,
	olderCursor,
	type RunLogBuffer,
	withOlderPage,
} from "./run-log-buffer";

/** 一页的行数。 */
const PAGE = 300;

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
 * 一次运行全部任务合并后的日志（没选中节点时的日志视图）：先读最新一页，`loadOlder()` 用 before 游标往前翻页（#223）。
 * 状态的合并规则在 run-log-buffer.ts（有单测）。换运行时重新加载。
 */
export function useRunLogs(runId: string): RunLogs {
	const [buffer, setBuffer] = useState<RunLogBuffer>(emptyRunBuffer);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);
	const bufferRef = useRef(buffer);
	bufferRef.current = buffer;

	useEffect(() => {
		const current = ++generation.current;
		setBuffer(emptyRunBuffer);
		setError(null);
		setLoadingOlder(false);
		callApi(logsApi.runPage, { params: { id: runId }, query: { limit: PAGE } })
			.then((page) => {
				if (generation.current === current) setBuffer(fromLatestPage(page));
			})
			.catch((e: Error) => {
				if (generation.current !== current) return;
				setBuffer({ ...emptyRunBuffer, loaded: true });
				setError(e.message);
			});
	}, [runId]);

	const loadOlder = useCallback(() => {
		const before = olderCursor(bufferRef.current);
		if (before === null || loadingOlder) return;
		const current = generation.current;
		setLoadingOlder(true);
		callApi(logsApi.runPage, { params: { id: runId }, query: { limit: PAGE, before } })
			.then((page) => {
				if (generation.current === current) setBuffer((b) => withOlderPage(b, page));
			})
			.catch((e: Error) => generation.current === current && setError(e.message))
			.finally(() => generation.current === current && setLoadingOlder(false));
	}, [runId, loadingOlder]);

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
