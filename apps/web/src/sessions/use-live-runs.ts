import type { RunStatus } from "@sfly/schema";
import { useQueries } from "@tanstack/react-query";
import { createContext, useMemo } from "react";
import { runViewQuery } from "#/monitor/live-run";
import { liveRunIds } from "./live-runs";
import type { ResultRun } from "./results";

/** 页面上哪几个运行开着事件流（{@link useLiveRunSet} 算出来，`SessionRunCard` 读）；不在会话页里时没有。 */
export const LiveRunsContext = createContext<ReadonlySet<string>>(new Set());

/**
 * 会话页上这一刻哪几个运行开事件流（`liveRunIds`：还在跑的里最近的 2 个）。状态读缓存里已有的（`enabled: false`：只看着缓存、不发请求、
 * 不定时重新读，请求由各个卡片按自己的方式发），卡片读到运行结束了，名额就让给更早的、还在跑的。
 * 时间线上的卡片和成果栏里的卡片读同一个结果，所以同一个运行在页面上最多一条事件流（`useLiveRun` 按运行共用连接）。
 */
export function useLiveRunSet(runs: readonly ResultRun[]): ReadonlySet<string> {
	const ids = useMemo(() => [...new Set(runs.map((run) => run.runId))], [runs]);
	const statuses = useQueries({
		queries: ids.map((id) => ({ ...runViewQuery(id), enabled: false })),
		combine: (results) => results.map((result) => result.data?.status),
	});
	return useMemo(() => {
		const known = new Map<string, RunStatus | undefined>(ids.map((id, i) => [id, statuses[i]]));
		return liveRunIds(runs, (runId) => known.get(runId));
	}, [ids, runs, statuses]);
}
