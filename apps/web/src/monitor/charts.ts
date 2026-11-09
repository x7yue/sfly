import {
	compareSeries,
	isLabeled,
	type MetricBucket,
	type MetricDeclaration,
	type MetricIncrement,
	type MetricSeries,
	seriesKey,
	sortedLabels,
} from "@sfly/schema";
import { formatMetric } from "#/lib/format";
import type { ChartLine } from "./MetricChart";
import type { TimeRange } from "./timeline-model";

/**
 * 图表工作区的计算（纯逻辑，单测见 charts.test.ts）：图表横轴的时间范围、组内列数、实时追加的指标点、悬停读数。
 * 时间一律是毫秒时间戳。
 */

/** 图表横轴最短的时长：刚开始执行的节点也有可读的横轴。 */
export const MIN_CHART_SPAN = 1000;

/**
 * 一张图表的横轴：节点（这次尝试）实际运行的时段（执行中到现在），与时间线当前显示的范围（拖选缩放）取交集。
 * 还没开始执行，或与显示的范围不相交时为 null。
 */
export function chartWindow(
	attempt: { started_at: string | null; ended_at: string | null },
	visible: TimeRange,
	now: number,
): TimeRange | null {
	if (attempt.started_at === null) return null;
	const started = Date.parse(attempt.started_at);
	const ended = attempt.ended_at === null ? now : Date.parse(attempt.ended_at);
	if (ended < visible.start || started > visible.end) return null;
	const start = Math.max(started, visible.start);
	const end = Math.min(ended, visible.end);
	return { start, end: Math.max(end, start + MIN_CHART_SPAN) };
}

/**
 * 组内的列数：按可用宽度最多能放几列（每列至少 minWidth），再让各行的数量尽量平均
 * （4 张放 3 列会剩 1 张单独一行，改成 2 × 2）。
 */
export function balancedColumns(count: number, width: number, minWidth: number): number {
	const max = Math.max(1, Math.floor(width / minWidth));
	const columns = Math.min(max, Math.max(1, count));
	const rows = Math.ceil(Math.max(1, count) / columns);
	return Math.ceil(Math.max(1, count) / rows);
}

/**
 * 把运行 SSE 的 metrics 增量追加进序列查询的结果：只追加同一尝试的点，按序列（指标名 + 标签，#78）合并；
 * 落进最后一个桶的点合并，之后的点按 from 对齐开新桶；不晚于最后一个桶的点（重连补齐时已经包含）不追加。
 * 运行中新出现的序列排在同一指标已有的序列旁边（同一指标按标签排序，与序列查询一致），没有的指标排在最后。
 * 没有变化时返回原对象。
 */
export function appendIncrement(series: MetricSeries, increment: MetricIncrement): MetricSeries {
	if (
		increment.attempt !== series.attempt ||
		increment.node_id !== series.node_id ||
		increment.chain_instance_id !== series.chain_instance_id
	) {
		return series;
	}
	const span = series.bucket_seconds * 1000;
	const byKey = new Map(
		series.series.map((s) => [
			seriesKey(s.name, s.labels),
			{ name: s.name, labels: s.labels, buckets: [...s.buckets] },
		]),
	);
	let added = false;
	let origin = series.from === null ? null : Date.parse(series.from);
	let changed = false;
	for (const point of increment.points) {
		const t = Date.parse(point.time);
		origin ??= t;
		const key = seriesKey(point.name, point.labels);
		let entry = byKey.get(key);
		if (!entry) {
			entry = { name: point.name, labels: sortedLabels(point.labels), buckets: [] };
			byKey.set(key, entry);
			added = true;
		}
		const buckets = entry.buckets;
		const last = buckets.at(-1);
		const lastStart = last ? Date.parse(last.time) : null;
		if (last && lastStart !== null && t < lastStart + span) {
			// 落在最后一个桶里：每秒一个桶时就是同一秒（已经有了），否则合并。
			if (span === 1000 || t <= lastStart) continue;
			buckets[buckets.length - 1] = {
				time: last.time,
				points: last.points + 1,
				min: Math.min(last.min, point.min),
				max: Math.max(last.max, point.max),
				avg: (last.avg * last.points + point.value) / (last.points + 1),
				last: point.value,
			};
		} else {
			if (lastStart !== null && t < lastStart) continue;
			const k = Math.floor((t - origin) / span);
			buckets.push({
				time: new Date(origin + k * span).toISOString(),
				points: 1,
				min: point.min,
				max: point.max,
				avg: point.value,
				last: point.value,
			});
		}
		changed = true;
	}
	if (!changed) return series;
	const from = series.from ?? (origin === null ? null : new Date(origin).toISOString());
	const lastTimes = [...byKey.values()].flatMap((s) => s.buckets.at(-1)?.time ?? []).sort();
	let entries = [...byKey];
	if (added) {
		// 指标的位置取它在原结果里第一次出现的位置；同一指标的序列按标签排序（与序列查询一致）。
		const order = new Map<string, number>();
		for (const [i, s] of series.series.entries()) if (!order.has(s.name)) order.set(s.name, i);
		const rank = (name: string) => order.get(name) ?? Number.POSITIVE_INFINITY;
		const firstSeen = new Map<string, number>();
		for (const [i, [, s]] of entries.entries())
			if (!firstSeen.has(s.name)) firstSeen.set(s.name, i);
		entries = entries.sort(
			([, a], [, b]) =>
				rank(a.name) - rank(b.name) ||
				(firstSeen.get(a.name) ?? 0) - (firstSeen.get(b.name) ?? 0) ||
				compareSeries(a, b),
		);
	}
	return {
		...series,
		from,
		to: lastTimes.at(-1) ?? series.to,
		series: entries.map(([, s]) => s),
	};
}

