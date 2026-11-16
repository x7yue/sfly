import {
	type ActionDetailView,
	type ActionSummaryView,
	actionsApi,
	type CountOnlyPeriod,
} from "@sfly/schema";
import { type UseQueryResult, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiQuery, callApi } from "#/lib/api";
import { STATUS_POLL_MS } from "#/lib/polling";
import { useEventSource } from "#/lib/sse";
import {
	type ActionDetails,
	type ActionFilter,
	fromLatestPage,
	matchesFilter,
	NO_FILTER,
	withLive,
	withOlderPage,
} from "./action-details";

/** 每页的明细数。 */
const PAGE = 200;

const summaryQuery = (taskId: string) => apiQuery(actionsApi.summary, { params: { id: taskId } });

/**
 * 一个任务（一次尝试）的动作摘要。缓存只有一份：{@link useTaskActions} 连着推送时由推送更新，
 * 没连着时 `poll` 为 true 就定时重新读（任务还在执行、没有在看「动作」页时传 true）；`poll` 变成 false 时
 * （任务结束、开始看「动作」页）再读一次，任务结束时的那一份（正在做的为空）不会漏掉。`taskId` 为 undefined 时不读。
 * 返回查询本身：`data` 是摘要，读不到时 `error` 是原因。
 */
export function useActionSummary(
	taskId: string | undefined,
	poll: boolean,
): UseQueryResult<ActionSummaryView> {
	const query = useQuery({
		...summaryQuery(taskId ?? ""),
		enabled: taskId !== undefined,
		refetchInterval: poll ? STATUS_POLL_MS : false,
	});
	const { refetch } = query;
	const polled = useRef(poll);
	useEffect(() => {
		if (polled.current && !poll) void refetch();
		polled.current = poll;
	}, [poll, refetch]);
	return query;
}

export interface TaskActions {
	/** 最新的摘要；还没读到时为 undefined。 */
	summary: ActionSummaryView | undefined;
	/** 读到的明细，按开始时间从新到旧，同一个 ID 只有一条（`action-details.ts`）。 */
	details: readonly ActionDetailView[];
	/** 分页读到的控制面兜底的只计数的段；SDK 上限的段由摘要算出（action-table.ts）。 */
	controlPlanePeriods: readonly CountOnlyPeriod[];
	/** 读到了第一页。 */
	loaded: boolean;
	/** 还有更早的明细没读：`loadOlder()` 读下一页。 */
	hasOlder: boolean;
	loadingOlder: boolean;
	loadOlder: () => void;
	/** 运行已超过保留期，明细已被清理。 */
	expired: boolean;
	/**
	 * 最近一次读取失败的原因：第一页或摘要读不到时用 `retry()` 重读，读更早的一页失败时再滚动或点按钮就会重读。
	 * 已经读到的摘要后台刷新失败不算。
	 */
	error: Error | null;
	/** 重读读不到的第一页和摘要。 */
	retry: () => void;
}

/**
 * 一个任务（一次尝试）的动作：先读最新的一页明细，再用它的修订号接上实时推送（`actionsApi.events`；断线后
 * API 客户端带 `Last-Event-ID` 接上），`loadOlder()` 往前翻页。推送来的摘要写进 {@link useActionSummary} 的缓存，
 * 推送来的明细按筛选条件挑过再合并（合并规则在 action-details.ts，有单测）。任务或筛选条件（`name`、`failed`）
 * 变了重新读。
 */
export function useTaskActions(taskId: string, filter: ActionFilter = NO_FILTER): TaskActions {
	const { name, failed } = filter;
	const queryClient = useQueryClient();
	const {
		data: summary,
		error: summaryError,
		refetch: refetchSummary,
	} = useActionSummary(taskId, false);
	const [buffer, setBuffer] = useState<ActionDetails | null>(null);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const [reloads, setReloads] = useState(0);
	const generation = useRef(0);
	const bufferRef = useRef(buffer);
	bufferRef.current = buffer;
	const olderInFlight = useRef(false);

	const readPage = useCallback(
		(before?: string) =>
			callApi(actionsApi.page, {
				params: { id: taskId },
				query: {
					limit: PAGE,
					...(name !== undefined && { name }),
					...(failed && { failed: "true" }),
					...(before !== undefined && { before }),
				},
			}),
		[taskId, name, failed],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: retry() 改 reloads 就是要重读
	useEffect(() => {
		const current = ++generation.current;
		setBuffer(null);
		setError(null);
		setLoadingOlder(false);
		olderInFlight.current = false;
		readPage()
			.then((page) => generation.current === current && setBuffer(fromLatestPage(page)))
			.catch((e: Error) => generation.current === current && setError(e));
	}, [readPage, reloads]);

	const accept = (detail: ActionDetailView) => matchesFilter(detail, { name, failed });
	const after = buffer === null || buffer.expired ? null : buffer.rev;
	useEventSource(
		actionsApi.events,
		after === null ? null : { params: { id: taskId }, query: { after } },
		{
			summary: (next) => queryClient.setQueryData(summaryQuery(taskId).queryKey, next),
			actions: (chunk) => setBuffer((b) => b && withLive(b, chunk.actions, accept)),
		},
	);

	const loadOlder = useCallback(() => {
		const before = bufferRef.current?.before;
		if (before == null || olderInFlight.current) return;
		const current = generation.current;
		olderInFlight.current = true;
		setLoadingOlder(true);
		readPage(before)
			.then(
				(page) => generation.current === current && setBuffer((b) => b && withOlderPage(b, page)),
			)
			.catch((e: Error) => generation.current === current && setError(e))
			.finally(() => {
				if (generation.current !== current) return;
				olderInFlight.current = false;
				setLoadingOlder(false);
			});
	}, [readPage]);

	return {
		summary,
		details: buffer?.details ?? EMPTY,
		controlPlanePeriods: buffer?.controlPlanePeriods ?? EMPTY,
		loaded: buffer !== null,
		hasOlder: buffer !== null && buffer.before !== null,
		loadingOlder,
		loadOlder,
		expired: buffer?.expired ?? false,
		error: error ?? (summary === undefined ? summaryError : null),
		retry: () => {
			if (buffer === null && error !== null) setReloads((n) => n + 1);
			if (summary === undefined) void refetchSummary();
		},
	};
}

const EMPTY: readonly never[] = [];
