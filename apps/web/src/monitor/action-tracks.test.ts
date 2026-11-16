import type {
	ActionDetailView,
	ActionNameCount,
	ActionRecordDetail,
	ActionSummaryView,
	CountOnlyPeriod,
	EndedActionView,
	RunningActionView,
} from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	layoutTracks,
	prepareTracks,
	rareNames,
	type TrackLayout,
	type TrackSource,
} from "./action-tracks";

const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
const at = (ms: number) => new Date(T0 + ms).toISOString();

function action(
	id: number,
	start: number,
	{
		name = "下单",
		depth = 1,
		took = 1,
		result = "success",
	}: {
		name?: string;
		depth?: number;
		took?: number | null;
		result?: ActionRecordDetail["result"];
	} = {},
): ActionRecordDetail {
	const ended = took === null ? null : at(start + took);
	return {
		kind: "action",
		id,
		parent: depth === 0 ? null : 1,
		depth,
		name,
		fields: {},
		started_at: at(start),
		agent_started_at: at(start),
		result: took === null ? null : result,
		ended_at: ended,
		agent_ended_at: ended,
		duration_ms: took,
		reason: result === "failed" ? "拒单" : null,
	};
}

const mark = (id: number, start: number, name = "收到第一笔成交"): ActionDetailView => ({
	kind: "mark",
	id,
	parent: 1,
	depth: 1,
	name,
	fields: {},
	started_at: at(start),
	agent_started_at: at(start),
});

const running = (id: number, start: number, name: string, depth: number): RunningActionView => ({
	id,
	parent: depth === 0 ? null : 1,
	depth,
	name,
	fields: {},
	started_at: at(start),
	agent_started_at: at(start),
});

const ended = (
	id: number,
	start: number,
	took: number,
	result: EndedActionView["result"] = "success",
): EndedActionView => ({
	...running(id, start, "下单", 1),
	ended_at: at(start + took),
	agent_ended_at: at(start + took),
	duration_ms: took,
	result,
	reason: result === "failed" ? "超时" : null,
});

const count = (
	name: string,
	total: number,
	{
		failed = 0,
		reported = total,
		cappedAt,
	}: { failed?: number; reported?: number; cappedAt?: number } = {},
): ActionNameCount => ({
	name,
	total,
	failed,
	reported,
	capped_at: cappedAt === undefined ? null : at(cappedAt),
	agent_capped_at: cappedAt === undefined ? null : at(cappedAt),
});

function summary(parts: Partial<ActionSummaryView> = {}): ActionSummaryView {
	return {
		total: 0,
		marks: 0,
		reported: 0,
		capped: false,
		capped_at: null,
		agent_capped_at: null,
		names: [],
		running: [],
		running_complete: true,
		recent: [],
		recent_failed: [],
		...parts,
	};
}

function source(parts: Partial<TrackSource> = {}): TrackSource {
	return {
		taskId: "t1",
		summary: summary(),
		details: [],
		loadedFrom: null,
		controlPlanePeriods: [],
		startedAt: T0,
		endedAt: null,
		...parts,
	};
}

/** 1000px 宽的轨道，看 [from, to]（相对 T0 的毫秒）。 */
const view = (from: number, to: number, now = to, width = 1000) => ({
	range: { start: T0 + from, end: T0 + to },
	now: T0 + now,
	width,
});

/** 「保持 4 小时」（最外层，进行中）里每 3ms 一个「下单」：400 个，从第 10ms 起。 */
const ORDERS = Array.from({ length: 400 }, (_, i) => action(i + 3, 10 + i * 3));
const HOLD = running(1, 0, "保持 4 小时", 0);

const layoutOf = (s: TrackSource[], v: ReturnType<typeof view>) =>
	layoutTracks(prepareTracks(s), v);
const dense = (l: TrackLayout) => l.band.reduce((n, r) => n + (r.to - r.from), 0);

describe("rareNames：少见的名称", () => {
	it("个数不到最常见那种的 1%、并且不超过 50 个才算少见", () => {
		const names = [
			count("下单", 1_284_814),
			count("重连撮合网关", 1),
			count("撤单", 9_000),
			count("预热", 1),
			count("对账", 60),
		];
		// 撤单不到 1%，但有 9000 个：不是少见的；对账 60 个，超过 50 个。
		expect([...rareNames(names)]).toEqual(["重连撮合网关", "预热"]);
	});

	it("最常见的那种自己不算少见；名称都不多时没有少见的", () => {
		expect(rareNames([count("下单", 1)]).size).toBe(0);
		expect(rareNames([count("下单", 30), count("重连撮合网关", 1)]).size).toBe(0);
	});
});

