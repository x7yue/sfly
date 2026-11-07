// 性能测试报告（ARCHITECTURE §7.6）：判定每个数值、与本机上一次结果对比、生成 report.json 与 report.md。
// 这里只有纯逻辑（单测见 test/perf-report.test.ts），运行负载、读写文件在 main.ts。
//
// 判定规则：
// - 硬性断言（资源上限、数据正确）：不满足即该项不通过，`pnpm perf` 以非零退出码结束；
// - 目标（吞吐、延迟、CPU）：只记录并比较，比目标差一半以上（≥ 型低于目标的一半、≤ 型超过目标的两倍）才提示；
// - 没有判定条件的数值只记录。

/** 数值的判定条件。 */
export interface Check {
	kind: "hard" | "target";
	op: ">=" | "<=";
	value: number;
}

/** 一项负载或基准测试测得的一个数值。 */
export interface Measurement {
	/** 项内唯一、稳定的标识（ASCII），用于与上一次结果对比；改名等于新数值。 */
	id: string;
	/** 报告里显示的名称。 */
	label: string;
	value: number;
	unit: string;
	check?: Check;
	/** 正常的波动幅度（与 value 同单位）：与上一次相比变化的绝对值不超过它时，即使超过 20% 也不标出。 */
	noise?: number;
}

/** 随时间变化的数据（例如内存曲线），原样写进 report.json，不参与判定与对比。 */
export interface Series {
	id: string;
	label: string;
	unit: string;
	/** [相对这一项开始的毫秒数, 值]。 */
	points: Array<[number, number]>;
}

/** 一项运行完的结果（判定之前）。 */
export interface ItemOutcome {
	id: string;
	title: string;
	/** ARCHITECTURE §7.6 目标表里的「范围」；基准测试等没有目标的项为 null。 */
	scope: string | null;
	/** 从 ARCHITECTURE §7.6 读出的目标原文。 */
	target: string | null;
	durationMs: number;
	measurements: Measurement[];
	/** 运行出错（没有测完）时的错误信息；出错按不通过处理。 */
	error?: string;
	/** 附加说明（写进报告）。 */
	notes?: string[];
	series?: Series[];
}

export type MeasurementVerdict = "pass" | "warn" | "fail" | "info";
export type ItemStatus = "pass" | "warn" | "fail" | "error";

export interface MachineInfo {
	/** 机器标识（对比只找同一台机器的结果）。 */
	id: string;
	hostname: string;
	cpus: number;
	cpuModel: string;
	memoryBytes: number;
	os: string;
}

export interface VersionInfo {
	sfly: string;
	commit: string;
	dirty: boolean;
}

export interface ReportInput {
	startedAt: string;
	finishedAt: string;
	machine: MachineInfo;
	version: VersionInfo;
	/** 只运行了这些项；null 表示全部。 */
	only: string[] | null;
	items: ItemOutcome[];
	/** 本机上一次的结果（pickPrevious 选出）；null 表示不对比。 */
	previous: { dir: string; report: PerfReport } | null;
	/** 运行被中断（Ctrl-C）：已采集的数据照常写进报告，但结论不算通过。 */
	interrupted?: boolean;
}

export interface MeasurementResult extends Measurement {
	verdict: MeasurementVerdict;
	/** 上一次结果里同一项同一数值的值；上一次没有时不设置。 */
	previous?: number;
	/** 相对上一次的变化比例（(本次 - 上次) / |上次|）；上次为 0 而本次不为 0 时为 ±Infinity。 */
	change?: number;
}

export interface ItemResult extends ItemOutcome {
	status: ItemStatus;
	measurements: MeasurementResult[];
}

/** 变化超过 {@link CHANGE_THRESHOLD} 的数值。 */
export interface Change {
	item: string;
	title: string;
	measurement: string;
	label: string;
	unit: string;
	previous: number;
	current: number;
	change: number;
	/** 按判定条件的方向（≥ 越大越好，≤ 越小越好）；没有判定条件时为 neutral。 */
	trend: "better" | "worse" | "neutral";
}

/** 与上一次相比，变化比例超过它就在报告里标出。 */
export const CHANGE_THRESHOLD = 0.2;

/** report.json 的结构；改动不兼容时增加 schema。 */
export interface PerfReport {
	schema: 1;
	startedAt: string;
	finishedAt: string;
	machine: MachineInfo;
	version: VersionInfo;
	only: string[] | null;
	/** 运行被中断（Ctrl-C）；被中断的结果不算通过，也不作为下一次对比的基准。 */
	interrupted: boolean;
	ok: boolean;
	/** 不通过的说明，每条指出是哪一项、哪个数值。 */
	failures: string[];
	items: ItemResult[];
	/** 对比的上一次结果；null 表示本机没有更早的结果。 */
	comparison: { dir: string; startedAt: string } | null;
	/** 变化超过 20% 的数值，按项、数值的顺序。 */
	changes: Change[];
}

