import type { MetricIncrement, MetricSeries } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { appendIncrement, balancedColumns, chartWindow, valueAt } from "./charts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const s = (seconds: number) => T0 + seconds * 1000;
const at = (seconds: number) => new Date(s(seconds)).toISOString();

describe("图表的时间范围", () => {
	const ran = { started_at: at(10), ended_at: at(40) };

	it("没有缩放时横轴是节点实际运行的时段", () => {
		expect(chartWindow(ran, { start: s(0), end: s(60) }, s(60))).toEqual({
			start: s(10),
			end: s(40),
		});
	});

	it("时间线拖选的范围截取节点运行的时段", () => {
		expect(chartWindow(ran, { start: s(20), end: s(80) }, s(80))).toEqual({
			start: s(20),
			end: s(40),
		});
		expect(chartWindow(ran, { start: s(0), end: s(15) }, s(80))).toEqual({
			start: s(10),
			end: s(15),
		});
	});

	it("拖选的范围与节点运行的时段不相交时没有横轴", () => {
		expect(chartWindow(ran, { start: s(50), end: s(60) }, s(60))).toBeNull();
	});

	it("执行中的节点到现在为止", () => {
		expect(
			chartWindow({ started_at: at(10), ended_at: null }, { start: s(0), end: s(30) }, s(30)),
		).toEqual({ start: s(10), end: s(30) });
	});

	it("还没开始执行的节点没有横轴", () => {
		expect(
			chartWindow({ started_at: null, ended_at: null }, { start: s(0), end: s(30) }, s(30)),
		).toBeNull();
	});

	it("刚开始执行的节点至少显示 1 秒", () => {
		expect(
			chartWindow({ started_at: at(10), ended_at: null }, { start: s(0), end: s(10) }, s(10)),
		).toEqual({ start: s(10), end: s(11) });
	});
});

describe("组内列数", () => {
	it("放得下时一行排完", () => {
		expect(balancedColumns(2, 1200, 340)).toBe(2);
		expect(balancedColumns(3, 1200, 340)).toBe(3);
	});

	it("放不下时各行数量尽量平均：4 张排成 2 × 2，而不是 3 + 1", () => {
		expect(balancedColumns(4, 1200, 340)).toBe(2);
		expect(balancedColumns(5, 1200, 340)).toBe(3);
		expect(balancedColumns(7, 1200, 340)).toBe(3);
		expect(balancedColumns(10, 1200, 230)).toBe(5);
		expect(balancedColumns(6, 1000, 230)).toBe(3);
	});

	it("宽度不够一列也排一列；没有图表时一列", () => {
		expect(balancedColumns(3, 200, 340)).toBe(1);
		expect(balancedColumns(0, 1200, 340)).toBe(1);
	});
});

const series = (buckets: [number, number][], bucketSeconds = 1): MetricSeries => ({
	run_id: "00000000-0000-4000-8000-000000000001",
	expired: false,
	chain_instance_id: "00000000-0000-4000-8000-000000000002",
	node_id: "load",
	task_id: "00000000-0000-4000-8000-000000000003",
	attempt: 1,
	from: buckets.length ? at(buckets[0]?.[0] ?? 0) : null,
	to: buckets.length ? at(buckets.at(-1)?.[0] ?? 0) : null,
	bucket_seconds: bucketSeconds,
	truncated: false,
	series: [
		{
			name: "tps",
			buckets: buckets.map(([t, v]) => ({
				time: at(t),
				points: 1,
				min: v,
				max: v,
				avg: v,
				last: v,
			})),
		},
	],
});

const increment = (points: [string, number, number][], attempt = 1): MetricIncrement => ({
	task_id: "00000000-0000-4000-8000-000000000003",
	chain_instance_id: "00000000-0000-4000-8000-000000000002",
	node_id: "load",
	attempt,
	points: points.map(([name, t, value]) => ({ name, time: at(t), value, min: value, max: value })),
});

const lastOf = (result: MetricSeries, name = "tps") =>
	result.series.find((x) => x.name === name)?.buckets.map((b) => [b.time, b.points, b.last]);

describe("实时追加的指标点", () => {
	it("每秒一个桶时追加为新桶", () => {
		const result = appendIncrement(series([[0, 1]]), increment([["tps", 1, 5]]));
		expect(lastOf(result)).toEqual([
			[at(0), 1, 1],
			[at(1), 1, 5],
		]);
	});

	it("桶跨多秒时落进最后一个桶的点合并，之后的点开新桶（按 from 对齐）", () => {
		const base = series([[0, 1]], 10);
		const merged = appendIncrement(base, increment([["tps", 4, 3]]));
		expect(merged.series[0]?.buckets).toEqual([
			{ time: at(0), points: 2, min: 1, max: 3, avg: 2, last: 3 },
		]);
		expect(lastOf(appendIncrement(merged, increment([["tps", 23, 7]])))).toEqual([
			[at(0), 2, 3],
			[at(20), 1, 7],
		]);
	});

	it("目录里还没有的指标新增一条序列；同一秒重复的点和更早的点不追加", () => {
		const result = appendIncrement(
			series([[5, 1]]),
			increment([
				["tps", 5, 9],
				["tps", 3, 9],
				["p99", 6, 120],
			]),
		);
		expect(lastOf(result)).toEqual([[at(5), 1, 1]]);
		expect(lastOf(result, "p99")).toEqual([[at(6), 1, 120]]);
	});

	it("其他尝试的点不追加", () => {
		const base = series([[0, 1]]);
		expect(appendIncrement(base, increment([["tps", 1, 5]], 2))).toBe(base);
	});
});

describe("悬停读数", () => {
	const buckets = series(
		[
			[0, 1],
			[10, 2],
		],
		10,
	).series[0]?.buckets;

	it("取悬停时刻所在桶的最新值；不在任何桶里时没有读数", () => {
		expect(valueAt(buckets ?? [], s(4), 10)).toBe(1);
		expect(valueAt(buckets ?? [], s(19.5), 10)).toBe(2);
		expect(valueAt(buckets ?? [], s(25), 10)).toBeNull();
		expect(valueAt(buckets ?? [], s(-1), 10)).toBeNull();
	});
});
