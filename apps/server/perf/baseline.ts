// 性能测试报告的两份对比基准与发版报告的把关（ARCHITECTURE §7.6）。纯逻辑，单测见 test/perf-baseline.test.ts。
//
// - 本机上一次：本机结果目录（默认 ~/.local/share/sfly/perf，所有 worktree 共用）里同一台机器的最近一次；
// - 发版基线：仓库里 docs/perf/<版本>/ 下最近一个版本的发版报告；不是同一台机器跑的就不对比。
import type { BaselineChoice, PerfReport } from "./report.js";
import { isReport } from "./report.js";

/**
 * 从本机结果目录里已有的结果中选出要对比的上一次：同一台机器、早于本次开始时间、没有被中断的最近一次。
 * `report` 是读出的 report.json（未校验），结构不认识的跳过。
 */
export function pickPrevious(
	candidates: Array<{ dir: string; report: unknown }>,
	machineId: string,
	startedAt: string,
): BaselineChoice {
	let best: { dir: string; report: PerfReport } | null = null;
	for (const { dir, report } of candidates) {
		if (!isReport(report) || report.machine.id !== machineId || report.interrupted) continue;
		if (report.startedAt >= startedAt) continue;
		if (!best || report.startedAt > best.report.startedAt) best = { dir, report };
	}
	return best ?? { skipped: "本机没有更早的结果，不对比" };
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** 解析 `X.Y.Z`（ADR 0010 只支持这种版本号）；不是时返回 null。 */
export function parseVersion(text: string): [number, number, number] | null {
	const m = VERSION.exec(text);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** docs/perf/<版本>/ 下的一份发版报告：`report` 是读出的 JSON（未校验）。 */
export interface ReleaseCandidate {
	version: string;
	dir: string;
	report: unknown;
}

/**
 * 选出发版基线：版本号不高于当前版本的最近一个版本的报告（发版运行时不含当前版本本身，它正要被这次的报告替换）。
 * 只看最近的那一个版本：它不是同一台机器跑的、被中断了或结构不认识时不对比（不往更早的版本找），并说明原因。
 * 目录名不是 `X.Y.Z` 的忽略。
 */
export function pickReleaseBaseline(
	candidates: ReleaseCandidate[],
	current: { version: string; machineId: string; release: boolean },
): BaselineChoice {
	const now = parseVersion(current.version);
	if (!now) return { skipped: `当前版本号 ${current.version} 不是 X.Y.Z，不对比` };
	let best: { candidate: ReleaseCandidate; version: [number, number, number] } | null = null;
	for (const candidate of candidates) {
		const version = parseVersion(candidate.version);
		if (!version) continue;
		const order = compareVersions(version, now);
		if (order > 0 || (order === 0 && current.release)) continue;
		if (!best || compareVersions(version, best.version) > 0) best = { candidate, version };
	}
	if (!best) {
		return {
			skipped: `仓库里没有${current.release ? "更早" : "不高于当前"}版本的发版报告（docs/perf/），不对比`,
		};
	}
	const { dir, report, version } = best.candidate;
	if (!isReport(report))
		return { skipped: `sfly ${version} 的发版报告（${dir}）结构不认识，不对比` };
	if (report.interrupted)
		return { skipped: `sfly ${version} 的发版报告（${dir}）被中断过，不对比` };
	if (report.machine.id !== current.machineId) {
		return {
			skipped: `最近一个版本 sfly ${version} 的发版报告（${dir}）是另一台机器跑的（${report.machine.hostname}，标识 ${report.machine.id}），数值没有可比性，不对比`,
		};
	}
	return { dir, report };
}

/**
 * 这份报告能不能存为发版报告（docs/perf/<版本>/）；返回不能的原因，空数组表示可以。
 * 发版报告是之后各版本的对比基准，所以只收完整运行、运行完、通过、在没有未提交改动的提交上测的结果。
 */
export function releaseBlockers(report: PerfReport): string[] {
	const blockers: string[] = [];
	if (report.only)
		blockers.push(`只运行了部分项（${report.only.join(", ")}）：发版报告要完整运行一次`);
	if (report.interrupted) blockers.push("运行被中断");
	else if (!report.ok) blockers.push("结论不通过");
	if (report.version.dirty) blockers.push("有未提交的改动：先提交，报告要对应一个确定的提交");
	if (report.version.commit === "unknown") blockers.push("读不到当前提交号");
	if (!parseVersion(report.version.sfly)) {
		blockers.push(`版本号 ${report.version.sfly} 不是 X.Y.Z`);
	}
	return blockers;
}
