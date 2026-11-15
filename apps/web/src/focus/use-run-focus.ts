import { DEFAULT_FOCUS_POINTS, runFocusApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { apiQuery } from "#/lib/api";
import { LIVE_POLL_MS } from "#/lib/polling";

/**
 * 一次运行的关注项读数（`GET /runs/:id/focus`）：页面读它的唯一入口（概览现在用；画布、控制台、Agent 管理页的关注项
 * 读数也读这一份），不要再自己拼指标查询。
 * 运行中每 `LIVE_POLL_MS` 重新读取一次；运行结束时再读一次，拿到最终值，之后不再轮询。
 * `points` 是每个序列降采样的点数，只要最新值的地方（读数、槽位）传 0。
 */
export function useRunFocus(
	runId: string,
	{ live, points = DEFAULT_FOCUS_POINTS }: { live: boolean; points?: number },
) {
	const query = useQuery({
		...apiQuery(runFocusApi.focus, { params: { id: runId }, query: { points } }),
		refetchInterval: live ? LIVE_POLL_MS : false,
	});
	const wasLive = useRef(live);
	const { refetch } = query;
	useEffect(() => {
		if (wasLive.current && !live) void refetch();
		wasLive.current = live;
	}, [live, refetch]);
	return query;
}
