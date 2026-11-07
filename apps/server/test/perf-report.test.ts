// 性能测试（ARCHITECTURE §7.6）的纯逻辑：判定、与上一次结果的对比、报告生成。
// 负载测试本身（pnpm perf）不进 CI，这里只测不需要启动任何进程的部分。
import { describe, expect, it } from "vitest";
import { checkSequence } from "../perf/checks.js";
import {
	buildReport,
	type ItemOutcome,
	pickPrevious,
	type ReportInput,
	renderMarkdown,
} from "../perf/report.js";

const machine = {
	id: "m1",
	hostname: "box",
	cpus: 8,
	cpuModel: "Test CPU",
	memoryBytes: 8 * 1024 ** 3,
	os: "Linux 7.2",
};
const version = { sfly: "0.0.3", commit: "abc1234", dirty: false };

function input(items: ItemOutcome[], overrides: Partial<ReportInput> = {}): ReportInput {
	return {
		startedAt: "2026-11-07T10:00:00.000Z",
		finishedAt: "2026-11-07T10:05:00.000Z",
		machine,
		version,
		only: null,
		items,
		previous: null,
		...overrides,
	};
}

function item(measurements: ItemOutcome["measurements"], overrides: Partial<ItemOutcome> = {}) {
	return {
		id: "events",
		title: "单任务每秒 1 万次事件",
		scope: "单个任务 SDK → Agent",
		target: "持续每秒 1 万次事件不阻塞节点",
		durationMs: 1000,
		measurements,
		...overrides,
	};
}

describe("判定", () => {
	it("硬性断言不满足时该项不通过，失败说明指出是哪一项、哪个数值", () => {
		const report = buildReport(
			input([
				item([
					{
						id: "lost",
						label: "丢失的点",
						value: 37,
						unit: "个",
						check: { kind: "hard", op: "<=", value: 0 },
					},
					{
						id: "rate",
						label: "事件速率",
						value: 10_000,
						unit: "次/秒",
						check: { kind: "target", op: ">=", value: 10_000 },
					},
				]),
			]),
		);
		expect(report.ok).toBe(false);
		expect(report.items[0]?.status).toBe("fail");
		expect(report.failures).toEqual(["单任务每秒 1 万次事件：丢失的点 = 37 个（要求 ≤ 0）"]);
	});

	it("目标只在比目标差一半以上时提示，不让命令失败", () => {
		const target = (value: number, op: ">=" | "<=", limit: number) => ({
			id: `${op}${value}`,
			label: "x",
			value,
			unit: "",
			check: { kind: "target" as const, op, value: limit },
		});
		const report = buildReport(
			input([
				item([target(6_000, ">=", 10_000), target(5_000, ">=", 10_000)], { id: "a" }),
				item([target(4_999, ">=", 10_000)], { id: "b" }),
				item([target(1_000, "<=", 500)], { id: "c" }),
				item([target(1_001, "<=", 500)], { id: "d" }),
			]),
		);
		expect(report.items.map((i) => [i.id, i.status])).toEqual([
			["a", "pass"],
			["b", "warn"],
			["c", "pass"],
			["d", "warn"],
		]);
		expect(report.ok).toBe(true);
		expect(report.failures).toEqual([]);
	});

	it("运行出错的项不通过，失败说明带上错误信息", () => {
		const report = buildReport(input([item([], { error: "控制面没有启动" })]));
		expect(report.ok).toBe(false);
		expect(report.items[0]?.status).toBe("error");
		expect(report.failures).toEqual(["单任务每秒 1 万次事件：运行出错：控制面没有启动"]);
	});
});