const satisfies = (value: number, op: Check["op"], limit: number) =>
	op === ">=" ? value >= limit : value <= limit;

export function judgeMeasurement(m: Measurement): MeasurementVerdict {
	if (!m.check) return "info";
	const { kind, op, value } = m.check;
	if (kind === "hard") return satisfies(m.value, op, value) ? "pass" : "fail";
	return satisfies(m.value, op, op === ">=" ? value / 2 : value * 2) ? "pass" : "warn";
}

function judgeItem(item: ItemOutcome): ItemResult {
	const measurements = item.measurements.map((m) => ({ ...m, verdict: judgeMeasurement(m) }));
	const verdicts = new Set(measurements.map((m) => m.verdict));
	const status: ItemStatus = item.error
		? "error"
		: verdicts.has("fail")
			? "fail"
			: verdicts.has("warn")
				? "warn"
				: "pass";
	return { ...item, status, measurements };
}

/** 数值的显示：整数原样；绝对值不小于 1 的小数最多两位，小于 1 的保留三位有效数字。 */
export function formatNumber(value: number): string {
	if (!Number.isFinite(value) || Number.isInteger(value)) return String(value);
	return String(Number(Math.abs(value) < 1 ? value.toPrecision(3) : value.toFixed(2)));
}

const withUnit = (value: number, unit: string) => `${formatNumber(value)}${unit ? ` ${unit}` : ""}`;
const opText = (op: Check["op"]) => (op === ">=" ? "≥" : "≤");

function failuresOf(item: ItemResult): string[] {
	if (item.status === "error") return [`${item.title}：运行出错：${item.error?.split("\n")[0]}`];
	return item.measurements
		.filter((m) => m.verdict === "fail")
		.map(
			(m) =>
				`${item.title}：${m.label} = ${withUnit(m.value, m.unit)}（要求 ${opText(m.check?.op ?? "<=")} ${formatNumber(m.check?.value ?? 0)}）`,
		);
}

function changeRatio(previous: number, current: number): number {
	if (previous === current) return 0;
	if (previous === 0) return current > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
	return (current - previous) / Math.abs(previous);
}

function trendOf(m: Measurement, change: number): Change["trend"] {
	if (!m.check) return "neutral";
	return change > 0 === (m.check.op === ">=") ? "better" : "worse";
}

/** 给每个数值附上与上一次的变化，返回变化超过阈值的数值。 */
function compare(items: ItemResult[], previous: PerfReport): Change[] {
	const before = new Map(
		previous.items.flatMap((i) => i.measurements.map((m) => [`${i.id}\0${m.id}`, m.value])),
	);
	const changes: Change[] = [];
	for (const item of items) {
		for (const m of item.measurements) {
			const prev = before.get(`${item.id}\0${m.id}`);
			if (prev === undefined) continue;
			m.previous = prev;
			m.change = changeRatio(prev, m.value);
			if (Math.abs(m.change) <= CHANGE_THRESHOLD) continue;
			if (m.noise !== undefined && Math.abs(m.value - prev) <= m.noise) continue;
			changes.push({
				item: item.id,
				title: item.title,
				measurement: m.id,
				label: m.label,
				unit: m.unit,
				previous: prev,
				current: m.value,
				change: m.change,
				trend: trendOf(m, m.change),
			});
		}
	}
	return changes;
}

export function buildReport(input: ReportInput): PerfReport {
	const items = input.items.map(judgeItem);
	const failures = items.flatMap(failuresOf);
	const changes = input.previous ? compare(items, input.previous.report) : [];
	const interrupted = input.interrupted ?? false;
	return {
		schema: 1,
		startedAt: input.startedAt,
		finishedAt: input.finishedAt,
		machine: input.machine,
		version: input.version,
		only: input.only,
		interrupted,
		ok: failures.length === 0 && !interrupted,
		failures,
		items,
		comparison: input.previous
			? { dir: input.previous.dir, startedAt: input.previous.report.startedAt }
			: null,
		changes,
	};
}

/**
 * 从 out/perf 下已有的结果里选出要对比的上一次：同一台机器、早于本次开始时间、没有被中断的最近一次。
 * `report` 是读出的 report.json（未校验），结构不认识（schema 不同）的跳过。
 */
export function pickPrevious(
	candidates: Array<{ dir: string; report: unknown }>,
	machineId: string,
	startedAt: string,
): { dir: string; report: PerfReport } | null {
	let best: { dir: string; report: PerfReport } | null = null;
	for (const { dir, report } of candidates) {
		if (!isReport(report) || report.machine.id !== machineId || report.interrupted) continue;
		if (report.startedAt >= startedAt) continue;
		if (!best || report.startedAt > best.report.startedAt) best = { dir, report };
	}
	return best;
}

