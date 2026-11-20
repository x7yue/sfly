import { type LogLineView, logsApi } from "@sfly/schema";
import { apiUrl, callApi } from "#/lib/api";
import { readerKey, useReader } from "#/lib/reader";
import { openEventSource } from "#/lib/sse";
import {
	createTaskLogReader,
	emptyTaskLogs,
	type TaskLogPorts,
	type TaskLogState,
} from "./task-log-reader";

/** 每页行数。 */
const PAGE = 300;

export const taskLogDownloadPath = (taskId: string) =>
	apiUrl(logsApi.download, { params: { id: taskId } });

/** 读取器的生产适配器：分页请求加上级别筛选（`levelKey` 为空表示不筛选），实时流是契约里的 SSE。 */
function taskLogPorts(taskId: string, levelKey: string): TaskLogPorts {
	return {
		readPage: (position) =>
			callApi(logsApi.page, {
				params: { id: taskId },
				query: { limit: PAGE, ...(levelKey ? { level: levelKey } : {}), ...position },
			}),
		subscribeLive: (afterSeq, onChunk) =>
			openEventSource(
				logsApi.events,
				{ params: { id: taskId }, query: { after_seq: String(afterSeq) } },
				{ logs: onChunk },
			),
		accepts: (line) => levelKey === "" || levelKey.split(",").includes(line.level),
	};
}

export interface TaskLogs extends TaskLogState {
	loadOlder: () => void;
	loadNewer: () => void;
}

/** 要在日志里定位的时刻（控制面时间，毫秒）；`request` 变了就重新定位（monitor-state.tsx 的 logMoment）。 */
export interface LogMoment {
	at: number;
	request: number;
}

const noop = () => {};

/**
 * 一个任务的日志：先读最后一页历史（levels 为空表示不筛选，服务端筛选），再用 `after_seq` 接上实时流，
 * `loadOlder()` 往前翻页。合并规则和读取时序在 task-log-reader.ts（有单测）；这里只在任务、筛选条件或
 * 定位的时刻变化时换一个读取器，并把它的状态接到组件上。
 *
 * 给了 `moment` 时先读包含那一刻的一页（#347）：它在日志中间，之后还有行（`hasNewer`）时不连实时流，
 * `loadNewer()` 用 `after` 往后翻页，读到文件末尾后再接上实时流，之后与最后一页的情形相同。
 */
export function useTaskLogs(
	taskId: string,
	levels: readonly LogLineView["level"][],
	moment: LogMoment | null = null,
): TaskLogs {
	const levelKey = levels.join(",");
	const at = moment === null ? null : new Date(moment.at).toISOString();
	const { state, reader } = useReader(
		() => createTaskLogReader(taskLogPorts(taskId, levelKey), { at }),
		// request 变了（同一时刻再次请求）也要重新定位
		readerKey(taskId, levelKey, at, moment?.request),
		emptyTaskLogs,
	);
	return {
		...state,
		loadOlder: reader?.loadOlder ?? noop,
		loadNewer: reader?.loadNewer ?? noop,
	};
}