describe("与上一次结果对比", () => {
	const m = (id: string, value: number, op?: ">=" | "<=") => ({
		id,
		label: id,
		value,
		unit: "MB",
		...(op ? { check: { kind: "target" as const, op, value: 1 } } : {}),
	});
	const previous = buildReport(
		input(
			[
				item([
					m("rate", 10_000, ">="),
					m("rss", 40, "<="),
					m("cpu", 50),
					m("lost", 0),
					m("gone", 1),
				]),
				item([m("x", 1)], { id: "removed" }),
			],
			{ startedAt: "2026-11-06T09:00:00.000Z" },
		),
	);

	it("标出变化超过 20% 的数值，并按判定方向区分变好还是变差", () => {
		const report = buildReport(
			input(
				[
					item([
						m("rate", 7_000, ">="),
						m("rss", 30, "<="),
						m("cpu", 55),
						m("lost", 0),
						m("new", 3),
					]),
				],
				{ previous: { dir: "out/perf/2026-11-06T09-00-00", report: previous } },
			),
		);
		expect(report.comparison).toEqual({
			dir: "out/perf/2026-11-06T09-00-00",
			startedAt: "2026-11-06T09:00:00.000Z",
		});
		expect(
			report.changes.map((c) => [c.item, c.measurement, c.previous, c.current, c.change, c.trend]),
		).toEqual([
			["events", "rate", 10_000, 7_000, -0.3, "worse"],
			["events", "rss", 40, 30, -0.25, "better"],
		]);
		// 每个数值都带上与上一次相比的变化（报告里逐项显示）；上一次没有的数值没有变化。
		const byId = Object.fromEntries(report.items[0]?.measurements.map((x) => [x.id, x]) ?? []);
		expect(byId.cpu?.change).toBeCloseTo(0.1);
		expect(byId.lost?.change).toBe(0);
		expect(byId.new?.previous).toBeUndefined();
	});

	it("从 0 变为非 0 算作变化超过 20%，没有判定方向的数值标为中性", () => {
		const report = buildReport(
			input([item([m("lost", 2)])], { previous: { dir: "p", report: previous } }),
		);
		expect(report.changes).toEqual([
			{
				item: "events",
				title: "单任务每秒 1 万次事件",
				measurement: "lost",
				label: "lost",
				unit: "MB",
				previous: 0,
				current: 2,
				change: Number.POSITIVE_INFINITY,
				trend: "neutral",
			},
		]);
	});

	it("变化的绝对值不超过数值声明的噪声时不标出（例如接近 0 的毫秒数）", () => {
		const noisy = (value: number) => ({ id: "behind", label: "落后", value, unit: "ms", noise: 5 });
		const before = buildReport(input([item([noisy(0.004), { ...m("rss", 40), noise: 5 }])]));
		const report = buildReport(
			input([item([noisy(3), { ...m("rss", 60), noise: 5 }])], {
				previous: { dir: "p", report: before },
			}),
		);
		expect(report.changes.map((c) => c.measurement)).toEqual(["rss"]);
		// 数值本身照常带上变化，只是不在「变化超过 20%」里标出。
		expect(report.items[0]?.measurements[0]?.previous).toBe(0.004);
	});

	it("没有上一次结果时不对比", () => {
		const report = buildReport(input([item([m("rate", 1)])]));
		expect(report.comparison).toBeNull();
		expect(report.changes).toEqual([]);
	});
});

describe("选出本机上一次的结果", () => {
	const at = (startedAt: string, machineId = "m1") =>
		buildReport(input([], { startedAt, machine: { ...machine, id: machineId } }));

	it("取同一台机器、早于本次开始时间的最近一次", () => {
		const candidates = [
			{ dir: "a", report: at("2026-11-05T10:00:00.000Z") },
			{ dir: "b", report: at("2026-11-06T10:00:00.000Z") },
			{ dir: "c", report: at("2026-11-06T12:00:00.000Z", "other") },
			{ dir: "d", report: at("2026-11-08T10:00:00.000Z") },
		];
		expect(pickPrevious(candidates, "m1", "2026-11-07T10:00:00.000Z")?.dir).toBe("b");
	});

	it("忽略结构不认识的报告；没有符合的结果时返回 null", () => {
		const unknown = { ...at("2026-11-06T10:00:00.000Z"), schema: 2 } as unknown;
		expect(
			pickPrevious([{ dir: "x", report: unknown }], "m1", "2026-11-07T10:00:00.000Z"),
		).toBeNull();
		expect(pickPrevious([], "m1", "2026-11-07T10:00:00.000Z")).toBeNull();
	});
});

