import { focusValueText, type RunFocus, type RunFocusItem } from "@sfly/schema";
import { cn } from "cn";
import type { ComponentProps } from "react";
import { FOCUS } from "#/lib/copy";
import { Truncate } from "@/components/ui/truncate";
import { AnomalyMark } from "./AnomalyNote";
import { FocusValue } from "./FocusValue";
import { anomalyText, focusItemTitle, readingLabel, readingWhen } from "./focus-format";
import type { FocusPreview } from "./focus-preview";

/** 两处放法的差别：行高与字号、最后一行（「还有 N 个关注项」）的样子，槽位格里数值的字号。 */
const LOOK = {
	/** 画布节点卡片的底部：行高 20px，字号随画布的语义缩放（容器给）。 */
	card: { row: "h-5", value: "", more: "flex h-5 items-center text-fg-3" },
	/** Agent 管理页的槽位格：12px，数值紧跟名称，右侧是脚注。 */
	slot: { row: "text-xs", value: "text-xs font-normal", more: "text-xs text-fg-3" },
} as const;

/**
 * 紧凑的关注项行：画布节点卡片和 Agent 槽位格共用，只放得下前几项的地方都用它（取哪几项见 `focusPreview`）。
 * 每项一行：有异常的行首是 `AnomalyMark`，名称、最新值；图表在节点包版本里不存在时值的位置写「这个版本的节点没有图表 X」
 * （`FOCUS.chartMissing`），不显示数值；最后是「还有 N 个关注项」。来源节点没有异常判断后（成功、已停止、已取消）
 * 只剩最终值，没有新数据时最新值退成次要文字色。
 *
 * - `card`：只给眼睛看（读屏从卡片的名称里读到个数、异常原因和失效的原因，调用方给容器 `aria-hidden`），名称是图表自己的
 *   标题（「CPU」），不用场景起的名字；数值靠右，只有数值和单位，图表有多个序列时也不写序列名，放不下的文字直接截断，
 *   悬停一行看完整的读数；
 * - `slot`：读屏要读，名称是关注项的名称（主指标前写「主指标」，`focusItemTitle`），最新值是 `FocusValue`（图表有多个序列时
 *   先写序列名），被截断的文字可以聚焦看全文；右侧是脚注：异常的原因，没有异常时是多久前（最终值、没有值的原因），
 *   不是异常的主指标写明为什么显示它（`FOCUS.noneSet`）。
 *
 * 容器的样式、`aria-*` 与 `data-testid` 由调用方通过 props 给；`generatedAt` 是读数的生成时间（控制面时间）。
 */
export function FocusRows({
	preview,
	generatedAt,
	mode,
	variant,
	className,
	...props
}: {
	preview: Pick<FocusPreview<RunFocusItem>, "shown" | "more">;
	generatedAt: string;
	/** `primary`：场景没有设置关注项，显示的是这个节点的主指标。 */
	mode: RunFocus["mode"];
	variant: keyof typeof LOOK;
} & Omit<ComponentProps<"ul">, "children">) {
	const look = LOOK[variant];
	return (
		<ul {...props} className={cn("m-0 flex list-none flex-col p-0", className)}>
			{preview.shown.map((item) => {
				const reason = anomalyText(item, generatedAt);
				return (
					<li
						key={`${item.node_id}\n${item.chart}\n${item.position}`}
						data-focus-row={item.chart}
						data-anomaly={item.anomaly?.kind}
						title={variant === "card" ? readingLabel(item, generatedAt) : undefined}
						className={cn("flex min-w-0 items-center gap-1.5", look.row)}
					>
						{reason !== null && <AnomalyMark className="flex-none" />}
						<Cell variant={variant} className="min-w-6 text-fg-2">
							{variant === "card" ? item.chart : focusItemTitle(item, mode)}
						</Cell>
						{item.unavailable ? (
							<Cell variant={variant} className="text-fg-3">
								{FOCUS.chartMissing(item.chart)}
							</Cell>
						) : variant === "card" ? (
							<>
								<span
									className={cn(
										"ml-auto flex-none font-mono",
										item.anomaly?.kind === "stale" ? "text-fg-2" : "text-fg-1",
									)}
								>
									{focusValueText(item)}
								</span>
								{item.unit && <span className="flex-none text-fg-3">{item.unit}</span>}
							</>
						) : (
							<FocusValue
								item={item}
								className={cn(look.value, item.anomaly?.kind === "stale" && "text-fg-2")}
							/>
						)}
						{variant === "slot" && (
							<Foot item={item} generatedAt={generatedAt} mode={mode} reason={reason} />
						)}
					</li>
				);
			})}
			{preview.more > 0 && <li className={look.more}>{FOCUS.moreItems(preview.more)}</li>}
		</ul>
	);
}

/** 单行文字：槽位格里被截断时可以聚焦看全文（`Truncate`）；卡片是装饰，里面不放可聚焦的东西，直接截断。 */
function Cell({
	variant,
	className,
	children,
}: {
	variant: keyof typeof LOOK;
	className: string;
	children: string;
}) {
	return variant === "slot" ? (
		<Truncate className={className}>{children}</Truncate>
	) : (
		<span className={cn("min-w-0 truncate", className)}>{children}</span>
	);
}

/** 槽位格一行最右边：异常的原因，没有异常时是多久前；图表不存在时没有值可说，不写。 */
function Foot({
	item,
	generatedAt,
	mode,
	reason,
}: {
	item: RunFocusItem;
	generatedAt: string;
	mode: RunFocus["mode"];
	reason: string | null;
}) {
	const text =
		reason ??
		(item.unavailable ? null : mode === "primary" ? FOCUS.noneSet : readingWhen(item, generatedAt));
	if (text === null) return null;
	return (
		<span
			className={cn(
				"ml-auto flex-none pl-1.5",
				reason === null ? "font-mono text-fg-3" : "text-warn-fg",
			)}
		>
			{text}
		</span>
	);
}
