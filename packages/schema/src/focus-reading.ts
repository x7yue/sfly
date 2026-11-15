import type { FocusSeries, RunFocusItem } from "./http/run-focus.js";
import { formatMetric } from "./metric-format.js";
import { seriesName } from "./series.js";

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