describe("Markdown 报告", () => {
	const rss = (value: number) => ({
		id: "rss",
		label: "Agent 峰值内存",
		value,
		unit: "MB",
		check: { kind: "target" as const, op: "<=" as const, value: 100 },
	});
	const lost = (value: number) => ({
		id: "lost",
		label: "丢失的点",
		value,
		unit: "个",
		check: { kind: "hard" as const, op: "<=" as const, value: 0 },
	});

	it("列出机器、版本、结论、每项的数值与目标，并标出与上一次相比变化超过 20% 的项", () => {
		const previous = buildReport(
			input([item([rss(40), lost(0)])], { startedAt: "2026-11-06T09:00:00.000Z" }),
		);
		const md = renderMarkdown(
			buildReport(
				input([item([rss(60.123), lost(3)], { notes: ["速率按节点实际用时计算"] })], {
					previous: { dir: "out/perf/2026-11-06T09-00-00", report: previous },
					only: ["events"],
				}),
			),
		);
		const lines = md.split("\n");
		expect(lines[0]).toBe("# sfly 性能测试报告");
		expect(lines).toContain("- 开始：2026-11-07T10:00:00.000Z，用时 5 分 0 秒");
		expect(lines).toContain("- 版本：sfly 0.0.3（abc1234）");
		expect(lines).toContain("- 机器：box，Test CPU × 8，内存 8 GiB，Linux 7.2（标识 m1）");
		expect(lines).toContain("- 只运行：events");
		expect(lines).toContain(
			"- 对比：2026-11-06T09:00:00.000Z 的结果（out/perf/2026-11-06T09-00-00）",
		);
		expect(lines).toContain("- 结论：**不通过**");
		expect(lines).toContain("  - 单任务每秒 1 万次事件：丢失的点 = 3 个（要求 ≤ 0）");
		expect(lines).toContain(
			"| 单任务每秒 1 万次事件 | 单个任务 SDK → Agent | 持续每秒 1 万次事件不阻塞节点 | 不通过 |",
		);
		expect(lines).toContain("## 单任务每秒 1 万次事件（events）");
		expect(lines).toContain(
			"| Agent 峰值内存 | 60.12 MB | 目标 ≤ 100 | 通过 | 40 → 60.12（+50.3%） |",
		);
		expect(lines).toContain("| 丢失的点 | 3 个 | 硬性 ≤ 0 | 不通过 | 0 → 3（新出现） |");
		expect(lines).toContain("- 速率按节点实际用时计算");
		expect(lines).toContain("## 与上一次相比变化超过 20% 的数值");
		expect(lines).toContain(
			"- 单任务每秒 1 万次事件 / Agent 峰值内存：40 → 60.12 MB（+50.3%，变差）",
		);
	});

	it("随时间变化的数据原样写进 report.json，Markdown 里只列出名称与点数", () => {
		const series = [
			{
				id: "rss",
				label: "Agent 内存",
				unit: "MB",
				points: [
					[0, 30],
					[1000, 31.5],
				] as Array<[number, number]>,
			},
		];
		const report = buildReport(input([item([lost(0)], { series })]));
		expect(JSON.parse(JSON.stringify(report)).items[0].series).toEqual(series);
		expect(renderMarkdown(report).split("\n")).toContain(
			"- 随时间变化的数据：Agent 内存（MB，2 个点，见 report.json）",
		);
	});

	it("小于 1 的数值保留三位有效数字，不显示成 0", () => {
		const md = renderMarkdown(
			buildReport(input([item([{ id: "t", label: "耗时", value: 0.003456, unit: "ms" }])])),
		);
		expect(md).toContain("| 耗时 | 0.00346 ms | — | 记录 | — |");
	});

	it("通过且没有上一次结果时说明不对比", () => {
		const md = renderMarkdown(buildReport(input([item([lost(0)])])));
		expect(md).toContain("- 对比：本机没有更早的结果，不对比\n");
		expect(md).toContain("- 结论：**通过**\n");
		expect(md).not.toContain("## 与上一次相比变化超过 20% 的数值");
	});
});

describe("按序号核对指标点（定速指标节点：第 i 次上报 seq = i，按秒合并成 min / max / last）", () => {
	const b = (min: number, max: number, points = 1) => ({ min, max, last: max, points });

	it("每秒一个点、序号首尾相接时不丢不重", () => {
		expect(checkSequence([b(1, 10_000), b(10_001, 20_000)], 20_000)).toEqual({
			missing: 0,
			duplicated: 0,
			duplicatePoints: 0,
		});
	});

	it("相邻两秒之间、开头和结尾缺的序号算作丢失", () => {
		expect(checkSequence([b(3, 10_000), b(10_005, 19_990)], 20_000)).toEqual({
			missing: 2 + 4 + 10,
			duplicated: 0,
			duplicatePoints: 0,
		});
	});

	it("一个点都没有时全部算作丢失", () => {
		expect(checkSequence([], 100).missing).toBe(100);
	});

	it("相邻两秒的序号重叠算作重复；同一秒写入多个点算作重复的点", () => {
		expect(checkSequence([b(1, 10_000), b(9_995, 20_000, 2)], 20_000)).toEqual({
			missing: 0,
			duplicated: 6,
			duplicatePoints: 1,
		});
	});
});
