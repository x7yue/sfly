import type { MetricBucket, MetricIncrement, MetricSeries } from "@sfly/schema";
import { formatMetric } from "#/lib/format";
import type { TimeRange } from "./timeline";

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
 * 把运行 SSE 的 metrics 增量追加进序列查询的结果：只追加同一尝试的点；落进最后一个桶的点合并，
 * 之后的点按 from 对齐开新桶；不晚于最后一个桶的点（重连补齐时已经包含）不追加。没有变化时返回原对象。
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
	const byName = new Map(series.series.map((s) => [s.name, [...s.buckets]]));
	let origin = series.from === null ? null : Date.parse(series.from);
	let changed = false;
	for (const point of increment.points) {
		const t = Date.parse(point.time);
		origin ??= t;
		const buckets = byName.get(point.name) ?? [];
		if (!byName.has(point.name)) byName.set(point.name, buckets);
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
	const lastTimes = [...byName.values()].flatMap((b) => b.at(-1)?.time ?? []).sort();
	return {
		...series,
		from,
		to: lastTimes.at(-1) ?? series.to,
		series: [...byName].map(([name, buckets]) => ({ name, buckets })),
	};
}

/** 悬停时刻所在桶的最新值；不在任何桶里时为 null。 */
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
