import type { CatalogAttempt, CatalogNode, MetricSeries, RunMetricCatalog } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { seriesQuery } from "#/monitor/use-run-metrics";
import type { PrimaryMetricData } from "./PrimaryMetric";

/**
 * 主指标的数据（#43），复用运行的指标契约（metricsApi）：节点类型、主指标名与单位来自运行的指标目录
 * （useMetricCatalog），最新值与迷你趋势来自这个节点最新一次尝试的序列（按 TREND_POINTS 降采样）。
 * 运行中的实时更新：有运行事件流的页面（画布运行状态、运行抽屉）把 metrics 增量追加进序列缓存
 * （applyMetricIncrement）；没有事件流的列表（运行记录）定时重新查询（poll）。
 */

/** 迷你趋势的目标点数。 */
export const TREND_POINTS = 60;

/** 目录里这个节点（链实例 × 节点）的条目；没有开始执行过、不是包节点时为 undefined。 */
export const catalogEntry = (
	catalog: RunMetricCatalog | undefined,
	chainInstanceId: string,
	nodeId: string,
) => catalog?.nodes.find((n) => n.chain_instance_id === chainInstanceId && n.node_id === nodeId);

/** 主指标的展示数据：序列里的桶与最新值；序列还没加载时用目录摘要里的最新值。 */
export function primaryMetricData(
	name: string,
	entry: Pick<CatalogNode, "metrics">,
	attempt: CatalogAttempt | undefined,
	series: MetricSeries | undefined,
): PrimaryMetricData {
	const buckets = series?.series.find((s) => s.name === name)?.buckets ?? [];
	return {
		name,
		unit: entry.metrics.find((m) => m.name === name)?.unit ?? "",
		last: buckets.at(-1)?.last ?? attempt?.metrics.find((m) => m.name === name)?.last,
		buckets,
		bucketSeconds: series?.bucket_seconds ?? 1,
	};
}

/**
 * 一个节点（最新一次尝试）的主指标；节点类型没有主指标（或节点还不在目录里）时为 undefined。
 * finished：这次尝试已经结束（序列不会再变）；poll：运行中定时重新查询的间隔（毫秒）。
 */
export function usePrimaryMetric(
	runId: string,
	entry: CatalogNode | undefined,
	{ finished, poll }: { finished: boolean; poll?: number },
): PrimaryMetricData | undefined {
	const name = entry?.primary_metric ?? null;
	const attempt = entry?.attempts.at(-1);
	const series = useQuery({
		...seriesQuery(
			runId,
			{
				chain_instance_id: entry?.chain_instance_id ?? "",
				node_id: entry?.node_id ?? "",
				attempt: attempt?.attempt,
				points: TREND_POINTS,
			},
			finished,
		),
		enabled: !!name && !!attempt,
		refetchInterval: !finished && poll ? poll : false,
	});
	if (!entry || !name) return undefined;
	return primaryMetricData(name, entry, attempt, series.data);
}
