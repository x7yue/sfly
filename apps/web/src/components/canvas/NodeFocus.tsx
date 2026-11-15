import type { RunFocusItem } from "@sfly/schema";
import { cn } from "cn";
import { EyeIcon } from "lucide-react";
import { AnomalyMark } from "#/focus/AnomalyNote";
import { readingLabel, valueText } from "#/focus/focus-format";
import type { FocusPreview } from "#/focus/focus-preview";
import { FOCUS } from "#/lib/copy";
import type { NodeFocus } from "./context";
import { LOD_HIDDEN, ZOOM_TEXT_11, ZOOM_TEXT_12 } from "./zoom-text";

/** 卡片可访问名称里的关注项：「3 个关注项，1 项需要注意」，没有异常时只有前半句。 */
export const nodeFocusLabel = ({ count, attention }: Pick<NodeFocus, "count" | "attention">) =>
	attention > 0
		? `${FOCUS.itemCount(count)}，${FOCUS.attentionCount(attention)}`
		: FOCUS.itemCount(count);

/**
 * 卡片左上角的眼睛图标和关注项数量（原型 `.pin`，和右上角的标签同一个样子）。读屏从卡片的名称里读到
 * 「N 个关注项，M 项需要注意」：卡片用 `aria-labelledby` 引用带 `id` 的那段隐藏文字。
 */
export function FocusBadge({ id, focus }: { id: string; focus: NodeFocus }) {
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
				{nodeFocusLabel(focus)}
			</span>
		</>
	);
}

/**
 * 卡片底部的关注项（原型 `.frs`）：前两项各一行，有异常的在前、带琥珀三角，多出的写「还有 N 个关注项」。来源节点成功、
 * 已停止或已取消后控制面不再判断异常，只剩最终值。每行用图表自己的标题（「CPU」），不用场景起的名字：卡片已经说明了来源，
 * 名字也不容易被截断。悬停一行看完整的读数（名称、值、来源节点和状态、异常原因）；读屏只读卡片名称里的个数。
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
