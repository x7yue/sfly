import type { MetricBucket, MetricIncrement, MetricSeries } from "@sfly/schema";
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
export function valueAt(buckets: readonly MetricBucket[], t: number, bucketSeconds: number) {
	const span = bucketSeconds * 1000;
	for (let i = buckets.length - 1; i >= 0; i--) {
		const b = buckets[i] as MetricBucket;
		const start = Date.parse(b.time);
		if (start <= t) return t < start + span ? b.last : null;
	}
	return null;
}
