import { actionsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { apiQuery } from "#/lib/api";
import { ACTIONS_POLL_MS } from "#/lib/polling";

/**
 * 一个任务（一次尝试）的动作摘要（`GET /tasks/:id/actions/summary`）：页面读它的唯一入口。
 * `taskId` 为 undefined 时不查询（节点没有上报动作的可能：不在 Agent 上执行，或还没开始执行）。
 * 执行中（`live`）每 `ACTIONS_POLL_MS` 重新读取；结束时再读一次，拿到最后一份摘要，之后不再轮询。
 * 摘要接口没有推送，以后换成推送只改这里。
 */
export function useActionSummary(taskId: string | undefined, { live }: { live: boolean }) {
	const query = useQuery({
		...apiQuery(actionsApi.summary, { params: { id: taskId ?? "" } }),
		enabled: taskId !== undefined,
		refetchInterval: live ? ACTIONS_POLL_MS : false,
	});
	const wasLive = useRef(live);
	const { refetch } = query;
	useEffect(() => {
		if (wasLive.current && !live && taskId !== undefined) void refetch();
		wasLive.current = live;
	}, [live, taskId, refetch]);
	return query;
}
