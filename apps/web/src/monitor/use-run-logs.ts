import { encodeRunLogScope, type LogLineView, logsApi, type RunLogScope } from "@sfly/schema";
import { apiUrl, callApi } from "#/lib/api";
import { readerKey, useReader } from "#/lib/reader";
import { openEventSource } from "#/lib/sse";
import {
	createRunLogReader,
	emptyRunLogs,
	type RunLogPorts,
	type RunLogState,
} from "./run-log-reader";

const PAGE = 300;

/** 下载范围内整次运行合并后的日志（不受级别筛选影响）；`scope` 不给是全部节点。 */
export const runLogDownloadPath = (runId: string, scope: RunLogScope | undefined) =>
	apiUrl(logsApi.runDownload, {
		params: { id: runId },
		query: scope === undefined ? {} : { nodes: encodeRunLogScope(scope) },
	});

/** 读取器的生产适配器：读历史和实时推送都带上同一组范围（`nodes`）和级别（`level`，空表示不筛选），都在服务端执行（#224）。 */
function runLogPorts(runId: string, nodes: string | undefined, level: string): RunLogPorts {
	const filters = { ...(nodes === undefined ? {} : { nodes }), ...(level ? { level } : {}) };
	return {
		readPage: (position) =>
			callApi(logsApi.runPage, {
				params: { id: runId },
				query: { ...filters, limit: PAGE, ...position },
			}),
		subscribeLive: (after, { onLines, onReload, onFileProblems }) =>
			openEventSource(
				logsApi.runEvents,
				{ params: { id: runId }, query: { ...filters, after } },
				{
					logs: (chunk) => onLines(chunk.lines),
					reload: onReload,
					file_problems: onFileProblems,
				},
			),
	};
}

export interface RunLogs extends RunLogState {
	loadOlder: () => void;
}

const noop = () => {};

/**
 * 一次运行里范围内节点合并后的日志（没选中节点时的日志视图）：先读最新一页，再从它的 `live_after` 接上实时推送（#225），
 * `loadOlder()` 用 before 游标往前翻页（#223）。
 * `scope` 是节点范围（不给是全部节点），`levels` 是级别筛选（空表示不筛选）。
 * 合并规则和读取时序（筛选很少匹配时自动接着往前读、实时推送的行太多时重新读最新一页）在 run-log-reader.ts（有单测）；
 * 这里只在运行、范围或级别变化时换一个读取器，并把它的状态接到组件上。
 */
export function useRunLogs(
	runId: string | null,
	scope: RunLogScope | undefined,
	levels: readonly LogLineView["level"][],
): RunLogs {
	const nodes = scope && encodeRunLogScope(scope);
	const level = levels.join(",");
	const { state, reader } = useReader(
		() => (runId === null ? null : createRunLogReader(runLogPorts(runId, nodes, level))),
		readerKey(runId, nodes, level),
		emptyRunLogs,
	);
	return { ...state, loadOlder: reader?.loadOlder ?? noop };
}
