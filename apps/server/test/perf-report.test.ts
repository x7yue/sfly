// 性能测试（ARCHITECTURE §7.6）的纯逻辑：判定、选对比基准（本机上一次、发版基线）、对比、发版报告的把关、报告生成。
// 负载测试本身（pnpm perf）不进 CI，这里只测不需要启动任何进程的部分。
import { describe, expect, it } from "vitest";
import {
	parseVersion,
	pickPrevious,
	pickReleaseBaseline,
	releaseBlockers,
} from "../perf/baseline.js";
import { checkSequence } from "../perf/checks.js";
import {
	type BaselineChoice,
	buildReport,
	type ItemOutcome,
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
		dir: "~/.local/share/sfly/perf/2026-11-07T10-00-00",
		baselines: { local: NO_LOCAL, release: NO_RELEASE },
		...overrides,
	};
}

const NO_LOCAL = { skipped: "本机没有更早的结果，不对比" };
const NO_RELEASE = { skipped: "仓库里没有不高于当前版本的发版报告（docs/perf/），不对比" };

/** 只给出本机上一次（发版基线不对比）。 */
const localOnly = (local: BaselineChoice) => ({ baselines: { local, release: NO_RELEASE } });

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

describe("与基准对比", () => {
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
				localOnly({ dir: "~/.local/share/sfly/perf/2026-11-06T09-00-00", report: previous }),
			),
		);
		const local = report.comparisons.local;
		if ("skipped" in local) throw new Error("应当对比");
		expect(local).toMatchObject({
			dir: "~/.local/share/sfly/perf/2026-11-06T09-00-00",
			startedAt: "2026-11-06T09:00:00.000Z",
			version: "0.0.3",
			commit: "abc1234",
		});
		expect(
			local.changes.map((c) => [c.item, c.measurement, c.previous, c.current, c.change, c.trend]),
		).toEqual([
			["events", "rate", 10_000, 7_000, -0.3, "worse"],
			["events", "rss", 40, 30, -0.25, "better"],
		]);
		// 每个数值都带上与基准相比的变化（报告里逐项显示）；基准里没有的数值没有变化。
		const byId = Object.fromEntries(report.items[0]?.measurements.map((x) => [x.id, x]) ?? []);
		expect(byId.cpu?.local?.change).toBeCloseTo(0.1);
		expect(byId.lost?.local).toEqual({ value: 0, change: 0 });
		expect(byId.new?.local).toBeUndefined();
		expect(byId.cpu?.release).toBeUndefined();
		expect(report.comparisons.release).toEqual(NO_RELEASE);
	});

	it("两份基准分别对比：各自的变化、各自标出超过 20% 的数值", () => {
		const release = buildReport(
			input([item([m("rate", 5_000, ">="), m("rss", 30, "<=")])], {
				startedAt: "2026-10-01T09:00:00.000Z",
				version: { sfly: "0.0.2", commit: "0f0f0f0", dirty: false },
			}),
		);
		const report = buildReport(
			input([item([m("rate", 7_000, ">="), m("rss", 30, "<=")])], {
				baselines: {
					local: { dir: "l", report: previous },
					release: { dir: "docs/perf/0.0.2", report: release },
				},
			}),
		);
		const rate = report.items[0]?.measurements[0];
		expect(rate?.local).toEqual({ value: 10_000, change: -0.3 });
		expect(rate?.release).toEqual({ value: 5_000, change: 0.4 });
		const changes = (kind: "local" | "release") => {
			const c = report.comparisons[kind];
			return "skipped" in c ? null : c.changes.map((x) => [x.measurement, x.trend]);
		};
		expect(changes("local")).toEqual([
			["rate", "worse"],
			["rss", "better"],
		]);
		expect(changes("release")).toEqual([["rate", "better"]]);
		expect(report.comparisons.release).toMatchObject({ dir: "docs/perf/0.0.2", version: "0.0.2" });
	});

	it("从 0 变为非 0 算作变化超过 20%，没有判定方向的数值标为中性", () => {
		const report = buildReport(
			input([item([m("lost", 2)])], localOnly({ dir: "p", report: previous })),
		);
		const local = report.comparisons.local;
		expect("skipped" in local ? null : local.changes).toEqual([
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
			input(
				[item([noisy(3), { ...m("rss", 60), noise: 5 }])],
				localOnly({ dir: "p", report: before }),
			),
		);
		const local = report.comparisons.local;
		expect("skipped" in local ? null : local.changes.map((c) => c.measurement)).toEqual(["rss"]);
		// 数值本身照常带上变化，只是不在「变化超过 20%」里标出。
		expect(report.items[0]?.measurements[0]?.local?.value).toBe(0.004);
	});

	it("不对比时报告里只有原因", () => {
		const report = buildReport(input([item([m("rate", 1)])]));
		expect(report.comparisons).toEqual({ local: NO_LOCAL, release: NO_RELEASE });
		expect(report.items[0]?.measurements[0]?.local).toBeUndefined();
	});
});