/**
 * 图例里一个序列的名字（#78）：不带标签时是指标名；带标签时是标签值以「 · 」连接（按声明的标签键的顺序，
 * 没有声明时按键名），图表引用多个指标时前面再加上指标名（例如 `read_bytes · sda`）。
 */
export function seriesName(
	name: string,
	labels: Readonly<Record<string, string>>,
	keys: readonly string[] | undefined,
	multiMetric: boolean,
): string {
	const order = keys?.length ? keys : Object.keys(labels).sort();
	const values = order.flatMap((k) => labels[k] ?? []);
	if (values.length === 0) return name;
	return (multiMetric ? [name, ...values] : values).join(" · ");
}

/**
 * 一张图表引用的指标画成的线：每个序列（指标名 + 标签）一条，按指标的引用顺序、同一指标按序列查询的顺序。
 * 还没有任何数据的指标：不带标签时占一条以指标名命名的空线（图表照常画出空图），带标签时没有线。
 */
export function chartLines(
	names: readonly string[],
	declared: readonly MetricDeclaration[],
	series: MetricSeries["series"] | undefined,
): ChartLine[] {
	const byName = new Map(declared.map((m) => [m.name, m]));
	return names.flatMap((name): ChartLine[] => {
		const metric = byName.get(name);
		const labeled = !!metric && isLabeled(metric);
		const found = series?.filter((s) => s.name === name) ?? [];
		if (found.length === 0) return labeled ? [] : [{ name, key: name, labeled, buckets: [] }];
		return found.map((s) => ({
			name: seriesName(s.name, s.labels, metric?.labels, names.length > 1),
			key: seriesKey(s.name, s.labels),
			labeled,
			buckets: s.buckets,
		}));
	});
}

/** 序列多于这个数时，图表默认只显示平均值最高的这么多个（#78）。 */
export const DEFAULT_SHOWN = 10;

/**
 * 默认显示的序列（按身份）：不超过 limit 个时全部显示；超过时按传入的桶（调用方截取到当前时间范围）的平均值
 * 从高到低取前 limit 个，平均值按桶的点数加权；没有数据的序列排在最后，平均值相同时取靠前的。
 */
export function defaultShown(
	lines: readonly { key: string; buckets: readonly MetricBucket[] }[],
	limit = DEFAULT_SHOWN,
): Set<string> {
	if (lines.length <= limit) return new Set(lines.map((l) => l.key));
	const average = (buckets: readonly MetricBucket[]) => {
		let points = 0;
		let sum = 0;
		for (const b of buckets) {
			points += b.points;
			sum += b.avg * b.points;
		}
		return points === 0 ? Number.NEGATIVE_INFINITY : sum / points;
	};
	return new Set(
		lines
			.map((l, i) => ({ key: l.key, i, avg: average(l.buckets) }))
			.sort((a, b) => b.avg - a.avg || a.i - b.i)
			.slice(0, limit)
			.map((l) => l.key),
	);
}

/** 图表上默认显示的序列，及挑选时的时间范围与已有的序列。 */
export interface ShownPick {
	/** 挑选时用户选的时间范围（缩放范围；null 为整个运行）。 */
	range: unknown;
	keys: ReadonlySet<string>;
	shown: ReadonlySet<string>;
}

