import {
	focusLatestSeriesName,
	focusValueText,
	type RunFocus,
	type RunFocusItem,
} from "@sfly/schema";
import { runNodeName } from "#/components/node-name";
import {
	FINAL_VALUE_LABEL,
	FOCUS,
	focusSourceStatus,
	LOG_LEVEL_LABEL,
	MESSAGE,
	noDataLabel,
	TERM,
} from "#/lib/copy";
import { formatClock, formatElapsed } from "#/lib/format";

/**
 * 一次运行没有可显示的读数时写什么：没设关注项时，有执行中（含准备中）的节点是它们都没声明主指标，否则是没有执行中的
 * 节点；设了关注项是它们所在的节点都不在这次运行的版本里。概览和控制台的运行块共用。
 */
export const emptyReadingsNote = (mode: RunFocus["mode"], executing: boolean): string =>
	mode === "primary"
		? executing
			? MESSAGE.noPrimaryMetric
			: MESSAGE.noRunningNodes
		: FOCUS.noneInRun;

/**
 * 一项在紧凑处（Agent 槽位格、画布卡片可访问名称里的主指标）的名称：主指标前面写明是主指标（关注项的名称是作者起的
 * 或图表标题，没有这个问题）。
 */
export const focusItemTitle = (
	item: Pick<RunFocusItem, "title">,
	mode: RunFocus["mode"],
): string => (mode === "primary" ? `${TERM.primaryMetric} ${item.title}` : item.title);

/** 来源节点：「显示名称（节点 ID）」，没有显示名称时只写节点 ID（docs/SEMANTICS.md §1.4）。 */
export const sourceNodeName = (item: Pick<RunFocusItem, "node_id" | "display_name">): string =>
	runNodeName(item);

/**
 * 一项读数处于哪种状态：脚注、可访问名称和图表的空状态都由它决定写什么，别处不再自己判断「还没开始」「没有数据」。
 * 没有值时写原因（`noDataLabel`）：来源节点还没有开始执行（`source.started_at` 为 null，有哪些状态见契约 `RunFocusItem`）
 * 写这个状态没有执行的原因，已经开始还没有点写「还没有数据」，尝试已经结束仍没有点写「这次尝试没有上报数据」；
 * 有值时，来源节点成功、已停止或已取消是最终值，否则是多久前。
 *
 * 下面几个函数的 `runEnded` 是这次运行已经结束：一直待执行的节点不会再执行，写「这次运行没有执行」「未执行」。
 */
export type ReadingState =
	| { kind: "empty"; text: string }
	| { kind: "live"; ageMs: number }
	| { kind: "final" };

/** `generatedAt` 是这份读数的生成时间（控制面时间）：「多久前」按它算，不随浏览器时钟跳动。 */
export function readingState(
	item: Pick<RunFocusItem, "source" | "latest" | "final">,
	generatedAt: string,
	runEnded = false,
): ReadingState {
	const { source, latest } = item;
	if (source.started_at === null || latest === null) {
		return { kind: "empty", text: noDataLabel(source, source.status, runEnded) };
	}
	return item.final
		? { kind: "final" }
		: { kind: "live", ageMs: Date.parse(generatedAt) - Date.parse(latest.at) };
}

/** 读数的最后一段：多久前、最终值，没有值时是原因（{@link readingState}）。 */
export function readingWhen(item: RunFocusItem, generatedAt: string, runEnded = false): string {
	const state = readingState(item, generatedAt, runEnded);
	switch (state.kind) {
		case "empty":
			return state.text;
		case "final":
			return FINAL_VALUE_LABEL;
		case "live":
			return `${formatElapsed(state.ageMs)} 前`;
	}
}

/**
 * 异常原因的短句（异常由控制面判断，这里只管写法）：「1 条 WARN · 10:58:41」「3 条 WARN / ERROR · 10:58:41」（这次尝试的 WARN / ERROR 条数，只有一条时写它的级别，时间是最近一条的）、
 * 「已 2m 10s 无新数据」（从最后一个点算起，一个点都没有时从开始执行算起）、「来源节点失败」、
 * 「重试（第 2 次尝试）· 10:41:02」（这次尝试开始的时间）；没有异常为 null。读数的脚注、图表卡片、可访问名称共用，
 * 「多久」按读数的 `generatedAt`（控制面时间）算。
 */
export function anomalyText(
	item: Pick<RunFocusItem, "anomaly" | "source">,
	generatedAt: string,
): string | null {
	const { anomaly } = item;
	if (anomaly === null) return null;
	switch (anomaly.kind) {
		case "log":
			return FOCUS.logReason(
				anomaly.count ?? 1,
				LOG_LEVEL_LABEL[anomaly.level ?? "warn"],
				formatClock(anomaly.at),
			);
		case "stale":
			return staleFor(anomaly.at, generatedAt);
		case "failed":
			return FOCUS.sourceFailed;
		case "retry":
			return FOCUS.retryReason(item.source.attempt, formatClock(anomaly.at));
	}
}

const staleFor = (since: string, generatedAt: string) =>
	FOCUS.staleFor(formatElapsed(Date.parse(generatedAt) - Date.parse(since)));

/**
 * 「已 2m 10s 无新数据」：从控制面给的 `stale_since` 算起，还有新数据时为 null。和这一项报哪一种异常无关（例如先有 WARN
 * 再不上报，异常报的是 WARN），图表的斜线旁写它。
 */
export const staleText = (
	item: Pick<RunFocusItem, "stale_since">,
	generatedAt: string,
): string | null => (item.stale_since === null ? null : staleFor(item.stale_since, generatedAt));

/** 读数的脚注：来源节点和 {@link readingWhen}；图表在节点包版本里不存在时没有值可说，只写来源节点。 */
export function readingFoot(item: RunFocusItem, generatedAt: string, runEnded = false): string {
	const node = sourceNodeName(item);
	return item.unavailable ? node : `${node} · ${readingWhen(item, generatedAt, runEnded)}`;
}

/** 最新值连同序列名和单位的一行文字：「p99_ms 21.4 ms」「16」；读数的可访问名称和「需要注意」用它。 */
export function readingValue(item: Pick<RunFocusItem, "latest" | "metrics" | "unit">): string {
	const series = focusLatestSeriesName(item);
	return `${series ? `${series} ` : ""}${focusValueText(item)}${item.unit ? ` ${item.unit}` : ""}`;
}

/**
 * 读数的可访问名称：名称、最新值、来源节点和状态，最后是异常原因（「需要注意：已 2m 10s 无新数据」），没有异常时是
 * {@link readingWhen}，例如「母单量 1284814 单，来自 load（执行中），2s 前」。
 */
export function readingLabel(item: RunFocusItem, generatedAt: string, runEnded = false): string {
	const status = focusSourceStatus(item.source.status, runEnded);
	const origin = `来自 ${sourceNodeName(item)}（${status}）`;
	const reason = anomalyText(item, generatedAt);
	const attention = reason === null ? "" : `，${FOCUS.attention}：${reason}`;
	if (item.unavailable) {
		return `${item.title}，${FOCUS.chartMissing(item.chart)}，${origin}${attention}`;
	}
	return `${item.title} ${readingValue(item)}，${origin}${attention || `，${readingWhen(item, generatedAt, runEnded)}`}`;
}