describe("选出本机上一次的结果", () => {
	const at = (startedAt: string, machineId = "m1") =>
		buildReport(input([], { startedAt, machine: { ...machine, id: machineId } }));
	const dirOf = (choice: BaselineChoice) => ("skipped" in choice ? choice.skipped : choice.dir);

	it("取同一台机器、早于本次开始时间的最近一次（结果目录各 worktree 共用，与在哪个 worktree 里跑的无关）", () => {
		const candidates = [
			{ dir: "a", report: at("2026-11-05T10:00:00.000Z") },
			{ dir: "b", report: at("2026-11-06T10:00:00.000Z") },
			{ dir: "c", report: at("2026-11-06T12:00:00.000Z", "other") },
			{ dir: "d", report: at("2026-11-08T10:00:00.000Z") },
		];
		expect(dirOf(pickPrevious(candidates, "m1", "2026-11-07T10:00:00.000Z"))).toBe("b");
	});

	it("被中断的结果不作为对比的基准（时长不同，数值没有可比性）", () => {
		const interrupted = buildReport(
			input([], { startedAt: "2026-11-06T12:00:00.000Z", interrupted: true }),
		);
		const candidates = [
			{ dir: "a", report: at("2026-11-06T10:00:00.000Z") },
			{ dir: "b", report: interrupted },
		];
		expect(dirOf(pickPrevious(candidates, "m1", "2026-11-07T10:00:00.000Z"))).toBe("a");
	});

	it("旧结构（schema 1）的报告仍可作为基准：选基准只用到两种结构共有的字段", () => {
		const old = { ...at("2026-11-06T10:00:00.000Z"), schema: 1 } as unknown;
		expect(dirOf(pickPrevious([{ dir: "x", report: old }], "m1", "2026-11-07T10:00:00.000Z"))).toBe(
			"x",
		);
	});

	it("忽略结构不认识的报告；没有符合的结果时说明不对比", () => {
		const unknown = { ...at("2026-11-06T10:00:00.000Z"), schema: 99 } as unknown;
		expect(pickPrevious([{ dir: "x", report: unknown }], "m1", "2026-11-07T10:00:00.000Z")).toEqual(
			NO_LOCAL,
		);
		expect(pickPrevious([], "m1", "2026-11-07T10:00:00.000Z")).toEqual(NO_LOCAL);
	});
});

