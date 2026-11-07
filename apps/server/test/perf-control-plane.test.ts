// 控制面指标负载与端到端延迟（pnpm perf 的 control-plane-metrics、end-to-end-latency 两项）里的纯逻辑。
import { describe, expect, it } from "vitest";
import { distribution, pushLatencies } from "../perf/latency.js";
import { planLoad, reconcilePoints } from "../perf/metric-load.js";
import { SseParser } from "../perf/sse.js";

describe("延迟分布（distribution）", () => {
	it("给出样本数、p50、p95、p99 与最大值（最近秩法：不小于 p% 样本的最小值）", () => {
		const samples = Array.from({ length: 100 }, (_, i) => 100 - i); // 100..1，乱序无关
		expect(distribution(samples)).toEqual({ count: 100, p50: 50, p95: 95, p99: 99, max: 100 });
	});

	it("样本很少时高分位取到最大值", () => {
		expect(distribution([30, 10, 20])).toEqual({ count: 3, p50: 20, p95: 30, p99: 30, max: 30 });
	});

	it("没有样本时为 null", () => {
		expect(distribution([])).toBeNull();
	});
});

describe("SSE 解析（SseParser）", () => {
	it("按空行切分消息，data 按 JSON 解析；跨块到达的消息等收齐再给出", () => {
		const parser = new SseParser();
		expect(parser.push('event: metrics\ndata: {"a":')).toEqual([]);
		expect(parser.push('1}\n\nid: 7\nevent: run\ndata: {"b":2}\n\n: 注释\n\nda')).toEqual([
			{ event: "metrics", data: { a: 1 } },
			{ event: "run", data: { b: 2 }, id: "7" },
		]);
		expect(parser.push("ta: [3]\n\n")).toEqual([{ event: "message", data: [3] }]);
	});

	it("多行 data 用换行拼接后再解析", () => {
		expect(new SseParser().push('data: {"x":\ndata: 5}\n\n')).toEqual([
			{ event: "message", data: { x: 5 } },
		]);
	});
});

describe("从 SSE 推送算端到端延迟（pushLatencies）", () => {
	// 节点每次上报 clock_ms = 调用时的 Date 毫秒数，Agent 按秒合并成 gauge：min 是这一秒第一次调用的时刻，
	// value（最新值）是最后一次。
	const point = (name: string, min: number, value: number) => ({
		name,
		time: new Date(Math.floor(min / 1000) * 1000).toISOString(),
		value,
		min,
		max: value,
	});

	it("每个点给出它的秒（Unix 秒）、这一秒第一次与最后一次调用到收到推送的时间，只看指定的指标", () => {
		const increment = {
			points: [point("clock_ms", 1000, 1990), point("other", 0, 5), point("clock_ms", 2000, 2999)],
		};
		expect(pushLatencies(increment, "clock_ms", 3200)).toEqual([
			{ second: 1, first: 2200, last: 1210 },
			{ second: 2, first: 1200, last: 201 },
		]);
	});
});

describe("指标负载的分配（planLoad）", () => {
	it("每个任务每秒上报 metricsPerTask 个点，任务数凑够目标速率，平均分给各个假 Agent", () => {
		expect(planLoad({ pointsPerSecond: 10_000, metricsPerTask: 10, agents: 10 })).toEqual({
			tasks: 1000,
			pointsPerSecond: 10_000,
			tasksPerAgent: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
		});
	});

	it("除不尽时任务数向上取整，多出来的任务给排在前面的 Agent", () => {
		expect(planLoad({ pointsPerSecond: 1000, metricsPerTask: 7, agents: 3 })).toEqual({
			tasks: 143,
			pointsPerSecond: 1001,
			tasksPerAgent: [48, 48, 47],
		});
	});
});

describe("核对写入的点数与上报的点数（reconcilePoints）", () => {
	it("按「任务 × 指标」比较：少写的算丢失，多写的算多余，不会互相抵消", () => {
		const sent = new Map([
			["t1/m0", 60],
			["t1/m1", 60],
			["t2/m0", 60],
		]);
		const stored = new Map([
			["t1/m0", 60],
			["t1/m1", 58],
			["t2/m0", 61],
			["t3/m0", 4],
		]);
		expect(reconcilePoints(sent, stored)).toEqual({ sent: 180, stored: 183, missing: 2, extra: 5 });
	});

	it("一个点都没写进去时全部丢失", () => {
		expect(reconcilePoints(new Map([["t1/m0", 10]]), new Map())).toEqual({
			sent: 10,
			stored: 0,
			missing: 10,
			extra: 0,
		});
	});
});
