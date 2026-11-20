import { type ActionSummaryView, actionsApi } from "@sfly/schema";
import {
	type QueryClient,
	type UseQueryResult,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { apiQuery, callApi } from "#/lib/api";
import { readerKey, useReader } from "#/lib/reader";
import { openEventSource } from "#/lib/sse";
import { useRefetchWhenPollingStops } from "#/lib/use-refetch-when-polling-stops";
import { type ActionFilter, NO_FILTER } from "./action-details";
import {
	createTaskActionReader,
	emptyTaskActions,
	type TaskActionPorts,
	type TaskActionState,
} from "./task-action-reader";

/** 每页的明细数。 */
const PAGE = 200;

/** 读一个任务的动作摘要的查询：页面读摘要都用它，缓存里同一个任务只有一份。 */
export const summaryQuery = (taskId: string) =>
	apiQuery(actionsApi.summary, { params: { id: taskId } });

/**
 * 一个任务（一次尝试）的动作摘要：页面读它的唯一入口，缓存只有一份。{@link useTaskActions} 连着推送时由推送更新，
 * 没连着时 `pollMs` 是数字就每隔这么久重新读（任务还在执行、没有在看「动作」页签时传：画布检查器每秒，
 * 运行监控底部面板的页签个数每 5 秒）；`pollMs` 变成 false 时（任务结束、开始看「动作」页签）再读一次，任务结束时的
 * 那一份（正在做的为空）不会漏掉。换了一个任务不算结束：它自己的查询已经在读。`taskId` 为 undefined 时不读
 * （节点不在 Agent 上执行，或这次尝试还没开始执行）。返回查询本身：`data` 是摘要，读不到时 `error` 是原因。
 */
export function useActionSummary(
	taskId: string | undefined,
	pollMs: number | false,
): UseQueryResult<ActionSummaryView> {
	const query = useQuery({
		...summaryQuery(taskId ?? ""),
		enabled: taskId !== undefined,
		refetchInterval: pollMs,
	});
	useRefetchWhenPollingStops(
		taskId !== undefined && pollMs !== false ? [summaryQuery(taskId).queryKey] : [],
	);
	return query;
}

/** 读取器的状态（明细、只计数的段、有没有更早的……）加上摘要，和读取命令。 */
export interface TaskActions extends TaskActionState {
	/** 最新的摘要；还没读到时为 undefined。 */
	summary: ActionSummaryView | undefined;
	loadOlder: () => void;
	/**
	 * 最近一次读取失败的原因：第一页或摘要读不到时用 `retry()` 重读，读更早的一页失败时再滚动或点按钮就会重读。
	 * 已经读到的摘要后台刷新失败不算。
	 */
	error: Error | null;
	/** 重读读不到的第一页和摘要。 */
	retry: () => void;
}

const noop = () => {};

/** 读取器的生产适配器：分页请求带上名称、只看失败的筛选，实时推送是契约里的 SSE；推送来的摘要写进 {@link useActionSummary} 的缓存。 */
function taskActionPorts(
	taskId: string,
	{ name, failed }: ActionFilter,
	queryClient: QueryClient,
): TaskActionPorts {
	return {
		readPage: ({ before }) =>
			callApi(actionsApi.page, {
				params: { id: taskId },
				query: {
					limit: PAGE,
					...(name !== undefined && { name }),
					...(failed && { failed: "true" }),
					...(before !== undefined && { before }),
				},
			}),
		subscribeLive: (after, onActions) =>
			openEventSource(
				actionsApi.events,
				{ params: { id: taskId }, query: { after } },
				{
					summary: (next) => queryClient.setQueryData(summaryQuery(taskId).queryKey, next),
					actions: (chunk) => onActions(chunk.actions),
				},
			),
	};
}

/**
 * 一个任务（一次尝试）的动作：先读最新的一页明细，再用它的修订号接上实时推送（`actionsApi.events`；断线后
 * API 客户端带 `Last-Event-ID` 接上），`loadOlder()` 往前翻页。推送来的摘要写进 {@link useActionSummary} 的缓存，
 * 推送来的明细按筛选条件挑过再合并（合并规则和读取时序在 task-action-reader.ts，有单测）。这里只在任务或筛选条件
 * （`name`、`failed`）变化时换一个读取器，并把它的状态接到组件上。
 */
export function useTaskActions(taskId: string, filter: ActionFilter = NO_FILTER): TaskActions {
	const { name, failed } = filter;
	const queryClient = useQueryClient();
	const {
		data: summary,
		error: summaryError,
		refetch: refetchSummary,
	} = useActionSummary(taskId, false);
	const { state, reader } = useReader(
		() =>
			createTaskActionReader(taskActionPorts(taskId, { name, failed }, queryClient), {
				name,
				failed,
			}),
		readerKey(taskId, name, failed),
		emptyTaskActions,
	);

	return {
		...state,
		summary,
		loadOlder: reader?.loadOlder ?? noop,
		error: state.error ?? (summary === undefined ? summaryError : null),
		retry: () => {
			reader?.retry();
			if (summary === undefined) void refetchSummary();
		},
	};
}