describe("选出发版基线（docs/perf/<版本>/ 里最近一个版本的报告）", () => {
	const released = (sfly: string, machineId = "m1", overrides: Partial<ReportInput> = {}) =>
		buildReport(
			input([], {
				version: { sfly, commit: "c0ffee0", dirty: false },
				machine: { ...machine, id: machineId, hostname: machineId === "m1" ? "box" : "ci-box" },
				...overrides,
			}),
		);
	const candidate = (version: string, report: unknown = released(version)) => ({
		version,
		dir: `docs/perf/${version}`,
		report,
	});
	const current = { version: "0.1.0", machineId: "m1", release: false };
	const pick = (candidates: ReturnType<typeof candidate>[], over: Partial<typeof current> = {}) =>
		pickReleaseBaseline(candidates, { ...current, ...over });
	const dirOf = (choice: BaselineChoice) => ("skipped" in choice ? choice.skipped : choice.dir);

	it("按版本号（不是字符串）取不高于当前版本的最大者；目录名不是 X.Y.Z 的忽略", () => {
		const candidates = [
			candidate("0.0.9"),
			candidate("0.0.10"),
			candidate("0.2.0"),
			candidate("latest"),
		];
		expect(dirOf(pick(candidates))).toBe("docs/perf/0.0.10");
		// 当前版本自己的发版报告（发版之后的普通 PR）就是基线。
		expect(dirOf(pick([...candidates, candidate("0.1.0")]))).toBe("docs/perf/0.1.0");
	});

	it("发版运行（--release）不与当前版本自己的报告对比：它正要被这次的结果替换", () => {
		const candidates = [candidate("0.0.10"), candidate("0.1.0")];
		expect(dirOf(pick(candidates, { release: true }))).toBe("docs/perf/0.0.10");
		expect(pick([candidate("0.1.0")], { release: true })).toEqual({
			skipped: "仓库里没有更早版本的发版报告（docs/perf/），不对比",
		});
	});

	it("最近一个版本不是同一台机器跑的就不对比，也不往更早的版本找，并说明是哪台机器", () => {
		const candidates = [candidate("0.0.9"), candidate("0.0.10", released("0.0.10", "m2"))];
		expect(pick(candidates)).toEqual({
			skipped:
				"最近一个版本 sfly 0.0.10 的发版报告（docs/perf/0.0.10）是另一台机器跑的（ci-box，标识 m2），数值没有可比性，不对比",
		});
	});

	it("结构不认识或被中断的发版报告不对比；没有发版报告时说明", () => {
		expect(pick([candidate("0.0.9", { schema: 99 })])).toEqual({
			skipped: "sfly 0.0.9 的发版报告（docs/perf/0.0.9）结构不认识，不对比",
		});
		expect(pick([candidate("0.0.9", released("0.0.9", "m1", { interrupted: true }))])).toEqual({
			skipped: "sfly 0.0.9 的发版报告（docs/perf/0.0.9）被中断过，不对比",
		});
		expect(pick([])).toEqual({
			skipped: "仓库里没有不高于当前版本的发版报告（docs/perf/），不对比",
		});
		expect(pick([candidate("0.0.9")], { version: "dev" })).toEqual({
			skipped: "当前版本号 dev 不是 X.Y.Z，不对比",
		});
	});

	it("parseVersion 只认 X.Y.Z", () => {
		expect(parseVersion("0.0.10")).toEqual([0, 0, 10]);
		for (const text of ["v0.0.1", "0.1", "0.1.0-rc.1", "README.md"]) {
			expect(parseVersion(text), text).toBeNull();
		}
	});
});