describe("全程看时：太密的画成密度带", () => {
	const s = source({
		summary: summary({
			total: 402,
			marks: 1,
			reported: 402,
			names: [count("保持 4 小时", 1), count("收到第一笔成交", 1), count("下单", 400)],
			running: [HOLD],
		}),
		details: [...ORDERS, mark(2, 5)],
	});

	it("子动作分不开的地方是一段密度带，不一个个画；最外层够宽的动作画成一条，进行中的画到现在", () => {
		// 20 秒画在 1000px 上：400 个「下单」挤在 1.2 秒（60px）里。
		const tracks = layoutOf([s], view(0, 20_000, 5_000));
		expect(tracks.child.ticks).toEqual([]);
		expect(tracks.child.band.length).toBeGreaterThan(0);
		expect(tracks.child.band[0]?.from).toBeCloseTo(0, 2);
		expect(dense(tracks.child)).toBeCloseTo(1.2 / 20, 2);
		expect(tracks.top.bars).toMatchObject([{ state: "running", from: 0, to: 0.25 }]);
	});

	it("密度带按每 2 个像素里有几个分三档", () => {
		const tracks = layoutOf([s], view(0, 20_000, 5_000));
		// 2px 是 40ms，每 3ms 一个：每格 13 个左右，是中间一档；最后一格只剩 3 个。
		expect(tracks.child.band.map((r) => r.level)).toEqual([2, 1]);
		const sparse = layoutOf([s], view(0, 4_000, 5_000));
		// 2px 是 8ms：每格两三个，是最淡的一档。
		expect(new Set(sparse.child.band.map((r) => r.level))).toEqual(new Set([1]));
	});

	it("少见名称的标记在密度带上画成小旗", () => {
		const tracks = layoutOf([s], view(0, 20_000, 5_000));
		expect(tracks.child.flags.map((f) => f.item.name)).toEqual(["收到第一笔成交"]);
	});
});

describe("放大以后：能分开的一个个画出来，窗口外的不画", () => {
	const s = source({
		summary: summary({
			total: 401,
			reported: 401,
			names: [count("保持 4 小时", 1), count("下单", 400)],
			running: [HOLD],
		}),
		details: ORDERS,
	});

	it("放大到 1 秒，每 3ms 一个的「下单」一个个画出来，没有密度带", () => {
		const tracks = layoutOf([s], view(200, 1_200, 5_000));
		expect(tracks.child.band).toEqual([]);
		// 第 200ms 到 1200ms 开始的：ID 67 到 400。
		const ids = tracks.child.ticks.map((t) => t.item.key);
		expect(ids).toHaveLength(334);
		expect(ids[0]).toBe("t1:66");
		expect(ids.at(-1)).toBe("t1:399");
		expect(tracks.child.ticks.every((t) => t.tone === "plain" && !t.marker)).toBe(true);
	});

	it("跨过窗口边缘的裁到窗口里，完全在窗口外的不画", () => {
		const long = action(500, 100, { name: "等待回报", depth: 1, took: 3_000 });
		const tracks = layoutOf(
			[source({ ...s, details: [...ORDERS, long] })],
			view(2_000, 3_000, 5_000),
		);
		expect(tracks.child.bars).toMatchObject([{ from: 0, to: 1, state: "ended" }]);
		expect(tracks.child.ticks).toEqual([]);
		// 最外层进行中的「保持 4 小时」从窗口外开始，画在窗口左端到右端。
		expect(tracks.top.bars).toMatchObject([{ from: 0, to: 1, state: "running" }]);
		const before = layoutOf([s], view(-10_000, -1_000, 5_000));
		expect(before.child).toEqual({ bars: [], ticks: [], flags: [], band: [], countOnly: [] });
	});
});