function isReport(value: unknown): value is PerfReport {
	const r = value as Partial<PerfReport> | null;
	return (
		typeof r === "object" &&
		r !== null &&
		r.schema === 1 &&
		typeof r.startedAt === "string" &&
		typeof r.machine?.id === "string" &&
		Array.isArray(r.items)
	);
}

const STATUS_TEXT: Record<ItemStatus, string> = {
	pass: "通过",
	warn: "通过（有提示）",
	fail: "不通过",
	error: "出错",
};
const VERDICT_TEXT: Record<MeasurementVerdict, string> = {
	pass: "通过",
	warn: "提示：比目标差一半以上",
	fail: "不通过",
	info: "记录",
};

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function formatChange(change: number): string {
	if (!Number.isFinite(change)) return "新出现";
	if (change === 0) return "不变";
	const percent = Number((change * 100).toFixed(1));
	return `${percent > 0 ? "+" : ""}${percent}%`;
}

function requirement(check: Check | undefined): string {
	if (!check) return "—";
	return `${check.kind === "hard" ? "硬性" : "目标"} ${opText(check.op)} ${formatNumber(check.value)}`;
}

/** 表格单元格里的文本：竖线与换行会破坏表格。 */
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(report: PerfReport): string {
	const { machine, version } = report;
	const out: string[] = ["# sfly 性能测试报告", ""];
	const duration = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
	out.push(`- 开始：${report.startedAt}，用时 ${formatDuration(duration)}`);
	out.push(
		`- 版本：sfly ${version.sfly}（${version.commit}${version.dirty ? "，有未提交的改动" : ""}）`,
	);
	out.push(
		`- 机器：${machine.hostname}，${machine.cpuModel} × ${machine.cpus}，内存 ${formatNumber(machine.memoryBytes / 1024 ** 3)} GiB，${machine.os}（标识 ${machine.id}）`,
	);
	if (report.only) out.push(`- 只运行：${report.only.join(", ")}`);
	out.push(
		report.comparison
			? `- 对比：${report.comparison.startedAt} 的结果（${report.comparison.dir}）`
			: "- 对比：本机没有更早的结果，不对比",
	);
	out.push(
		report.interrupted
			? "- 结论：**被中断**：已采集的数据照常写进报告，没有运行完的检查不算数"
			: `- 结论：**${report.ok ? "通过" : "不通过"}**`,
	);
	for (const failure of report.failures) out.push(`  - ${failure}`);

	out.push(
		"",
		"## 总览",
		"",
		"| 项 | 范围 | 目标（ARCHITECTURE §7.6） | 结论 |",
		"|---|---|---|---|",
	);
	for (const item of report.items) {
		out.push(
			`| ${cell(item.title)} | ${cell(item.scope ?? "—")} | ${cell(item.target ?? "—")} | ${STATUS_TEXT[item.status]} |`,
		);
	}

	for (const item of report.items) {
		out.push("", `## ${item.title}（${item.id}）`, "");
		if (item.target) out.push(`目标：${item.target}`, "");
		out.push(`结论：${STATUS_TEXT[item.status]}，用时 ${formatDuration(item.durationMs)}`, "");
		if (item.error) out.push("运行出错：", "", "```", item.error, "```", "");
		if (item.measurements.length > 0) {
			out.push("| 数值 | 结果 | 要求 | 结论 | 与上次相比 |", "|---|---|---|---|---|");
			for (const m of item.measurements) {
				const vs =
					m.previous === undefined || m.change === undefined
						? "—"
						: `${formatNumber(m.previous)} → ${formatNumber(m.value)}（${formatChange(m.change)}）`;
				out.push(
					`| ${cell(m.label)} | ${withUnit(m.value, m.unit)} | ${requirement(m.check)} | ${VERDICT_TEXT[m.verdict]} | ${vs} |`,
				);
			}
			out.push("");
		}
		for (const note of item.notes ?? []) out.push(`- ${note}`);
		for (const s of item.series ?? []) {
			out.push(
				`- 随时间变化的数据：${s.label}（${s.unit}，${s.points.length} 个点，见 report.json）`,
			);
		}
	}

	if (report.changes.length > 0) {
		out.push("", "## 与上一次相比变化超过 20% 的数值", "");
		const trend = { better: "变好", worse: "变差", neutral: "无判定方向" };
		for (const c of report.changes) {
			out.push(
				`- ${c.title} / ${c.label}：${formatNumber(c.previous)} → ${withUnit(c.current, c.unit)}（${formatChange(c.change)}，${trend[c.trend]}）`,
			);
		}
	}
	return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}
