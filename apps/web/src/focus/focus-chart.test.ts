import { describe, expect, it } from "vitest";
import { niceMax, PLOT_MARGIN, plotChart, shownSeries } from "./focus-chart";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const point = (s: number, last: number, min = last, max = last, avg = last, points = 1) => ({
	time: new Date(T0 + s * 1000).toISOString(),
	min,
	max,
	avg,
	last,
	points,
});
const SIZE = { width: 344, height: 126 };
const WINDOW = { start: T0, end: T0 + 100_000 };
const plotH = SIZE.height - PLOT_MARGIN.top - PLOT_MARGIN.bottom;

describe("图表的纵轴上限", () => {
	it("向上取到同数量级的整数倍，留出一点余量", () => {
		expect(niceMax(21.4)).toBe(30);
		expect(niceMax(63.5)).toBe(70);
		expect(niceMax(100)).toBe(200);
		expect(niceMax(0.35)).toBeCloseTo(0.4);
	});

	it("没有大于 0 的值时是 1", () => {
		expect(niceMax(0)).toBe(1);
		expect(niceMax(Number.NaN)).toBe(1);
	});
});

describe("按容器的实际尺寸画图表", () => {
	it("纵轴从 0 起：0 在绘图区底边，上限在顶边；小波动不会被放大", () => {
		const plot = plotChart(
			[{ key: "a", points: [point(0, 50), point(50, 52), point(99, 51)] }],
			WINDOW,
			1,
			SIZE,
		);
		expect(plot.min).toBe(0);
		expect(plot.max).toBe(60);
		expect(plot.yTicks.map((t) => t.label)).toEqual(["0", "30", "60"]);
		expect(plot.yTicks[0]?.y).toBeCloseTo(PLOT_MARGIN.top + plotH);
		expect(plot.yTicks[2]?.y).toBeCloseTo(PLOT_MARGIN.top);
		// 50 到 52 只差 2/60 的高度。
		const [a, b] = plot.lines[0]?.path ?? [];
		expect(Math.abs((a?.[1] ?? 0) - (b?.[1] ?? 0))).toBeLessThan(plotH / 20);
	});

	it("横轴铺满 window：开始在绘图区左边，结束在右边", () => {
		const plot = plotChart([{ key: "a", points: [point(0, 1)] }], WINDOW, 1, SIZE);
		expect(plot.xTicks[0]?.x).toBe(PLOT_MARGIN.left);
		expect(plot.xTicks[3]?.x).toBe(SIZE.width - PLOT_MARGIN.right);
	});

	it("横轴刻度的时刻：短的运行写到秒，几个小时的写到分钟", () => {
		const short = plotChart([{ key: "a", points: [] }], WINDOW, 1, SIZE);
		expect(short.xTicks[0]?.label).toMatch(/^\d\d:\d\d:\d\d$/);
		const long = plotChart(
			[{ key: "a", points: [] }],
			{ start: T0, end: T0 + 4 * 3600_000 },
			240,
			SIZE,
		);
		expect(long.xTicks.map((t) => t.label)).toSatisfy((labels: string[]) =>
			labels.every((l) => /^\d\d:\d\d$/.test(l)),
		);
	});

	it("只有一个桶时画一小段横线，不是一个点", () => {
		const [line] = plotChart([{ key: "a", points: [point(10, 5)] }], WINDOW, 1, SIZE).lines;
		expect(line?.path).toHaveLength(2);
		expect(line?.path[1]?.[0]).toBeGreaterThan(line?.path[0]?.[0] ?? 0);
		expect(line?.path[0]?.[1]).toBe(line?.path[1]?.[1]);
	});

	it("桶里有最小到最大的范围时画包络，范围抹掉的尖峰也在纵轴范围内", () => {
		const plot = plotChart(
			[{ key: "a", points: [point(0, 10, 10, 10), point(10, 12, 8, 90)] }],
			WINDOW,
			10,
			SIZE,
		);
		expect(plot.max).toBeGreaterThanOrEqual(90);
		expect(plot.lines[0]?.band).toHaveLength(4);
		const flat = plotChart([{ key: "a", points: [point(0, 10), point(10, 12)] }], WINDOW, 10, SIZE);
		expect(flat.lines[0]?.band).toBeNull();
	});

	it("柱状图：柱从 0 线往上，高度和值成比例", () => {
		const plot = plotChart([{ key: "a", points: [point(0, 30), point(50, 60)] }], WINDOW, 10, SIZE);
		const [short, tall] = plot.lines[0]?.bars ?? [];
		expect((tall?.height ?? 0) / (short?.height ?? 1)).toBeCloseTo(2);
		expect((short?.y ?? 0) + (short?.height ?? 0)).toBeCloseTo(PLOT_MARGIN.top + plotH);
	});

	it("没有任何数据时也有刻度：0 到 1", () => {
		const plot = plotChart([{ key: "a", points: [] }], WINDOW, 1, SIZE);
		expect(plot.yTicks.map((t) => t.label)).toEqual(["0", "0.50", "1"]);
		expect(plot.lines[0]?.path).toEqual([]);
	});
});

describe("图表里画哪些序列", () => {
	const series = (n: number, level: (i: number) => number) =>
		Array.from({ length: n }, (_, i) => ({
			metric: "cpu",
			labels: { pid: String(i) },
			points: [point(0, level(i))],
		}));

	it("不超过上限时全部画", () => {
		const shown = shownSeries(series(4, (i) => i));
		expect(shown.series.map((s) => s.labels.pid)).toEqual(["0", "1", "2", "3"]);
		expect(shown.hidden).toBe(0);
	});

	it("超过上限时画值最高的几条，仍按原来的顺序，并说明有几条没画", () => {
		const shown = shownSeries(
			series(5, (i) => [5, 90, 1, 80, 70][i] as number),
			3,
		);
		expect(shown.series.map((s) => s.labels.pid)).toEqual(["1", "3", "4"]);
		expect(shown.hidden).toBe(2);
		// 颜色按序列在全部序列里的位置取，隐藏的序列不让后面的序列换色。
		expect(shown.series.map((s) => s.slot)).toEqual([1, 3, 4]);
	});

	it("平均值按桶的点数加权，和详情的图表挑的是同几条：最后一个值很高的序列不一定入选", () => {
		// spike 只在一个点上冲到 100，其余 99 个点都是 1，平均约 2；其余 10 条平均 5。按桶的最新值取平均会选中 spike。
		const list = [
			{
				metric: "cpu",
				labels: { pid: "spike" },
				points: [point(0, 100, 100, 100, 100, 1), point(1, 1, 1, 1, 1, 99)],
			},
			...series(10, () => 5),
		];
		const shown = shownSeries(list);
		expect(shown.series.map((s) => s.labels.pid)).not.toContain("spike");
		expect(shown.hidden).toBe(1);
	});

	it("没有点的序列排在最后", () => {
		const list = [
			{ metric: "cpu", labels: { pid: "a" }, points: [] },
			{ metric: "cpu", labels: { pid: "b" }, points: [point(0, 1)] },
		];
		expect(shownSeries(list, 1).series.map((s) => s.labels.pid)).toEqual(["b"]);
	});
});
