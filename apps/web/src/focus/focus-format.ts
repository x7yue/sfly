import type { FocusSeries, RunFocusItem } from "@sfly/schema";
import { runNodeName } from "#/components/node-name";
import { nodeStatusView } from "#/components/status";
import { formatDuration, formatMetric } from "#/lib/format";

/** 距离某一刻多久：`2s`、`2m 10s`、`1h 02m`（秒取整；一分钟以内不写小数）。 */
export function formatAgo(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : formatDuration(seconds * 1000);
}

/** 最后一个点距离读数生成时的毫秒数（都是控制面时间）；一个点都没有为 null。 */
export function readingAge(
	item: Pick<RunFocusItem, "last_at">,
	generatedAt: string,
): number | null {
	return item.last_at === null ? null : Date.parse(generatedAt) - Date.parse(item.last_at);
}

/** 最新值的文字；没有数据为「—」。 */
export const valueText = (item: Pick<RunFocusItem, "latest">): string =>
	item.latest === null ? "—" : formatMetric(item.latest.value);

/** 序列在图例里的名字：不带标签时是指标名；带标签时是标签值（按键名排序，以「 · 」连接），图表里有好几个指标时前面再加指标名。 */
export function seriesName(
	series: Pick<FocusSeries, "metric" | "labels">,
	multiMetric: boolean,
): string {
	const values = Object.entries(series.labels)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, value]) => value);
	if (values.length === 0) return series.metric;
	return (multiMetric ? [series.metric, ...values] : values).join(" · ");
}

/**
 * 最新值来自哪个序列：图表里有好几个指标，或者序列带标签时写序列的名字（{@link seriesName}）；
 * 只有一个不带标签的序列时为空字符串。
 */
export function latestSeriesName(item: Pick<RunFocusItem, "latest" | "series">): string {
	const { latest } = item;
	if (latest === null) return "";
	const multiMetric = hasSeveralMetrics(item.series);
	return multiMetric || Object.keys(latest.labels).length > 0
		? seriesName(latest, multiMetric)
		: "";
}

/** 来源节点还没有开始执行（与 lib/node-status 里节点「待执行」的说明同一句话）。 */
export const NOT_STARTED_TEXT = "还没有开始执行";

/** 来源节点：「显示名称（节点 ID）」，没有显示名称时只写节点 ID（docs/SEMANTICS.md §1.4）。 */
export const sourceNodeName = (item: Pick<RunFocusItem, "node_id" | "display_name">): string =>
	runNodeName(item);

/** 读数的脚注：来源节点和「多久前」；来源节点成功或已停止后是「最终值」，还没有数据时写明原因。 */
export function readingFoot(item: RunFocusItem, generatedAt: string): string {
	const node = sourceNodeName(item);
	if (item.final) return `${node} · 最终值`;
	const age = readingAge(item, generatedAt);
	if (age !== null) return `${node} · ${formatAgo(age)} 前`;
	return `${node} · ${item.source.task_id === null ? NOT_STARTED_TEXT : "还没有数据"}`;
}

/** 图表里有好几个指标（序列分属不同的指标）：读数和图例要写明是哪个指标。 */
export const hasSeveralMetrics = (series: ReadonlyArray<Pick<FocusSeries, "metric">>): boolean =>
	new Set(series.map((s) => s.metric)).size > 1;

/** 这张图表在这次运行的节点包版本里不存在时的说明。 */
export const chartMissingText = (item: Pick<RunFocusItem, "chart">) =>
	`这个版本的节点没有图表「${item.chart}」`;

/**
 * 读数的可访问名称：名称、最新值、来源节点和状态、最终值或多久前，例如
 * 「母单量 1284814 单，来自 load（执行中），2s 前」。
 */
export function readingLabel(item: RunFocusItem, generatedAt: string): string {
	const status = nodeStatusView(item.source.status).label;
	const origin = `来自 ${sourceNodeName(item)}（${status}）`;
	if (item.unavailable) return `${item.title}，${chartMissingText(item)}，${origin}`;
	const series = latestSeriesName(item);
	const value = `${series ? `${series} ` : ""}${valueText(item)}${item.unit ? ` ${item.unit}` : ""}`;
	const age = readingAge(item, generatedAt);
	const when = item.final ? "最终值" : age === null ? "还没有数据" : `${formatAgo(age)} 前`;
	return `${item.title} ${value}，${origin}，${when}`;
}
