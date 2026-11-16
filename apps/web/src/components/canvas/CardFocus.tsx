import type { RunFocusItem } from "@sfly/schema";
import { cn } from "cn";
import { EyeIcon } from "lucide-react";
import { AnomalyMark } from "#/focus/AnomalyNote";
import { anomalyText, readingLabel, valueText } from "#/focus/focus-format";
import type { FocusPreview } from "#/focus/focus-preview";
import { FOCUS } from "#/lib/copy";
import type { CardFocus } from "./context";
import { LOD_HIDDEN, ZOOM_TEXT_11, ZOOM_TEXT_12 } from "./zoom-text";

/**
 * 卡片可访问名称里的关注项：「2 个关注项，1 项需要注意：total 已 2m 10s 无新数据」，没有异常时只有个数。
 * 卡片上的三角旁边放不下原因，原因写在这里（用图表自己的标题，和卡片上一致）。`generatedAt` 是读数的生成时间。
 */
export function cardFocusLabel(items: readonly RunFocusItem[], generatedAt: string): string {
	const reasons = items.flatMap((item) => {
		const reason = anomalyText(item, generatedAt);
		return reason === null ? [] : [`${item.chart} ${reason}`];
	});
	const count = FOCUS.itemCount(items.length);
	return reasons.length === 0
		? count
		: `${count}，${FOCUS.attentionCount(reasons.length)}：${reasons.join("；")}`;
}

/**
 * 卡片左上角的眼睛图标和关注项数量（原型 `.pin`，和右上角的标签同一个样子）。读屏从卡片的名称里读到
 * {@link cardFocusLabel}：卡片用 `aria-labelledby` 引用带 `id` 的那段隐藏文字。
 */
export function FocusBadge({ id, focus }: { id: string; focus: CardFocus }) {
	return (
		<>
			<span
				aria-hidden
				data-testid="node-focus-count"
				className={cn(
					"absolute -top-2.5 left-2.5 flex h-4.75 items-center gap-1 rounded-sm border border-border bg-raised-2 px-1.5 font-mono leading-4.25 text-fg-2",
					ZOOM_TEXT_11,
					LOD_HIDDEN,
				)}
			>
				<EyeIcon className="size-[1em]" />
				{focus.count}
			</span>
			<span id={id} className="sr-only">
				{focus.label}
			</span>
		</>
	);
}

/**
 * 卡片底部的关注项（原型 `.frs`）：前两项各一行，有异常的在前、带琥珀三角，多出的写「还有 N 个关注项」。来源节点成功、
 * 已停止或已取消后控制面不再判断异常，只剩最终值。每行用图表自己的标题（「CPU」），不用场景起的名字：卡片已经说明了来源，
 * 名字也不容易被截断。悬停一行看完整的读数（名称、值、来源节点和状态、异常原因）；读屏从卡片的名称里读到个数和异常原因。
 */
export function FocusRows({
	preview,
	generatedAt,
}: {
	preview: FocusPreview<RunFocusItem>;
	generatedAt: string;
}) {
	return (
		<div
			aria-hidden
			data-testid="node-focus"
			className={cn("flex flex-col rounded-md bg-sunk px-2 py-0.5", ZOOM_TEXT_12, LOD_HIDDEN)}
		>
			{preview.shown.map((item) => (
				<div
					key={`${item.chart}\n${item.position}`}
					data-focus-row={item.chart}
					data-anomaly={item.anomaly?.kind}
					title={readingLabel(item, generatedAt)}
					className="flex h-5 min-w-0 items-center gap-1.5"
				>
					{item.anomaly && <AnomalyMark className="flex-none" />}
					<span className="min-w-0 truncate text-fg-2">{item.chart}</span>
					<span
						className={cn(
							"ml-auto flex-none font-mono",
							item.anomaly?.kind === "stale" ? "text-fg-2" : "text-fg-1",
						)}
					>
						{valueText(item)}
					</span>
					{item.unit && <span className="flex-none text-fg-3">{item.unit}</span>}
				</div>
			))}
			{preview.more > 0 && (
				<div className="flex h-5 items-center text-fg-3">{FOCUS.moreItems(preview.more)}</div>
			)}
		</div>
	);
}
