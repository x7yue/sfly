import {
	type MetricIncrement,
	type MetricSeries,
	type MetricSeriesQuery,
	metricsApi,
	type RunView,
} from "@sfly/schema";
import { keepPreviousData, type QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { apiQuery } from "#/lib/api";
import { appendIncrement } from "./charts";

/**
 * 图表工作区的数据：运行的指标目录、每个节点的序列（降采样）、平台自带图表（契约 metricsApi）。
 * 实时增量来自运行 SSE 的 metrics 事件（MonitorPage 与 run / progress 共用一条连接），
 * 由 {@link applyMetricIncrement} 追加进缓存里的序列；断线重连后用 {@link refetchSeries} 补齐错过的点。
 */

/** 开始与结束过的尝试：变化时重新获取目录（新节点、新尝试）与平台自带图表。 */
export const attemptsSignature = (run: RunView) =>
	run.chains
		.flatMap((c) =>
			c.nodes.flatMap((n) =>
				n.attempts.flatMap((a) =>
					a.started_at === null ? [] : [`${a.task_id}${a.ended_at === null ? "" : "."}`],
				),
			),
		)
		.join(",");

/** signature 变化时（不含第一次）调用 refetch。 */
function useRefetchOn(signature: string, refetch: () => unknown) {
	const last = useRef(signature);
	useEffect(() => {
		if (last.current === signature) return;
		last.current = signature;
		void refetch();
	}, [signature, refetch]);
}

export function useMetricCatalog(runId: string, signature: string, enabled = true) {
	const query = useQuery({
		...apiQuery(metricsApi.catalog, { params: { id: runId } }),
		enabled,
	});
	useRefetchOn(signature, query.refetch);
	return query;
}

export const PLATFORM_POINTS = 120;

export function usePlatformMetrics(runId: string, signature: string, live: boolean) {
	const query = useQuery({
		...apiQuery(metricsApi.platform, { params: { id: runId }, query: { points: PLATFORM_POINTS } }),
		// 并发与槽位占用随时间变化（其他运行的任务也占槽位），运行中定时刷新。
		refetchInterval: live ? 5000 : false,
		placeholderData: keepPreviousData,
	});
	useRefetchOn(signature, query.refetch);
	return query;
}

type SeriesQuery = Pick<
	MetricSeriesQuery,
	"chain_instance_id" | "node_id" | "attempt" | "from" | "to"
> & { points?: number };

/** 一个节点一次尝试的序列查询选项；缩放时带上时间范围（按秒取整），得到更细的桶。 */
export function seriesQuery(runId: string, query: SeriesQuery, finished: boolean) {
	return {
		...apiQuery(metricsApi.series, { params: { id: runId }, query }),
		placeholderData: keepPreviousData,
		// 结束了的尝试不会再有新的点；执行中的靠 SSE 增量追加。
		staleTime: finished ? Number.POSITIVE_INFINITY : 0,
	};
}

type SeriesKeyVars = { params?: { id?: string }; query?: Partial<SeriesQuery> };

const seriesOf = (runId: string, match: (q: Partial<SeriesQuery>) => boolean) => ({
	queryKey: metricsApi.series.key,
	predicate: (q: { queryKey: readonly unknown[] }) => {
		const vars = q.queryKey[metricsApi.series.key.length] as SeriesKeyVars | undefined;
		return vars?.params?.id === runId && !!vars.query && match(vars.query);
	},
});

/** 把一条 metrics 增量追加进这个节点的序列缓存（只追加没有指定时间范围的查询：缩放的范围是固定的）。 */
export function applyMetricIncrement(
	client: QueryClient,
	runId: string,
	increment: MetricIncrement,
) {
	client.setQueriesData<MetricSeries>(
		seriesOf(
			runId,
			(q) =>
				q.chain_instance_id === increment.chain_instance_id &&
				q.node_id === increment.node_id &&
				q.to === undefined,
		),
		(old) => (old ? appendIncrement(old, increment) : old),
	);
}

/** 重新获取这个运行的全部序列（SSE 重连后补齐断线期间错过的点）。 */
export function refetchSeries(client: QueryClient, runId: string) {
	void client.invalidateQueries(seriesOf(runId, () => true));
}