describe("只计数的一段", () => {
	it("从这个名称只计数的时刻画到任务结束（还在执行时到现在），在这个名称所在的轨道上", () => {
		const s = source({
			summary: summary({
				total: 1_200,
				reported: 400,
				capped: true,
				names: [count("下单", 1_200, { reported: 400, cappedAt: 1_500 })],
			}),
			details: ORDERS,
		});
		const live = layoutOf([s], view(0, 10_000, 5_000));
		expect(live.child.countOnly).toEqual([{ from: 0.15, to: 0.5 }]);
		expect(live.top.countOnly).toEqual([]);
		const done = layoutOf([{ ...s, endedAt: at(8_000) }], view(0, 10_000, 9_000));
		expect(done.child.countOnly).toEqual([{ from: 0.15, to: 0.8 }]);
	});

	it("控制面兜底的段也画；同一名称的两段合成一段", () => {
		const cp: CountOnlyPeriod = {
			name: "下单",
			reason: "control_plane",
			from: at(1_000),
			agent_from: at(1_000),
			to: null,
			count: 40,
		};
		const s = source({
			summary: summary({
				total: 1_200,
				reported: 400,
				capped: true,
				names: [count("下单", 1_200, { reported: 400, cappedAt: 1_500 })],
			}),
			details: ORDERS,
			controlPlanePeriods: [cp],
		});
		expect(layoutOf([s], view(0, 10_000, 5_000)).child.countOnly).toEqual([{ from: 0.1, to: 0.5 }]);
	});

	it("只计数以后失败、少见的动作仍有明细，画成短线", () => {
		const s = source({
			summary: summary({
				total: 1_202,
				reported: 403,
				capped: true,
				names: [
					count("下单", 1_200, { failed: 2, reported: 402, cappedAt: 1_500 }),
					count("重连撮合网关", 1),
				],
			}),
			details: [
				...ORDERS,
				action(1100, 3_000, { result: "failed" }),
				action(1150, 4_000, { result: "failed", took: 30 }),
				action(1171, 3_500, { name: "重连撮合网关", took: 300 }),
			],
		});
		const tracks = layoutOf([s], view(0, 20_000, 5_000));
		expect(tracks.child.ticks.map((t) => [t.item.key, t.tone])).toEqual([
			["t1:1100", "failed"],
			["t1:1171", "rare"],
			["t1:1150", "failed"],
		]);
	});
});

describe("失败的、少见的在密度带上突出", () => {
	it("密度带里失败的画红色短线、少见的画白色短线，每 2 个像素各一条", () => {
		const s = source({
			summary: summary({
				total: 404,
				reported: 404,
				names: [count("下单", 402, { failed: 2 }), count("重连撮合网关", 2)],
			}),
			details: [
				...ORDERS,
				action(900, 100.5, { result: "failed" }),
				action(901, 100.6, { result: "failed" }),
				action(902, 400, { name: "重连撮合网关" }),
				action(903, 400.2, { name: "重连撮合网关" }),
			],
		});
		const tracks = layoutOf([s], view(0, 20_000, 5_000));
		expect(tracks.child.ticks.map((t) => [t.item.key, t.tone, t.marker])).toEqual([
			["t1:900", "failed", true],
			["t1:902", "rare", true],
		]);
	});

	it("够长的少见子动作一条条画出来，开头标白色短线；最外层少见的动作不单独突出", () => {
		const s = source({
			summary: summary({
				total: 403,
				reported: 403,
				names: [count("预热", 1), count("下单", 400), count("重连撮合网关", 1), count("连接", 1)],
			}),
			details: [
				...ORDERS,
				action(900, 0, { name: "预热", depth: 0, took: 2_000 }),
				action(901, 3_000, { name: "重连撮合网关", took: 1_000 }),
				action(902, 6_000, { name: "连接", depth: 0, took: 1 }),
			],
		});
		const tracks = layoutOf([s], view(0, 10_000));
		expect(tracks.child.bars.map((b) => b.item.key)).toEqual(["t1:901"]);
		expect(tracks.child.ticks).toMatchObject([{ from: 0.3, tone: "rare", marker: true }]);
		expect(tracks.top.bars.map((b) => b.item.key)).toEqual(["t1:900"]);
		expect(tracks.top.ticks).toMatchObject([{ tone: "plain", marker: false }]);
	});

	it("最外层失败的动作画成满高的红色，单独的短动作画成短线", () => {
		const s = source({
			summary: summary({ total: 2, reported: 2, names: [count("连接撮合网关", 2, { failed: 1 })] }),
			details: [
				action(1, 0, { name: "连接撮合网关", depth: 0, took: 4_000, result: "failed" }),
				action(2, 9_000, { name: "连接撮合网关", depth: 0, took: 2 }),
			],
		});
		const tracks = layoutOf([s], view(0, 10_000));
		expect(tracks.top.bars).toMatchObject([{ state: "failed", from: 0, to: 0.4 }]);
		expect(tracks.top.ticks).toMatchObject([{ tone: "plain", marker: false }]);
	});
});

