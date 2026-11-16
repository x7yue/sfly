import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { RunFocusItem } from "@sfly/schema";
import { cn } from "cn";
import type { ReactElement, ReactNode } from "react";
import { nodeStatusView, StatusDot } from "#/components/status";
import { FOCUS, TERM } from "#/lib/copy";
import { AnomalyNote } from "./AnomalyNote";
import { FocusValue } from "./FocusValue";
import { readingFoot, readingLabel } from "./focus-format";

/**
 * 关注项读数：一个关注项（或主指标）的一格读数，读数之间只用 1px 分隔，不套卡片。
 * 从上到下三行：来源节点的状态形状和名称；最新值（累计值就是当前累计，平台不算速率；多个序列时先写最近更新的那条
 * 的名字）和单位；来源节点和「多久前」（来源节点成功、已停止或已取消后是「最终值」，没有值时是原因）。有异常时第三行换成
 * 琥珀三角和原因（`AnomalyNote`），无新数据时最新值退成次要文字色。
 * 图表在节点包版本里不存在时写明原因，不显示数值。
 *
 * 默认是一个 `div`；整格可以点时用 `render` 换成按钮或链接（可访问名称写明名称、值、来源节点和状态，以及多久前、最终值或没有值的原因）。
 * `generatedAt` 是这份读数的生成时间（控制面时间）：「多久前」按它算，不随浏览器时钟跳动。`runEnded` 是运行已经结束：
 * 一直待执行的来源节点写「这次运行没有执行」。
 */
export function FocusReadout({
	item,
	generatedAt,
	runEnded = false,
	render,
	className,
	...props
}: useRender.ComponentProps<"div"> & {
	item: RunFocusItem;
	generatedAt: string;
	runEnded?: boolean;
}) {
	return useRender({
		defaultTagName: "div",
		render,
		props: mergeProps<"div">(
			{
				// 没换成按钮或链接时是个没有角色的 div：给它 group，名称才有地方挂。
				role: render ? undefined : "group",
				"aria-label": readingLabel(item, generatedAt, runEnded),
				className: cn(
					"flex min-w-0 flex-col gap-px px-3 py-2 text-left text-inherit no-underline",
					className,
				),
				children: (
					<>
						<span className="flex items-start gap-1.5 text-xs text-fg-2">
							<StatusDot kind={nodeStatusView(item.source.status).kind} className="mt-1.25" />
							<span className="line-clamp-2 wrap-anywhere">{item.title}</span>
						</span>
						{item.unavailable ? (
							<span className="text-xs text-fg-3">{FOCUS.chartMissing(item.chart)}</span>
						) : (
							<FocusValue item={item} className="truncate" />
						)}
						{item.anomaly ? (
							<AnomalyNote item={item} generatedAt={generatedAt} />
						) : (
							<span className="font-mono text-xs wrap-anywhere text-fg-3">
								{readingFoot(item, generatedAt, runEnded)}
							</span>
						)}
					</>
				),
			},
			props,
		),
		state: { slot: "focus-readout" },
	});
}

/**
 * 一排关注项读数：默认自动按宽度排成几列；`columns` 给了就是这么多等宽的列（控制台按运行块的宽度放 3 或 4 格），
 * 放不下的换行。读数之间 1px 分隔（每格的上、左描边，整体左移、上移 1px 再裁掉最外面一圈，换行后每一行也一样）。
 * `renderItem` 给每一格换成按钮或链接；`trailing` 是排在最后、和读数一样占一格的内容（「还有 3 个关注项 · 打开概览」）。
 * 外框、底色由调用方的 `className` 决定。
 */
export function FocusReadoutStrip({
	items,
	generatedAt,
	runEnded = false,
	renderItem,
	columns,
	trailing,
	className,
}: {
	items: readonly RunFocusItem[];
	generatedAt: string;
	/** 运行已经结束（见 {@link FocusReadout}）。 */
	runEnded?: boolean;
	renderItem?: (item: RunFocusItem) => ReactElement<Record<string, unknown>>;
	columns?: number;
	trailing?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("overflow-hidden", className)}>
			<ul
				aria-label={`${TERM.focusItem}读数`}
				className={cn(
					"-mt-px -ml-px grid list-none p-0",
					columns === undefined && "grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]",
				)}
				style={
					columns === undefined
						? undefined
						: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
				}
			>
				{items.map((item) => (
					<li
						key={`${item.node_id}\n${item.chart}\n${item.position}`}
						className="min-w-0 border-t border-l border-border-soft"
					>
						<FocusReadout
							item={item}
							generatedAt={generatedAt}
							runEnded={runEnded}
							render={renderItem?.(item)}
							className={renderItem ? "w-full cursor-pointer hover:bg-fg-1/3" : undefined}
						/>
					</li>
				))}
				{trailing && <li className="min-w-0 border-t border-l border-border-soft">{trailing}</li>}
			</ul>
		</div>
	);
}
