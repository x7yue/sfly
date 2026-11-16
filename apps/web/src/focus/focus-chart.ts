import { type FocusSeries, seriesKey } from "@sfly/schema";
import { formatClock, formatHourMinute, formatMetric } from "#/lib/format";
import { DEFAULT_SHOWN, pickShown, type ShownPick } from "#/monitor/charts";

/** 图表的绘图区：四周留给纵轴刻度和横轴时刻的边距（px）。 */
export const PLOT_MARGIN = { left: 44, right: 4, top: 6, bottom: 20 };

/** 刚好够放下 `value`、又有整齐刻度的纵轴上限：数值的 1.08 倍向上取到同数量级的整数倍。 */
export function niceMax(value: number): number {
	if (!(value > 0)) return 1;
	const unit = 10 ** Math.floor(Math.log10(value));
	return Math.ceil((value * 1.08) / unit) * unit;
}

/** 横轴刻度的时刻：跨度不到 10 分钟时写到秒，更长（浸泡几个小时）只写到分钟，不让秒数当噪音。 */
const clockLabel = (time: number, span: number) =>
	span < 10 * 60 * 1000 ? formatClock(time) : formatHourMinute(new Date(time).toISOString());

/** 横轴的时间范围（毫秒）。 */
export interface PlotWindow {
	start: number;
	end: number;
}

/** 一个序列画出来的形状（像素坐标）。 */
export interface PlotLine {
	key: string;
	/** 每个桶的最新值连成线（只有一个桶时是一小段横线）。 */
	path: Array<[x: number, y: number]>;
	/** 桶里有最小、最大值之间的范围时的包络多边形；没有范围为 null。 */
	band: Array<[x: number, y: number]> | null;
	/** 柱状图的柱：左上角、宽和高。 */
	bars: Array<{ x: number; y: number; width: number; height: number }>;
}

export interface Plot {
	/** 纵轴最大值；纵轴从 0 起（有负值时从下方的整数倍起）。 */
	max: number;
	min: number;
	yTicks: Array<{ y: number; label: string }>;
	xTicks: Array<{ x: number; label: string }>;
	lines: PlotLine[];
	/** 没有新数据的一段：从最后一个点到横轴末端（绘图区里的左端和宽度）；没有要画的为 null。 */
	gap: { x: number; width: number } | null;
}

/**
 * 按容器的实际尺寸画图表：纵轴从 0 起（不把正常的小波动放大成大起大落），上限是所有桶的最大值（尖峰也在范围里）；
 * 横轴是 `window`（来源节点这次尝试的开始到结束或到现在），桶画在它覆盖的时段的中点。
 * `series` 是要画的那些序列（调用方已经挑好），`bucketSeconds` 是桶的跨度。
 * 给了 `gapFrom`（没有新数据时最后一个点的时间，毫秒）时，算出从它到横轴末端的一段，曲线停在最后一个点，之后画斜线。
 */
export function plotChart(
	series: ReadonlyArray<Pick<FocusSeries, "points"> & { key: string }>,
	window: PlotWindow,
	bucketSeconds: number,
	size: { width: number; height: number },
	gapFrom?: number,
): Plot {
	const { left, right, top, bottom } = PLOT_MARGIN;
	const plotW = Math.max(1, size.width - left - right);
	const plotH = Math.max(1, size.height - top - bottom);
	const span = Math.max(1, window.end - window.start);
	const points = series.flatMap((s) => s.points);
	const max = niceMax(Math.max(0, ...points.map((p) => p.max)));
	const lowest = Math.min(0, ...points.map((p) => p.min));
	const min = lowest < 0 ? -niceMax(-lowest) : 0;

	const x = (t: number) => left + Math.min(1, Math.max(0, (t - window.start) / span)) * plotW;
	const y = (v: number) => top + (1 - (v - min) / (max - min)) * plotH;
	const bucketMs = bucketSeconds * 1000;
	const barWidth = Math.max(2, (bucketMs / span) * plotW * 0.7);
	const lines = series.map(({ key, points: buckets }): PlotLine => {
		const at = buckets.map((b) => x(Date.parse(b.time) + bucketMs / 2));
		const first = at[0];
		const path: PlotLine["path"] =
			buckets.length === 1 && first !== undefined
				? [
						[first - 3, y(buckets[0]?.last ?? 0)],
						[first + 3, y(buckets[0]?.last ?? 0)],
					]
				: buckets.map((b, i) => [at[i] as number, y(b.last)]);
		const spread = buckets.length > 1 && buckets.some((b) => b.min < b.max);
		return {
			key,
			path,
			band: spread
				? [
						...buckets.map((b, i): [number, number] => [at[i] as number, y(b.max)]),
						...buckets.map((b, i): [number, number] => [at[i] as number, y(b.min)]).reverse(),
					]
				: null,
			bars: buckets.map((b, i) => ({
				x: (at[i] as number) - barWidth / 2,
				y: y(Math.max(b.last, 0)),
				width: barWidth,
				height: Math.max(0, Math.abs(y(b.last) - y(0))),
			})),
		};
	});
	return {
		max,
		min,
		yTicks: [min, (min + max) / 2, max].map((v) => ({ y: y(v), label: formatMetric(v) })),
		xTicks: [0, 1 / 3, 2 / 3, 1].map((f) => ({
			x: x(window.start + f * span),
			label: clockLabel(window.start + f * span, span),
		})),
		lines,
		gap:
			gapFrom === undefined || x(gapFrom) >= left + plotW
				? null
				: { x: x(gapFrom), width: left + plotW - x(gapFrom) },
	};
}

/**
 * 图表里画哪些序列：与详情的图表同一个规则（`pickShown`）——不超过 `limit` 条时全部画，超过时画平均值最高的 `limit` 条，
 * 没有点的排在最后，仍按原来的顺序画；挑好以后保持不变（传回上一次返回的 `pick`），读数每次刷新、平均值排名变了也不换，
 * 只在出现新序列时重新挑。`slot` 是序列在全部序列里的位置，颜色按它取（详情的图表按序列首次出现的顺序给
 * 全部序列分配颜色），所以隐藏别的序列时同一条序列的颜色不变。`hidden` 是没画的条数。
 */
export function shownSeries(
	series: readonly FocusSeries[],
	previous?: ShownPick,
	limit = DEFAULT_SHOWN,
): { series: Array<FocusSeries & { key: string; slot: number }>; hidden: number; pick: ShownPick } {
	const keyed = series.map((s, slot) => ({ ...s, key: seriesKey(s.metric, s.labels), slot }));
	const pick = pickShown(
		previous,
		keyed.map(({ key, points }) => ({ key, buckets: points })),
		null,
		limit,
	);
	const drawn = keyed.filter((s) => pick.shown.has(s.key));
	return { series: drawn, hidden: keyed.length - drawn.length, pick };
}