describe("合并明细和摘要", () => {
	it("同一个 ID 只画一次，已结束的为准；任务结束时还在做的画到任务结束", () => {
		const s = source({
			summary: summary({
				total: 3,
				reported: 3,
				names: [count("保持 4 小时", 1), count("下单", 2)],
				running: [HOLD, running(7, 2_000, "下单", 1)],
				recent: [ended(6, 1_000, 3_000)],
			}),
			// 最新一页读得早：6 那时还在做。
			details: [action(6, 1_000, { took: null }), action(7, 2_000, { took: null })],
		});
		const tracks = layoutOf([s], view(0, 10_000, 5_000));
		expect(tracks.child.bars.map((b) => [b.item.key, b.state, b.to])).toEqual([
			["t1:6", "ended", 0.4],
			["t1:7", "running", 0.5],
		]);
		const done = layoutOf([{ ...s, endedAt: at(6_000) }], view(0, 10_000, 9_000));
		expect(done.child.bars.map((b) => [b.item.key, b.state, b.to])).toEqual([
			["t1:6", "ended", 0.4],
			["t1:7", "ended", 0.6],
		]);
	});

	it("每次尝试分开去重：两次尝试的同一个 ID 各画各的", () => {
		const first = source({
			summary: summary({ total: 1, reported: 1, names: [count("预热", 1)] }),
			details: [action(1, 0, { name: "预热", depth: 0, took: 2_000 })],
		});
		const second = source({
			taskId: "t2",
			summary: summary({ total: 1, reported: 1, names: [count("预热", 1)] }),
			details: [action(1, 5_000, { name: "预热", depth: 0, took: 2_000 })],
			startedAt: T0 + 5_000,
		});
		const tracks = layoutOf([first, second], view(0, 10_000));
		expect(tracks.top.bars.map((b) => [b.item.key, b.from])).toEqual([
			["t1:1", 0],
			["t2:1", 0.5],
		]);
	});
});

describe("最新一页不是全部明细时", () => {
	it("没读到的明细按个数平均画在尝试开始到最早读到的那条之间，只计数以后的不算", () => {
		// 「下单」有明细的 5 万个，只读到最后 400 个（第 1000ms 到 1399ms 开始的）；第 1.5 秒起只计数。
		const s = source({
			summary: summary({
				total: 60_000,
				reported: 50_000,
				capped: true,
				names: [count("下单", 60_000, { reported: 50_000, cappedAt: 1_500 })],
			}),
			details: Array.from({ length: 400 }, (_, i) => action(i + 3, 1_000 + i)),
			loadedFrom: T0 + 1_000,
			startedAt: T0 - 9_000,
		});
		const tracks = layoutOf([s], view(-10_000, 10_000, 5_000));
		// 带从尝试开始（-9s，第 0.05 处）连到读到的那段（1.0–1.4s），之后是只计数的斜线。
		expect(tracks.child.band[0]?.from).toBeCloseTo(0.05, 2);
		expect(tracks.child.band.at(-1)?.to).toBeCloseTo(0.57, 2);
		expect(dense(tracks.child)).toBeCloseTo(0.52, 2);
		expect(tracks.child.countOnly).toEqual([{ from: 0.575, to: 0.75 }]);
	});
});

describe("10 万条明细", () => {
	it("整理和排版的耗时和条数成正比，画出来的元素只和像素宽度有关", () => {
		const details = Array.from({ length: 100_000 }, (_, i) =>
			i % 1000 === 0 ? action(i + 2, i * 5, { result: "failed" }) : action(i + 2, i * 5),
		);
		const s = source({
			summary: summary({
				total: 100_001,
				reported: 100_001,
				names: [count("保持 4 小时", 1), count("下单", 100_000, { failed: 100 })],
				running: [HOLD],
			}),
			details,
		});
		const t0 = performance.now();
		const prepared = prepareTracks([s]);
		const t1 = performance.now();
		const full = layoutTracks(prepared, view(0, 600_000));
		const t2 = performance.now();
		const zoomed = layoutTracks(prepared, view(250_000, 251_000));
		const t3 = performance.now();
		console.info(
			`10 万条：整理 ${(t1 - t0).toFixed(1)}ms，全程排版 ${(t2 - t1).toFixed(1)}ms，放大排版 ${(t3 - t2).toFixed(1)}ms`,
		);
		// 全程：画出来的元素只和像素宽度有关（1000px 是 500 格），和明细的条数无关。
		const elements = (l: TrackLayout) =>
			l.bars.length + l.ticks.length + l.flags.length + l.band.length + l.countOnly.length;
		expect(elements(full.child)).toBeLessThanOrEqual(500 * 2);
		expect(full.child.ticks.filter((t) => t.tone === "failed")).toHaveLength(100);
		// 第 250 秒到 251 秒开始的 201 个一个个画出来。
		expect(zoomed.child.ticks).toHaveLength(201);
		// 上限只用来拦住随条数平方增长的写法（10 万条时要几秒），留足垃圾回收和 CI 的余量。
		expect(t1 - t0).toBeLessThan(2_000);
		expect(t2 - t1).toBeLessThan(500);
		expect(t3 - t2).toBeLessThan(500);
	});
});
