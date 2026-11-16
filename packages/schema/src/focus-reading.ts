import { bucketStartMs, type MetricBucket } from "./http/metrics.js";
import type { FocusSeries, RunFocusItem } from "./http/run-focus.js";
import { formatMetric } from "./metric-format.js";
import type { ChartDeclaration } from "./package-metadata.js";
import { type Labels, seriesName } from "./series.js";

/**
 * 关注项读数的写法（GLOSSARY「关注项」）：运行监控的读数和图表、运行通知的卡片共用，同一项在哪里看到说法都一样。
 */

/** 关注项失效的一种原因：节点包的这个版本没有声明这张图表（规格 #344 的写法，别处写这句都引用它）。 */
export const focusChartMissing = (chart: string): string => `这个版本的节点没有图表 ${chart}`;

/** 最新值的文字（{@link formatMetric}）；没有数据为「—」。 */
export const focusValueText = (item: Pick<RunFocusItem, "latest">): string =>
	item.latest === null ? "—" : formatMetric(item.latest.value);

/**
 * 序列在图例和读数里的名字：规则与详情的图表相同（{@link seriesName}），标签键的顺序和图表是否读了好几个指标
 * 取自这一项读的指标。
 */
export function focusSeriesName(
	item: Pick<RunFocusItem, "metrics">,
	series: Pick<FocusSeries, "metric" | "labels">,
): string {
	const keys = item.metrics.find((m) => m.name === series.metric)?.label_keys;
	return seriesName(series.metric, series.labels, keys, item.metrics.length > 1);
}

/**
 * 最新值来自哪个序列：图表读了好几个指标，或者序列带标签时写序列的名字（{@link focusSeriesName}）；
 * 只有一个不带标签的序列时为空字符串。
 */
export function focusLatestSeriesName(item: Pick<RunFocusItem, "latest" | "metrics">): string {
	const { latest } = item;
	if (latest === null) return "";
	return item.metrics.length > 1 || Object.keys(latest.labels).length > 0
		? focusSeriesName(item, latest)
		: "";
}

/**
 * 最近更新的序列（规格 #344：`latest` 取最近更新的那个序列）：最后一个点最晚的那个，同一时刻取靠前的；都没有点时为
 * undefined。`lastAt` 是序列最后一个点的时间（同一种单位就行），没有点为 null 或 undefined。控制面给关注项取最新值、
 * 画布检查器给不是关注项的图表取最新值都用它，按最后一个点的精确时间比，不按桶。
 */
export function latestSeries<S>(
	series: readonly S[],
	lastAt: (s: S) => number | null | undefined,
): S | undefined {
	let latest: { series: S; at: number } | undefined;
	for (const s of series) {
		const at = lastAt(s);
		if (at != null && (!latest || at > latest.at)) latest = { series: s, at };
	}
	return latest?.series;
}

/** 一张图表读哪些指标：数值卡只读第一个，其余读声明的全部。关注项的读数和画布检查器里的图表都按它读。 */
export const chartMetrics = <M extends string>(
	chart: Pick<ChartDeclaration, "type"> & { metrics: readonly M[] },
): M[] => chart.metrics.slice(0, chart.type === "stat" ? 1 : undefined);

/**
 * 指标的一个序列换成关注项读数里的写法（{@link FocusSeries}），图表和读数共用一套画法：点的时间是桶在时间轴上的起始位置
 * （{@link bucketStartMs}：控制面时间，升级之前存下的数据用 Agent 时间）。控制面给关注项读数、画布检查器给不是关注项的图表都用它。
 */
export const focusSeriesOf = (series: {
	name: string;
	labels: Labels;
	buckets: readonly MetricBucket[];
}): FocusSeries => ({
	metric: series.name,
	labels: series.labels,
	points: series.buckets.map((b) => ({
		time: new Date(bucketStartMs(b)).toISOString(),
		min: b.min,
		max: b.max,
		avg: b.avg,
		last: b.last,
		points: b.points,
	})),
});
