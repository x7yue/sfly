import {
	bucketStartMs,
	type CatalogNode,
	type ChartView,
	type FocusLatest,
	type FocusSeries,
	type MetricSeries,
	type NodeRunView,
	type RunFocusItem,
} from "@sfly/schema";
import { useQueries } from "@tanstack/react-query";
import { cn } from "cn";
import { useId } from "react";
import { SectionHeading } from "#/components/page";
import { AnomalyNote } from "#/focus/AnomalyNote";
import { FocusPlot } from "#/focus/FocusPlot";
import { FocusQuota, FocusToggle } from "#/focus/FocusToggle";
import { FocusValue } from "#/focus/FocusValue";
import { anomalyText, readingLabel, readingState, readingValue } from "#/focus/focus-format";
import { type FocusItems, isFocused } from "#/focus/use-focus-items";
import { FOCUS, MONITOR_VIEW_LABEL, noDataLabel, PAGE, TERM } from "#/lib/copy";
import { useNow } from "#/lib/use-now";
import { seriesQuery } from "#/monitor/use-run-metrics";
import { Skeleton } from "@/components/ui/skeleton";

/** 每个序列降采样的点数：检查器里的图约 300px 宽。 */
const CHART_POINTS = 120;
/** 绘图区的高度（px）。 */
const PLOT_HEIGHT = 88;

/** 检查器里的一张图表：节点类型声明的图表，它现在是不是关注项，是的话它的关注项读数（还没读到时为 undefined）。 */
interface NodeChart {
	chart: ChartView;
	focused: boolean;
	reading: RunFocusItem | undefined;
}

/**
 * 排序：有异常的关注项最前，其次是其余关注项，再是其他图表（规格 #344）。关注项之间按读数的顺序（控制面排好的：
 * 有异常的在前，其余按作者的顺序）；刚设为关注项、读数里还没有的排在关注项最后；其他图表按声明的顺序。
 * 是不是关注项看场景的列表（点「关注」后立刻变），异常只看读数。
 */
export function orderCharts(
	charts: readonly ChartView[],
	readings: readonly RunFocusItem[],
	focused: (chart: string) => boolean,
): NodeChart[] {
	const rows = charts.map((chart): NodeChart => {
		const on = focused(chart.title);
		return {
			chart,
			focused: on,
			reading: on ? readings.find((r) => r.chart === chart.title) : undefined,
		};
	});
	const rank = (row: NodeChart) => (!row.focused ? 2 : row.reading?.anomaly ? 0 : 1);
	const at = (row: NodeChart) => (row.reading ? readings.indexOf(row.reading) : readings.length);
	return rows.sort((a, b) => rank(a) - rank(b) || (a.focused ? at(a) - at(b) : 0));
}

/** 运行指标的一个序列换成关注项读数里的写法，图表和读数共用一套画法。 */
const focusSeries = (s: MetricSeries["series"][number]): FocusSeries => ({
	metric: s.name,
	labels: s.labels,
	points: s.buckets.map((b) => ({
		time: new Date(bucketStartMs(b)).toISOString(),
		min: b.min,
		max: b.max,
		avg: b.avg,
		last: b.last,
		points: b.points,
	})),
});

/** 最近更新的那个序列的最后一个点（与控制面给关注项取最新值的规则相同）。 */
function latestOf(series: readonly FocusSeries[]): FocusLatest | null {
	let latest: FocusLatest | null = null;
	for (const s of series) {
		const last = s.points.at(-1);
		if (last && (latest === null || Date.parse(last.time) >= Date.parse(latest.at))) {
			latest = { value: last.last, metric: s.metric, labels: s.labels, at: last.time };
		}
	}
	return latest;
}

/** 关注项读数里属于这个节点的那些（按读数的顺序）和这份读数的生成时间（控制面时间，「多久前」按它算）。 */
export interface NodeReadings {
	items: readonly RunFocusItem[];
	generatedAt: string;
}

/**
 * 画布运行状态检查器里选中节点的图表：节点类型声明的全部图表（运行指标目录里这个节点的，含平台给没被图表引用的指标生成的
 * 默认图表），按 {@link orderCharts} 排，每张带「关注」开关，立即生效。图固定显示最新一次尝试的全程，不能缩放：要缩放在运行监控
 * 详情里看。序列与运行监控详情的图表用同一个查询（`seriesQuery`），运行中由运行事件流追加新的点；关注项的最新值和异常原因取
 * 关注项读数，和节点卡片、检查器的概况一致，其他图表的最新值取序列里最近更新的那个。数值卡只显示数值（取第一个序列，与关注项一样）。
 */
