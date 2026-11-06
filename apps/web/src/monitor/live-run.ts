import {
	type MetricIncrement,
	type ProgressEvent,
	queryKey,
	type RunView,
	runsApi,
} from "@sfly/schema";
import {
	type QueryClient,
	replaceEqualDeep,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { apiQuery, apiUrl } from "#/lib/api";
import { openEventSource } from "#/lib/sse";
import { applyProgress, latestRunView } from "./run-model";
import { applyMetricIncrement, refetchSeries } from "./use-run-metrics";

const runViewKey = (runId: string) => queryKey(runsApi.get, { params: { id: runId } });

/**
 * 运行视图 `GET /runs/:id` 的查询选项（用到这份缓存的查询都用它）：请求结果和任何写入都按
 * {@link latestRunView} 合并（TanStack Query 对请求结果和 setQueryData 都应用 structuralSharing），
 * 不让运行结束前生成、之后才到达的响应覆盖最终状态（#47）。
 */
export function runViewQuery(runId: string) {
	return {
		...apiQuery(runsApi.get, { params: { id: runId } }),
		structuralSharing: (current: unknown, next: unknown) =>
			replaceEqualDeep(current, latestRunView(current as RunView | undefined, next as RunView)),
	};
}

/**
 * 把一份运行视图写进缓存（事件流推送、取消与触发的响应），按 {@link latestRunView} 合并（#47）。
 * 还没有查询使用这份缓存时（例如刚触发、抽屉还没挂载），缓存上没有 structuralSharing，所以这里也合并。
 */
export function writeRunView(client: QueryClient, view: RunView) {
	client.setQueryData(runViewKey(view.id), (current: RunView | undefined) =>
		latestRunView(current, view),
	);
}

/**
 * 运行的实时数据（运行监控页、运行抽屉、画布运行状态共用）：`GET /runs/:id` 的缓存，运行中由运行事件流更新——
 * run（运行视图）、progress（进度）、metrics（指标增量，追加进序列缓存）；每次连上（包括第一次）都重新获取序列，
 * 补齐连上之前或断线期间错过的点（运行视图由控制面在连上时推送一次，不需要重新获取）。
 *
 * 同一个运行在页面上只开一条事件流：各处调用按运行 ID 共用一条连接（引用计数，最后一处卸载时关闭），
 * 所以每个增量只追加一次，不靠调用方约定。运行结束后不再需要实时流（最后一条 run 推送就是最终状态）。
 */
export function useLiveRun(
	runId: string | undefined,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	const client = useQueryClient();
	const run = useQuery({ ...runViewQuery(runId ?? ""), enabled: enabled && !!runId });
	const live = enabled && !!runId && (!run.data || run.data.status === "running");
	useEffect(() => (live && runId ? acquire(client, runId) : undefined), [client, runId, live]);
	return run;
}

interface Connection {
	users: number;
	close: () => void;
}

/** 每个 QueryClient 一张表：运行 ID → 共用的连接。 */
const connections = new WeakMap<QueryClient, Map<string, Connection>>();

function acquire(client: QueryClient, runId: string): () => void {
	let byRun = connections.get(client);
	if (!byRun) {
		byRun = new Map();
		connections.set(client, byRun);
	}
	let connection = byRun.get(runId);
	if (!connection) {
		const key = runViewKey(runId);
		const handlers: Record<string, (data: unknown) => void> = {
			run: (view) => writeRunView(client, view as RunView),
			progress: (event) =>
				client.setQueryData(key, (old: RunView | undefined) =>
					applyProgress(old, event as ProgressEvent),
				),
			metrics: (increment) =>
				void applyMetricIncrement(client, runId, increment as MetricIncrement),
		};
		const close = openEventSource(
			runsApi.events,
			apiUrl(runsApi.events, { params: { id: runId } }),
			Object.keys(handlers),
			(event, data) => handlers[event]?.(data),
			() => void refetchSeries(client, runId),
		);
		connection = { users: 0, close };
		byRun.set(runId, connection);
	}
	const current = connection;
	current.users++;
	return () => {
		current.users--;
		if (current.users === 0) {
			current.close();
			if (byRun.get(runId) === current) byRun.delete(runId);
		}
	};
}