describe("发版报告的把关（releaseBlockers）", () => {
	const lost = (value: number) => ({
		id: "lost",
		label: "丢失的点",
		value,
		unit: "个",
		check: { kind: "hard" as const, op: "<=" as const, value: 0 },
	});

	it("完整运行、通过、没有未提交的改动时可以存为发版报告", () => {
		expect(releaseBlockers(buildReport(input([item([lost(0)])])))).toEqual([]);
	});

	it("有未提交的改动、被中断、不通过、只运行了部分项时都不存，并说明原因", () => {
		const dirty = { sfly: "0.0.3", commit: "abc1234", dirty: true };
		expect(releaseBlockers(buildReport(input([item([lost(0)])], { version: dirty })))).toEqual([
			"有未提交的改动：先提交，报告要对应一个确定的提交",
		]);
		expect(releaseBlockers(buildReport(input([item([lost(0)])], { interrupted: true })))).toEqual([
			"运行被中断",
		]);
		expect(releaseBlockers(buildReport(input([item([lost(3)])])))).toEqual(["结论不通过"]);
		expect(releaseBlockers(buildReport(input([item([lost(0)])], { only: ["events"] })))).toEqual([
			"只运行了部分项（events）：发版报告要完整运行一次",
		]);
	});

	it("读不到提交号或版本号不是 X.Y.Z 时不存", () => {
		const version = { sfly: "dev", commit: "unknown", dirty: false };
		expect(releaseBlockers(buildReport(input([item([lost(0)])], { version })))).toEqual([
			"读不到当前提交号",
			"版本号 dev 不是 X.Y.Z",
		]);
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

	it("列出机器、版本、结果目录、两份基准、结论、每项的数值与目标，并分别标出与两份基准相比变化超过 20% 的项", () => {
		const previous = buildReport(
			input([item([rss(40), lost(0)])], { startedAt: "2026-11-06T09:00:00.000Z" }),
		);
		const released = buildReport(
			input([item([rss(60), lost(0)])], {
				startedAt: "2026-10-01T09:00:00.000Z",
				version: { sfly: "0.0.2", commit: "0f0f0f0", dirty: false },
			}),
		);
		const md = renderMarkdown(
			buildReport(
				input([item([rss(60.123), lost(3)], { notes: ["速率按节点实际用时计算"] })], {
					baselines: {
						local: { dir: "~/.local/share/sfly/perf/2026-11-06T09-00-00", report: previous },
						release: { dir: "docs/perf/0.0.2", report: released },
					},
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
		expect(lines).toContain("- 结果目录：~/.local/share/sfly/perf/2026-11-07T10-00-00");
		expect(lines).toContain(
			"- 本机上一次：2026-11-06T09:00:00.000Z 的结果（~/.local/share/sfly/perf/2026-11-06T09-00-00），变化超过 20% 的数值 2 个",
		);
		expect(lines).toContain(
			"- 发版基线：sfly 0.0.2 的发版报告（docs/perf/0.0.2，2026-10-01T09:00:00.000Z），变化超过 20% 的数值 1 个",
		);
		expect(lines).toContain("- 结论：**不通过**");
		expect(lines).toContain("  - 单任务每秒 1 万次事件：丢失的点 = 3 个（要求 ≤ 0）");
		expect(lines).toContain(
			"| 单任务每秒 1 万次事件 | 单个任务 SDK → Agent | 持续每秒 1 万次事件不阻塞节点 | 不通过 |",
		);
		expect(lines).toContain("## 单任务每秒 1 万次事件（events）");
		expect(lines).toContain("| 数值 | 结果 | 要求 | 结论 | 与本机上一次相比 | 与发版基线相比 |");
		expect(lines).toContain(
			"| Agent 峰值内存 | 60.12 MB | 目标 ≤ 100 | 通过 | 40 → 60.12（+50.3%） | 60 → 60.12（+0.2%） |",
		);
		expect(lines).toContain(
			"| 丢失的点 | 3 个 | 硬性 ≤ 0 | 不通过 | 0 → 3（新出现） | 0 → 3（新出现） |",
		);
		expect(lines).toContain("- 速率按节点实际用时计算");
		expect(lines).toContain("## 与本机上一次相比变化超过 20% 的数值");
		expect(lines).toContain(
			"- 单任务每秒 1 万次事件 / Agent 峰值内存：40 → 60.12 MB（+50.3%，变差）",
		);
		expect(lines).toContain("## 与发版基线（sfly 0.0.2）相比变化超过 20% 的数值");
		expect(lines).toContain("- 单任务每秒 1 万次事件 / 丢失的点：0 → 3 个（新出现，变差）");
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

	it("被中断时结论是被中断（不算通过），已采集的数值照常列出", () => {
		const report = buildReport(input([item([lost(0)])], { interrupted: true }));
		expect(report.interrupted).toBe(true);
		expect(report.ok).toBe(false);
		const lines = renderMarkdown(report).split("\n");
		expect(lines).toContain("- 结论：**被中断**：已采集的数据照常写进报告，没有运行完的检查不算数");
		expect(lines).toContain("| 丢失的点 | 0 个 | 硬性 ≤ 0 | 通过 | — | — |");
	});

	it("通过且两份基准都不对比时写明原因", () => {
		const md = renderMarkdown(buildReport(input([item([lost(0)])])));
		expect(md).toContain("- 本机上一次：本机没有更早的结果，不对比\n");
		expect(md).toContain("- 发版基线：仓库里没有不高于当前版本的发版报告（docs/perf/），不对比\n");
		expect(md).toContain("- 结论：**通过**\n");
		expect(md).not.toContain("变化超过 20% 的数值\n");
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
