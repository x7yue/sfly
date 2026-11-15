import { DEFAULT_FOCUS_POINTS, runFocusApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { apiQuery } from "#/lib/api";
import { LIVE_POLL_MS } from "#/lib/polling";

/**
 * 读一次运行的关注项读数的查询（`GET /runs/:id/focus`）：`useRunFocus` 和一页里要读好几个运行的地方（`useQueries`）
 * 都用它，query key 相同，缓存里同一个运行同一个 `points` 只有一份；多久重新读一次由调用方按页面定（`refetchInterval`）。
 */
export const runFocusQuery = (
	runId: string,
	{
		points = DEFAULT_FOCUS_POINTS,
		refetchInterval,
	}: { points?: number; refetchInterval: number | false },
) => ({
	...apiQuery(runFocusApi.focus, { params: { id: runId }, query: { points } }),
	refetchInterval,
});

/**
 * 一次运行的关注项读数（`GET /runs/:id/focus`）：页面读它的唯一入口，不要再自己拼指标查询（目前是运行监控的概览和页头的「数据更新于」，两处参数相同，共用一个查询）。
 * 运行中每 `LIVE_POLL_MS` 重新读取一次；运行结束时再读一次，拿到最终值，之后不再轮询。
 * `points` 是每个序列降采样的点数，只要最新值的地方（读数、槽位）传 0。
 */
export function useRunFocus(
	runId: string,
	{ live, points }: { live: boolean; points?: number | undefined },
) {
	const query = useQuery(
		runFocusQuery(runId, { points, refetchInterval: live ? LIVE_POLL_MS : false }),
	);
	const wasLive = useRef(live);
	const { refetch } = query;
	useEffect(() => {
		if (wasLive.current && !live) void refetch();
		wasLive.current = live;
	}, [live, refetch]);
	return query;
}
