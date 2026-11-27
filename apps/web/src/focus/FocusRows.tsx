import { focusValueText, type RunFocus, type RunFocusItem } from "@sfly/schema";
import { cn } from "cn";
import type { ComponentProps, ComponentType } from "react";
import { UntrustedText } from "#/components/untrusted-text";
import { FOCUS } from "#/lib/copy";
import { Truncate } from "@/components/ui/truncate";
import { AnomalyMark } from "./AnomalyNote";
import { FocusValue, isStaleValue } from "./FocusValue";
import {
	anomalyText,
	focusItemTitle,
	readingLabel,
	readingState,
	readingWhen,
} from "./focus-format";
import type { FocusPreview } from "./focus-preview";

/** 一行里的一项内容：行的数据，加上读数的生成时间和模式（脚注要用）。 */
interface CellProps {
	item: RunFocusItem;
	generatedAt: string;
	mode: RunFocus["mode"];
}

/** 一种放法：行的样子，名称、数值、脚注怎么画。 */
interface Look {
	row: string;
	more: string;
	name(item: RunFocusItem, mode: RunFocus["mode"]): string;
	/** 悬停一行看到的文字。 */
	title(item: RunFocusItem, generatedAt: string, runEnded: boolean): string | undefined;
	/** 单行文字（名称、失效的原因）。 */
	Text: ComponentType<{ className: string; children: string }>;
	Value: ComponentType<CellProps>;
	/** 一行最右边；没有时为 null。 */
	Foot: ComponentType<CellProps> | null;
}

/** 画布节点卡片的底部：行高 20px，字号随画布的语义缩放（容器给）。 */
const CARD: Look = {
	row: "h-5",
	more: "flex h-5 items-center text-fg-3",
	name: (item) => item.chart,
	title: readingLabel,
	// 卡片是装饰，里面不放可聚焦的东西：直接截断。
	Text: ({ className, children }) => (
		<span className={cn("min-w-0 truncate", className)}>
			<UntrustedText text={children} />
		</span>
	),
	Value: ({ item }) => (
		<>
			<span
				className={cn(
					"ml-auto flex-none font-mono",
					isStaleValue(item) ? "text-fg-2" : "text-fg-1",
				)}
			>
				{focusValueText(item)}
			</span>
			{item.unit && (
				<span className="flex-none text-fg-3">
					<UntrustedText text={item.unit} />
				</span>
			)}
		</>
	),
	Foot: null,
};

/** Agent 管理页的槽位格：12px，数值紧跟名称，右侧是脚注。 */
const SLOT: Look = {
	row: "text-xs",
	more: "text-xs text-fg-3",
	name: focusItemTitle,
	title: () => undefined,
	// 被截断时可以聚焦看全文。
	Text: ({ className, children }) => (
		<Truncate untrusted className={className}>
			{children}
		</Truncate>
	),
	Value: ({ item }) => <FocusValue item={item} className="text-xs font-normal" />,
	Foot: ({ item, generatedAt, mode }) => {
		const reason = anomalyText(item, generatedAt);
		// 图表不存在时没有值可说，不写；不是异常的主指标写明为什么显示它。
		const text =
			reason ??
			(item.unavailable
				? null
				: mode === "primary"
					? FOCUS.noneSet
					: readingWhen(item, generatedAt));
		if (text === null) return null;
		// 只有「2s 前」是数值，用等宽；最终值、没有值的原因和「场景没有设置关注项」是中文说明，不用等宽。
		const numeric =
			reason === null && mode === "focus" && readingState(item, generatedAt).kind === "live";
		return (
			<span
				className={cn(
					"ml-auto flex-none pl-1.5",
					reason === null ? "text-fg-3" : "text-warn-fg",
					numeric && "font-mono",
				)}
			>
				{text}
			</span>
		);
	},
};

const LOOKS = { card: CARD, slot: SLOT } as const;

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
	runEnded = false,
	className,
	...props
}: {
	preview: Pick<FocusPreview<RunFocusItem>, "shown" | "more">;
	generatedAt: string;
	/** 运行已经结束：悬停一行看到的文字里，一直待执行的来源节点写「未执行」，不写「待执行」。 */
	runEnded?: boolean;
	/** `primary`：场景没有设置关注项，显示的是这个节点的主指标。 */
	mode: RunFocus["mode"];
	variant: keyof typeof LOOKS;
} & Omit<ComponentProps<"ul">, "children">) {
	const look = LOOKS[variant];
	return (
		<ul {...props} className={cn("m-0 flex list-none flex-col p-0", className)}>
			{preview.shown.map((item) => (
				<li
					key={`${item.node_id}\n${item.chart}\n${item.position}`}
					data-focus-row={item.chart}
					data-anomaly={item.anomaly?.kind}
					title={look.title(item, generatedAt, runEnded)}
					className={cn("flex min-w-0 items-center gap-1.5", look.row)}
				>
					{item.anomaly && <AnomalyMark className="flex-none" />}
					<look.Text className="min-w-6 text-fg-2">{look.name(item, mode)}</look.Text>
					{item.unavailable ? (
						<look.Text className="text-fg-3">{FOCUS.chartMissing(item.chart)}</look.Text>
					) : (
						<look.Value item={item} generatedAt={generatedAt} mode={mode} />
					)}
					{look.Foot && <look.Foot item={item} generatedAt={generatedAt} mode={mode} />}
				</li>
			))}
			{preview.more > 0 && <li className={look.more}>{FOCUS.moreItems(preview.more)}</li>}
		</ul>
	);
}
