import type { MetricBucket, MetricIncrement, MetricSeries } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { type ChartGroup, failedFirst } from "./chart-groups";
import {
	appendIncrement,
	balancedColumns,
	bucketAt,
	chartLines,
	chartWindow,
	colorSlots,
	defaultShown,
	envelopePoints,
	formatReading,
	hasSpread,
	latestLine,
	pickShown,
	valueExtent,
} from "./charts";

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
	series_capped: false,
	series: [
		{
			name: "tps",
			labels: {},
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

const increment = (
	points: Array<[string, number, number] | [string, number, number, Record<string, string>]>,
	attempt = 1,
): MetricIncrement => ({
	task_id: "00000000-0000-4000-8000-000000000003",
	chain_instance_id: "00000000-0000-4000-8000-000000000002",
	node_id: "load",
	attempt,
	points: points.map(([name, t, value, labels = {}]) => ({
		name,
		labels,
		time: at(t),
		value,
		min: value,
		max: value,
	})),
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

	it("按序列（指标名 + 标签）合并：运行中出现的新序列排在同一指标已有的序列旁边，按标签排序", () => {
		const base: MetricSeries = {
			...series([[0, 1]]),
			series: [
				{ name: "conn", labels: { host: "b" }, buckets: series([[0, 2]]).series[0]?.buckets ?? [] },
				...series([[0, 1]]).series,
			],
		};
		const result = appendIncrement(
			base,
			increment([
				["conn", 1, 20, { host: "b" }],
				["conn", 1, 30, { host: "a" }],
				["tps", 1, 5],
				["p99", 1, 7],
			]),
		);
		expect(result.series.map((x) => [x.name, x.labels, x.buckets.map((b) => b.last)])).toEqual([
			["conn", { host: "a" }, [30]],
			["conn", { host: "b" }, [2, 20]],
			["tps", {}, [1, 5]],
			["p99", {}, [7]],
		]);
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
		expect(bucketAt(buckets ?? [], s(4), 10)?.last).toBe(1);
		expect(bucketAt(buckets ?? [], s(19.5), 10)?.last).toBe(2);
		expect(bucketAt(buckets ?? [], s(25), 10)).toBeNull();
		expect(bucketAt(buckets ?? [], s(-1), 10)).toBeNull();
	});
});

describe("降采样后的尖峰（故事 14）", () => {
	const bucket = (sec: number, last: number, min: number, max: number) => ({
		time: at(sec),
		points: 10,
		min,
		max,
		avg: last,
		last,
	});
	const spiky = [bucket(0, 10, 9, 10), bucket(10, 11, 2, 95), bucket(20, 12, 11, 12)];

	it("纵轴范围包含每个桶的最小值与最大值，不只看最新值", () => {
		expect(valueExtent([{ buckets: spiky }], false)).toMatchObject({ min: 2, max: 95 });
		expect(valueExtent([{ buckets: spiky }], true).min).toBe(0);
	});

	it("包络：沿最大值向前、沿最小值返回的闭合多边形", () => {
		const pts = envelopePoints(
			spiky,
			(b) => Date.parse(b.time),
			(v) => v,
		);
		expect(pts).toEqual([
			[s(0), 10],
			[s(10), 95],
			[s(20), 12],
			[s(20), 11],
			[s(10), 2],
			[s(0), 9],
		]);
		// 每个桶都没有范围（每秒一个点、最小值等于最大值）时不画包络。
		expect(hasSpread([bucket(0, 1, 1, 1)])).toBe(false);
		expect(hasSpread(spiky)).toBe(true);
	});

	it("悬停读数给出所在桶的最新值与最小–最大值", () => {
		expect(bucketAt(spiky, s(15), 10)).toBe(spiky[1]);
		expect(formatReading(spiky[1] as MetricBucket)).toBe("11（2–95）");
		expect(formatReading(bucket(0, 3, 3, 3))).toBe("3");
		expect(bucketAt(spiky, s(35), 10)).toBeNull();
	});
});

describe("序列多时默认显示的序列（#78）", () => {
	const b = (points: number, avg: number): MetricBucket => ({
		time: at(0),
		points,
		min: avg,
		max: avg,
		avg,
		last: avg,
	});
	const line = (key: string, ...buckets: MetricBucket[]) => ({ key, buckets });

	it("不超过上限时全部显示", () => {
		const lines = [line("a", b(1, 1)), line("b"), line("c", b(1, 3))];
		expect(defaultShown(lines, 3)).toEqual(new Set(["a", "b", "c"]));
	});

	it("超过上限时按平均值（按点数加权）从高到低取前几个；没有数据的序列排在最后，平均值相同时取靠前的", () => {
		const lines = [
			line("empty"),
			// (10×1 + 100×1) / 2 = 55，按点数加权是 (10×9 + 100×1) / 10 = 19。
			line("weighted", b(9, 10), b(1, 100)),
			line("high", b(1, 50)),
			line("tie1", b(2, 20)),
			line("tie2", b(2, 20)),
		];
		expect(defaultShown(lines, 2)).toEqual(new Set(["high", "tie1"]));
		expect(defaultShown(lines, 4)).toEqual(new Set(["high", "tie1", "tie2", "weighted"]));
	});
});

describe("默认显示的序列只在时间范围变化或出现新序列时重新挑选（#78）", () => {
	const b = (avg: number): MetricBucket => ({
		time: at(0),
		points: 1,
		min: avg,
		max: avg,
		avg,
		last: avg,
	});
	const line = (key: string, avg: number) => ({ key, buckets: [b(avg)] });
	const zoomA = { start: s(0), end: s(10) };

	it("新点到来、时钟推进时保持原来的挑选", () => {
		const first = pickShown(undefined, [line("a", 1), line("b", 2), line("c", 3)], null, 2);
		expect(first.shown).toEqual(new Set(["b", "c"]));
		// a 的平均值后来变成最高，但时间范围没变、也没有新序列：不重新挑选。
		const next = pickShown(first, [line("a", 9), line("b", 2), line("c", 3)], null, 2);
		expect(next).toBe(first);
	});

	it("用户改了时间范围时按新范围重新挑选", () => {
		const first = pickShown(undefined, [line("a", 1), line("b", 2), line("c", 3)], null, 2);
		const zoomed = pickShown(first, [line("a", 9), line("b", 2), line("c", 3)], zoomA, 2);
		expect(zoomed.shown).toEqual(new Set(["a", "c"]));
		// 同一个缩放范围对象：不再重新挑选。
		expect(pickShown(zoomed, [line("a", 0), line("b", 2), line("c", 3)], zoomA, 2)).toBe(zoomed);
	});

	it("出现新序列时重新挑选", () => {
		const first = pickShown(undefined, [line("a", 1), line("b", 2), line("c", 3)], null, 2);
		const next = pickShown(
			first,
			[line("a", 9), line("b", 2), line("c", 3), line("d", 0)],
			null,
			2,
		);
		expect(next.shown).toEqual(new Set(["a", "c"]));
	});
});

describe("曲线颜色按序列首次出现的顺序固定（#78）", () => {
	it("新序列取下一个颜色，插在已有序列之间也不让已有曲线换色", () => {
		const first = colorSlots(new Map(), ["a", "c"]);
		expect([...first]).toEqual([
			["a", 0],
			["c", 1],
		]);
		const next = colorSlots(first, ["a", "b", "c"]);
		expect([...next]).toEqual([
			["a", 0],
			["c", 1],
			["b", 2],
		]);
	});

	it("没有新序列时返回原来的分配", () => {
		const first = colorSlots(new Map(), ["a", "b"]);
		expect(colorSlots(first, ["b"])).toBe(first);
	});
});

describe("标题栏的最新值（#78）", () => {
	const line = (name: string, labeled = false) => ({ name, labeled, buckets: [] });

	it("只有一条可见线时取这条线", () => {
		const only = line("conn · a", true);
		expect(latestLine([only])).toBe(only);
		expect(latestLine([])).toBeUndefined();
	});

	it("多条线且有一条不带标签的指标（合计）时取它", () => {
		const total = line("tps");
		expect(latestLine([line("conn · a", true), total, line("conn · b", true)])).toBe(total);
	});

	it("多条线、没有唯一的合计时不取任何一条（读数交给悬停提示）", () => {
		expect(latestLine([line("conn · a", true), line("conn · b", true)])).toBeNull();
		expect(latestLine([line("latency_ms"), line("p99_ms")])).toBeNull();
	});
});

describe("图表的线（#78）", () => {
	const declared = [
		{ name: "tps", unit: "", kind: "gauge" as const },
		{ name: "conn_tps", unit: "", kind: "gauge" as const, labels: ["host"] },
	];
	const bucket: MetricBucket = { time: at(0), points: 1, min: 1, max: 1, avg: 1, last: 1 };

	it("每个序列一条线；带标签的序列用标签值命名并标为带标签", () => {
		const lines = chartLines(["tps", "conn_tps"], declared, [
			{ name: "tps", labels: {}, buckets: [bucket] },
			{ name: "conn_tps", labels: { host: "a" }, buckets: [bucket] },
		]);
		expect(lines.map(({ name, labeled }) => ({ name, labeled }))).toEqual([
			{ name: "tps", labeled: false },
			{ name: "conn_tps · a", labeled: true },
		]);
		expect(new Set(lines.map((l) => l.key)).size).toBe(2);
	});

	it("还没有数据的指标：不带标签时占一条空线，带标签时没有线（不占图例项和颜色）", () => {
		expect(chartLines(["tps", "conn_tps"], declared, undefined)).toEqual([
			{ name: "tps", key: "tps", labeled: false, buckets: [] },
		]);
		expect(chartLines(["conn_tps"], declared, [])).toEqual([]);
	});
});

describe("图表分组的显示顺序", () => {
	const group = (key: string, status: string) =>
		({ key, node: { node_id: key, status } }) as unknown as ChartGroup;
	const keys = (groups: readonly ChartGroup[]) => groups.map((g) => g.key);

	it("有失败的节点时，失败节点的组排在最前，其余保持链上的执行顺序", () => {
		const groups = [
			group("fetch", "success"),
			group("verify", "failed"),
			group("probe", "running"),
			group("check", "failed"),
		];
		expect(keys(failedFirst(groups))).toEqual(["verify", "check", "fetch", "probe"]);
	});

	it("没有失败的节点时顺序不变（返回同一个数组）", () => {
		const groups = [group("fetch", "success"), group("probe", "running")];
		expect(failedFirst(groups)).toBe(groups);
	});
});
