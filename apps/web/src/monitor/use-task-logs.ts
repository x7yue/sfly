import { type LogChunk, type LogLineView, logsApi } from "@sfly/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { callApi } from "#/lib/api";
import { useEventSource } from "#/lib/sse";
import { emptyBuffer, fromLatestPage, type LogBuffer, withLive, withOlderPage } from "./log-buffer";

/** 每页行数。 */
const PAGE = 300;

export const taskLogDownloadPath = (taskId: string) =>
	`/api/tasks/${encodeURIComponent(taskId)}/logs/download`;

export interface TaskLogs extends LogBuffer {
	loadingOlder: boolean;
	error: string | null;
	loadOlder: () => void;
}

/**
 * 一个任务的日志：先读最后一页历史（levels 为空表示不筛选，服务端筛选），再用 `after_seq` 接上实时流，
 * `loadOlder()` 往前翻页。状态的合并规则在 log-buffer.ts（有单测）。任务或筛选条件变化时重新加载。
 */
export function useTaskLogs(taskId: string, levels: readonly LogLineView["level"][]): TaskLogs {
	const [buffer, setBuffer] = useState<LogBuffer>(emptyBuffer);
	const [stream, setStream] = useState<string | null>(null);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);
	const bufferRef = useRef(buffer);
	bufferRef.current = buffer;
	const levelKey = levels.join(",");
	const accept = useRef<(line: LogLineView) => boolean>(() => true);
	accept.current = (line) => levelKey === "" || levelKey.split(",").includes(line.level);

	useEffect(() => {
		const current = ++generation.current;
		setBuffer(emptyBuffer);
		setStream(null);
		setError(null);
		setLoadingOlder(false);
		callApi(logsApi.page, {
			params: { id: taskId },
			query: { limit: PAGE, ...(levelKey ? { level: levelKey } : {}) },
		})
			.then((page) => {
				if (generation.current !== current) return;
				setBuffer(fromLatestPage(page));
				setStream(`/tasks/${encodeURIComponent(taskId)}/logs/events?after_seq=${page.last_seq}`);
			})
			.catch((e: Error) => {
				if (generation.current !== current) return;
				setBuffer({ ...emptyBuffer, loaded: true });
				setError(e.message);
			});
	}, [taskId, levelKey]);

	useEventSource(stream, {
		logs: (data) => setBuffer((b) => withLive(b, data as LogChunk, accept.current)),
	});

	const loadOlder = useCallback(() => {
		const { start, hasOlder } = bufferRef.current;
		if (!hasOlder || loadingOlder) return;
		const current = generation.current;
		setLoadingOlder(true);
		callApi(logsApi.page, {
			params: { id: taskId },
			query: { limit: PAGE, before: start, ...(levelKey ? { level: levelKey } : {}) },
		})
			.then((page) => {
				if (generation.current !== current) return;
				setBuffer((b) => withOlderPage(b, page));
			})
			.catch((e: Error) => generation.current === current && setError(e.message))
			.finally(() => generation.current === current && setLoadingOlder(false));
	}, [taskId, levelKey, loadingOlder]);

	return { ...buffer, loadingOlder, error, loadOlder };
}
