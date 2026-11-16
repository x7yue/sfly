import { errorHeadline, type FocusAnomaly, isOnAgentStatus, type NodeStatus } from "@sfly/schema";
import type { TaskLogIssues } from "../db/schema.js";
import { LOG_ISSUE_TEXT_CHARS } from "../logs/task-logs.js";
import { clipChars } from "../util/text.js";

/**
 * 关注项的异常（规格 #344，契约见 @sfly/schema 的 `FocusAnomalyKind`）：判断只在这里做，经 `resolveRunFocus` 写进
 * `GET /runs/:id/focus` 的每一项，页面只显示这份结果，不自己判断。时间都是控制面时间（ADR 0018），平台不为数值设阈值。
 */

/** 「最近」的窗口：这么久以内的 WARN / ERROR、开始的重试算异常。 */
export const ANOMALY_WINDOW_MS = 10 * 60_000;
/** 无新数据的下限：距离最后一个点至少这么久才算。 */
export const STALE_FLOOR_MS = 30_000;
/** 无新数据：超过采样间隔的这么多倍（且不少于 {@link STALE_FLOOR_MS}）。 */
export const STALE_INTERVALS = 6;
/** 估算采样间隔用最近多少个点。 */
export const SAMPLE_POINTS = 10;

/** 判断一项要用到的：来源节点的状态和它最新一次尝试，以及这一项的序列最后一个点的时间和采样间隔。 */
export interface AnomalySubject {
	status: NodeStatus;
	/** 最新一次尝试；节点还没有尝试时为 undefined。 */
	attempt:
		| {
				attempt: number;
				queuedAt: Date;
				startedAt: Date | null;
				endedAt: Date | null;
				errorMessage: string | null;
				logIssues: TaskLogIssues | null;
		  }
		| undefined;
	/** 上一次尝试的错误信息（重试的原因）；没有上一次尝试或它没有错误信息时为 null。 */
	previousError: string | null;
	/** 图表在这次运行的节点包版本里不存在：没有数据可等，不判断无新数据。 */
	chartMissing: boolean;
	/** 最后一个点的控制面时间（毫秒）；一个点都没有为 null。 */
	lastAt: number | null;
	sampleIntervalMs: number | null;
}

type Rule = (subject: AnomalySubject, now: number) => FocusAnomaly | null;

const within = (at: number, now: number) => now - at <= ANOMALY_WINDOW_MS;
/** 错误信息的第一行（{@link errorHeadline}），和日志正文一样截到 500 个字符。 */
const headline = (message: string | null) =>
	clipChars(errorHeadline(message), LOG_ISSUE_TEXT_CHARS);

/** 来源节点失败：不限时间。 */
const failed: Rule = ({ status, attempt }, now) => {
	if (status !== "failed") return null;
	const at = attempt?.endedAt ?? attempt?.startedAt ?? attempt?.queuedAt ?? new Date(now);
	return { kind: "failed", at: at.toISOString(), message: headline(attempt?.errorMessage ?? null) };
};

/** 来源任务最近一条 WARN / ERROR 在窗口以内。 */
const log: Rule = ({ attempt }, now) => {
	const issues = attempt?.logIssues;
	if (!issues || !within(Date.parse(issues.at), now)) return null;
	return {
		kind: "log",
		level: issues.level,
		at: issues.at,
		message: issues.text,
		count: issues.count,
	};
};

/** 最新一次尝试是重试（号大于 1），在窗口以内开始；还没开始执行时按进入排队的时间。 */
const retry: Rule = ({ attempt, previousError }, now) => {
	if (!attempt || attempt.attempt <= 1) return null;
	const at = (attempt.startedAt ?? attempt.queuedAt).getTime();
	if (!within(at, now)) return null;
	return { kind: "retry", at: new Date(at).toISOString(), message: headline(previousError) };
};

/**
 * 从何时起没有新数据（契约里每一项的 `stale_since`）：来源节点在执行中（准备中、执行中，与主指标的口径相同），距离最后一个点
 * 超过 max(30 秒, 6 倍采样间隔) 时，是最后一个点的时间；一个点都没有时从这次尝试开始执行算起，还没开始执行（准备中）、
 * 图表在节点包版本里不存在时不判断。和这一项报哪一种异常无关：图表画斜线、写「已 2m 10s 无新数据」看它。
 */
export function staleSince(subject: AnomalySubject, now: Date): Date | null {
	const { status, attempt, chartMissing, lastAt, sampleIntervalMs } = subject;
	if (chartMissing || !isOnAgentStatus(status)) return null;
	const since = lastAt ?? attempt?.startedAt?.getTime();
	if (since === undefined) return null;
	const limit = Math.max(STALE_FLOOR_MS, STALE_INTERVALS * (sampleIntervalMs ?? 0));
	return now.getTime() - since > limit ? new Date(since) : null;
}

/** 没有新数据（{@link staleSince}）。 */
const stale: Rule = (subject, now) => {
	const since = staleSince(subject, new Date(now));
	return since ? { kind: "stale", at: since.toISOString(), message: "" } : null;
};

/** 同时满足几种时只报排在前面的一种。 */
const RULES: readonly Rule[] = [failed, log, retry, stale];

/** 一项的异常；来源节点成功、已停止或已取消（只显示最终值）时不判断，为 null。 */
export function focusAnomaly(subject: AnomalySubject, now: Date): FocusAnomaly | null {
	if (isFinalStatus(subject.status)) return null;
	for (const rule of RULES) {
		const anomaly = rule(subject, now.getTime());
		if (anomaly) return anomaly;
	}
	return null;
}

/** 来源节点成功、已停止或已取消：只显示最终值，不判断异常。 */
export const isFinalStatus = (status: NodeStatus) =>
	status === "success" || status === "stopped" || status === "cancelled";

/**
 * 采样间隔（毫秒）：最近 {@link SAMPLE_POINTS} 个点（`times`：Unix 秒，升序）之间间隔的中位数；点不够两个时为 null。
 * 点的时间按秒取整、同一序列一秒最多一个点，间隔至少 1 秒；下限按 1 秒算，不会得到 0。
 */
export function sampleIntervalMs(times: readonly number[]): number | null {
	const recent = times.slice(-SAMPLE_POINTS);
	if (recent.length < 2) return null;
	const gaps = recent
		.slice(1)
		.map((t, i) => t - (recent[i] as number))
		.sort((a, b) => a - b);
	const mid = gaps.length >> 1;
	const median =
		gaps.length % 2 === 1
			? (gaps[mid] as number)
			: ((gaps[mid - 1] as number) + (gaps[mid] as number)) / 2;
	return Math.max(1000, Math.round(median * 1000));
}
