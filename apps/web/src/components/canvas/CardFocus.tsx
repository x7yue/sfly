import type { RunFocus, RunFocusItem } from "@sfly/schema";
import { cn } from "cn";
import { EyeIcon } from "lucide-react";
import { attentionSummary, focusItemTitle } from "#/focus/focus-format";
import { FOCUS } from "#/lib/copy";
import { untrustedPlain } from "#/lib/untrusted-text";
import type { CardFocus } from "./context";
import { LOD_HIDDEN, ZOOM_TEXT_11 } from "./zoom-text";

/**
 * 卡片可访问名称里的关注项：「2 个关注项，1 项需要注意：total 已 2m 10s 无新数据」，没有异常时只有个数；图表在节点包版本里
 * 不存在的项再接上「这个版本的节点没有图表 X」（卡片上这一行没有数值，原因也写在这里）。卡片上的三角旁边放不下原因，
 * 原因写在这里（用图表自己的标题，和卡片上一致）。场景没设关注项时（`primary`）是这个节点的主指标，不数个数：
 * 「1 项需要注意：主指标 level 重试（第 2 次尝试）· 10:41:02」，和 Agent 槽位格的写法一致。`generatedAt` 是读数的生成时间。
 */
export function cardFocusLabel(
	items: readonly RunFocusItem[],
	generatedAt: string,
	mode: RunFocus["mode"] = "focus",
): string {
	const attention = attentionSummary(items, generatedAt, (item) =>
		mode === "primary" ? focusItemTitle(item, mode) : item.chart,
	);
	// 图表标题来自节点包（别人写的）；名称是纯文字，先写出看不见的字符。
	const missing = items.flatMap((item) =>
		item.unavailable ? [FOCUS.chartMissing(untrustedPlain(item.chart))] : [],
	);
	return [
		...(mode === "primary" ? [] : [FOCUS.itemCount(items.length)]),
		...(attention === null ? [] : [attention]),
		...(missing.length === 0 ? [] : [missing.join("；")]),
	].join("，");
}

/**
 * 卡片上边线外左侧的眼睛图标和关注项数量（原型 `.pin`，和右侧的标签同一个样子；场景没设关注项、卡片上只有主指标时没有）。
 * 读屏从卡片的名称里读到 {@link cardFocusLabel}：卡片用 `aria-labelledby` 引用带 `id` 的那段隐藏文字。
 */
export function FocusBadge({ id, focus }: { id: string; focus: CardFocus }) {
	return (
		<>
			{focus.count !== undefined && (
				<span
					aria-hidden
					data-testid="node-focus-count"
					className={cn(
						// 和右上角的标签一样贴在卡片上边线外面，不压标题。
						"absolute bottom-[calc(100%-1px)] left-5 flex items-center gap-1 rounded-md border border-border-strong bg-raised-2 px-1.5 font-mono leading-[1.4] text-fg-2",
						ZOOM_TEXT_11,
						LOD_HIDDEN,
					)}
				>
					<EyeIcon className="size-[1em]" />
					{focus.count}
				</span>
			)}
			<span id={id} className="sr-only">
				{focus.label}
			</span>
		</>
	);
}
