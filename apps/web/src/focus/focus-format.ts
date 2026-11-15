import { focusValueText, latestSeriesName, type RunFocusItem } from "@sfly/schema";
import { runNodeName } from "#/components/node-name";
import { nodeStatusView } from "#/components/status";
import { FINAL_VALUE_LABEL, FOCUS, noDataLabel } from "#/lib/copy";
import { formatDuration } from "#/lib/format";

/** 距离某一刻多久：`2s`、`2m 10s`、`1h 02m`（秒取整；一分钟以内不写小数）。 */
export function formatAgo(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : formatDuration(seconds * 1000);
}

/** 来源节点：「显示名称（节点 ID）」，没有显示名称时只写节点 ID（docs/SEMANTICS.md §1.4）。 */
export const sourceNodeName = (item: Pick<RunFocusItem, "node_id" | "display_name">): string =>
	runNodeName(item);

/**
 * 一项读数处于哪种状态：脚注、可访问名称和图表的空状态都由它决定写什么，别处不再自己判断「还没开始」「没有数据」。
 * 没有值时写原因（`noDataLabel`）：来源节点还没有开始执行（`source.started_at` 为 null，有哪些状态见契约 `RunFocusItem`）
 * 写这个状态没有执行的原因，已经开始还没有点写「还没有数据」，尝试已经结束仍没有点写「这次尝试没有上报数据」；
 * 有值时，来源节点成功或已停止是最终值，否则是多久前。
 */
export type ReadingState =
	| { kind: "empty"; text: string }
	| { kind: "live"; ageMs: number }
	| { kind: "final" };

/** `generatedAt` 是这份读数的生成时间（控制面时间）：「多久前」按它算，不随浏览器时钟跳动。 */
export function readingState(
	item: Pick<RunFocusItem, "source" | "latest" | "final">,
	generatedAt: string,
): ReadingState {
	const { source, latest } = item;
	if (source.started_at === null || latest === null) {
		return { kind: "empty", text: noDataLabel(source, source.status) };
	}
	return item.final
		? { kind: "final" }
		: { kind: "live", ageMs: Date.parse(generatedAt) - Date.parse(latest.at) };
}

/** 读数的最后一段：多久前、最终值，没有值时是原因（{@link readingState}）。 */
function readingWhen(item: RunFocusItem, generatedAt: string): string {
	const state = readingState(item, generatedAt);
	switch (state.kind) {
		case "empty":
			return state.text;
		case "final":
			return FINAL_VALUE_LABEL;
		case "live":
			return `${formatAgo(state.ageMs)} 前`;
	}
}

/** 读数的脚注：来源节点和 {@link readingWhen}；图表在节点包版本里不存在时没有值可说，只写来源节点。 */
export function readingFoot(item: RunFocusItem, generatedAt: string): string {
	const node = sourceNodeName(item);
	return item.unavailable ? node : `${node} · ${readingWhen(item, generatedAt)}`;
}

/**
 * 读数的可访问名称：名称、最新值、来源节点和状态、{@link readingWhen}，例如
 * 「母单量 1284814 单，来自 load（执行中），2s 前」。
 */
export function readingLabel(item: RunFocusItem, generatedAt: string): string {
	const status = nodeStatusView(item.source.status).label;
	const origin = `来自 ${sourceNodeName(item)}（${status}）`;
	if (item.unavailable) return `${item.title}，${FOCUS.chartMissing(item.chart)}，${origin}`;
	const series = latestSeriesName(item);
	const value = `${series ? `${series} ` : ""}${focusValueText(item)}${item.unit ? ` ${item.unit}` : ""}`;
	return `${item.title} ${value}，${origin}，${readingWhen(item, generatedAt)}`;
}