/**
 * 默认显示的序列（{@link defaultShown}）：只在用户改了时间范围（拖选缩放、回到实时，range 换了对象）或出现新序列时
 * 重新挑选；新点到来、时钟推进时返回原来的挑选，曲线不会随数据变化忽隐忽现。
 */
export function pickShown(
	previous: ShownPick | undefined,
	lines: readonly { key: string; buckets: readonly MetricBucket[] }[],
	range: unknown,
	limit = DEFAULT_SHOWN,
): ShownPick {
	if (previous && previous.range === range && lines.every((l) => previous.keys.has(l.key))) {
		return previous;
	}
	return { range, keys: new Set(lines.map((l) => l.key)), shown: defaultShown(lines, limit) };
}

/**
 * 图表里每个序列的颜色序号：按序列在这张图表里首次出现的顺序分配，之后不变——运行中新序列按标签排序插在已有序列之间，
 * 已有曲线也不换色。没有新序列时返回原来的分配。
 */
export function colorSlots(
	previous: ReadonlyMap<string, number>,
	keys: readonly string[],
): ReadonlyMap<string, number> {
	const added = keys.filter((k) => !previous.has(k));
	if (added.length === 0) return previous;
	const next = new Map(previous);
	for (const key of added) if (!next.has(key)) next.set(key, next.size);
	return next;
}

/**
 * 标题栏的最新值取哪条线：只有一条可见线时取它（没有可见线时为 undefined）；多条线里恰有一条不带标签的指标
 * （通常是合计）时取它；否则为 null，不显示数值，读数交给悬停提示。
 */
export function latestLine<L extends { labeled?: boolean }>(
	visible: readonly L[],
): L | undefined | null {
	if (visible.length <= 1) return visible[0];
	const totals = visible.filter((l) => !l.labeled);
	return totals.length === 1 && totals.length < visible.length ? totals[0] : null;
}

/** 悬停时刻所在的桶；不在任何桶里时为 null。 */
export function bucketAt(
	buckets: readonly MetricBucket[],
	t: number,
	bucketSeconds: number,
): MetricBucket | null {
	const span = bucketSeconds * 1000;
	for (let i = buckets.length - 1; i >= 0; i--) {
		const b = buckets[i] as MetricBucket;
		const start = Date.parse(b.time);
		if (start <= t) return t < start + span ? b : null;
	}
	return null;
}

/** 悬停读数：最新值；桶里有范围时带上最小–最大值（尖峰在读数里也看得到）。 */
export function formatReading(b: MetricBucket): string {
	const last = formatMetric(b.last);
	return b.min < b.max ? `${last}（${formatMetric(b.min)}–${formatMetric(b.max)}）` : last;
}

/**
 * 纵轴范围：包含每个桶的最小值与最大值（降采样合并掉的短时尖峰也在范围内，故事 14）；
 * fromZero 时从 0 起（柱状、面积与迷你趋势）。上方留 12%。
 */
export function valueExtent(
	lines: readonly { buckets: readonly MetricBucket[] }[],
	fromZero: boolean,
): { min: number; max: number; top: number } {
	const buckets = lines.flatMap((l) => l.buckets);
	// 所有序列都隐藏时没有桶。
	if (buckets.length === 0) return { min: 0, max: 1, top: 1.12 };
	let min = Math.min(...buckets.map((b) => Math.min(b.min, b.last)));
	let max = Math.max(...buckets.map((b) => Math.max(b.max, b.last)));
	if (fromZero) min = Math.min(0, min);
	if (max - min < 1e-9) max = min + 1;
	return { min, max, top: max + (max - min) * 0.12 };
}

/** 是否有桶带范围（最小值小于最大值）：有时画最小–最大包络。 */
export const hasSpread = (buckets: readonly MetricBucket[]) => buckets.some((b) => b.min < b.max);

/** 最小–最大包络的多边形顶点：沿各桶最大值向前，再沿最小值返回。 */
export function envelopePoints(
	buckets: readonly MetricBucket[],
	x: (b: MetricBucket) => number,
	y: (v: number) => number,
): Array<[number, number]> {
	return [
		...buckets.map((b): [number, number] => [x(b), y(b.max)]),
		...[...buckets].reverse().map((b): [number, number] => [x(b), y(b.min)]),
	];
}