export function NodeCharts({
	runId,
	node,
	entry,
	readings,
	focus,
	enabled,
}: {
	runId: string;
	node: NodeRunView;
	/** 运行指标目录里这个节点（它所在的链实例）的条目；没有声明图表时什么也不画。 */
	entry: CatalogNode;
	/** 还没读到关注项读数时为 undefined。 */
	readings: NodeReadings | undefined;
	focus: FocusItems;
	/** 这个节点的图表能不能设为关注项：最新版本里还是同一个节点类型、同一个节点包版本。 */
	enabled: boolean;
}) {
	const headingId = useId();
	const latest = entry.attempts.at(-1);
	const attempt = node.attempts.find((a) => a.task_id === latest?.task_id);
	const live = !!attempt?.started_at && attempt.ended_at === null;
	const now = useNow(live);
	const axis = attempt?.started_at
		? {
				start: Date.parse(attempt.started_at),
				end: Math.max(
					attempt.ended_at ? Date.parse(attempt.ended_at) : now,
					Date.parse(attempt.started_at) + 1000,
				),
			}
		: null;
	const charts = orderCharts(entry.charts, readings?.items ?? [], (chart) =>
		isFocused(focus.items, node.node_id, chart),
	);
	const results = useQueries({
		queries: charts.map(({ chart }) =>
			seriesQuery(
				runId,
				{
					chain_instance_id: entry.chain_instance_id,
					node_id: entry.node_id,
					attempt: latest?.attempt,
					metrics: readMetrics(chart).join(","),
					points: CHART_POINTS,
				},
				!live,
			),
		),
	});
	if (entry.charts.length === 0) return null;
	const declared = new Map(entry.metrics.map((m) => [m.name, m]));
	return (
		<section aria-labelledby={headingId}>
			<SectionHeading id={headingId}>
				{TERM.chart}
				<span className="font-mono">{entry.charts.length}</span>
			</SectionHeading>
			<FocusQuota focus={focus} saved />
			{!enabled && (
				<p className="m-0 mb-2 text-xs text-fg-3">
					最新版本里这个节点已删除，或者换了节点类型、节点包版本，不能把它的{TERM.chart}设为
					{TERM.focusItem}。
				</p>
			)}
			<ul aria-label={TERM.chart} className="m-0 flex list-none flex-col gap-2 p-0">
				{charts.map((row, i) => {
					const result = results[i];
					const series = (result?.data?.series ?? []).map(focusSeries);
					const metrics = readMetrics(row.chart).map((name) => ({
						name,
						label_keys: declared.get(name)?.labels ?? [],
					}));
					const unit = declared.get(row.chart.metrics[0] ?? "")?.unit ?? "";
					const reading =
						row.reading && readings ? { item: row.reading, at: readings.generatedAt } : null;
					const value = reading?.item ?? { latest: latestOf(series), metrics, unit };
					const label = reading
						? readingLabel(reading.item, reading.at)
						: `${row.chart.title} ${readingValue(value)}`;
					const state = reading ? readingState(reading.item, reading.at) : null;
					const empty =
						state?.kind === "empty"
							? state.text
							: !reading && value.latest === null
								? noDataLabel(attempt ?? NOT_STARTED, node.status)
								: null;
					return (
						<li key={row.chart.title}>
							<article
								aria-labelledby={`${headingId}-${i}`}
								data-node-chart={row.chart.title}
								className="flex min-w-0 flex-col gap-1 rounded-lg border border-border-soft bg-bg px-2.5 pt-2 pb-1.5"
							>
								<header className="flex min-w-0 items-center gap-2">
									<h4
										id={`${headingId}-${i}`}
										className="m-0 line-clamp-2 min-w-0 text-xs font-normal wrap-anywhere text-fg-2"
									>
										{row.chart.title}
									</h4>
									<FocusValue
										item={value}
										className={cn(
											"ml-auto min-w-0 truncate",
											reading?.item.anomaly?.kind === "stale" && "text-fg-2",
										)}
									/>
									<FocusToggle
										focus={focus}
										nodeId={node.node_id}
										chart={row.chart.title}
										chartType={row.chart.type}
										enabled={enabled}
									/>
								</header>
								{reading?.item.anomaly && (
									<AnomalyNote item={reading.item} generatedAt={reading.at} />
								)}
								{row.chart.type !== "stat" &&
									(result?.isPending ? (
										<Skeleton style={{ height: PLOT_HEIGHT }} />
									) : (
										<FocusPlot
											series={series}
											type={row.chart.type}
											metrics={metrics}
											axis={axis}
											bucketSeconds={result?.data?.bucket_seconds ?? 1}
											staleSince={
												reading?.item.anomaly?.kind === "stale" ? reading.item.last_at : null
											}
											height={PLOT_HEIGHT}
											label={label}
											empty={empty}
											gapText={reading ? anomalyText(reading.item, reading.at) : null}
										/>
									))}
							</article>
						</li>
					);
				})}
			</ul>
			<p className="m-0 mt-2.5 text-xs text-fg-3">
				有异常的{TERM.focusItem}排在最前，其次是其余{TERM.focusItem}，再是其他{TERM.chart}
				。图表显示最新一次
				{TERM.attempt}的全程，要缩放就在{PAGE.monitor}
				{MONITOR_VIEW_LABEL.detail}里打开。{FOCUS.notVersioned}
			</p>
		</section>
	);
}

/** 还没开始执行的尝试：没有数据的原因按节点状态写。 */
const NOT_STARTED = { started_at: null, ended_at: null };

/** 一张图表读哪些指标：数值卡只读第一个（与关注项读数一样），其余读声明的全部。 */
const readMetrics = (chart: ChartView) =>
	chart.type === "stat" ? chart.metrics.slice(0, 1) : chart.metrics;
