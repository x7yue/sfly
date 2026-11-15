import { focusValueText, latestSeriesName, type RunFocusItem } from "@sfly/schema";
import { cn } from "cn";

/**
 * 关注项读数的最新值：等宽 16px 加粗的数值和三级文字的单位；图表有多个序列时，数值前面先写最近更新的那条的名字。
 * 读数（FocusReadout）和图表卡片（FocusChart）共用。
 */
export function FocusValue({
	item,
	className,
}: {
	item: Pick<RunFocusItem, "latest" | "metrics" | "unit">;
	className?: string;
}) {
	const series = latestSeriesName(item);
	return (
		<span className={cn("font-mono text-lg font-semibold whitespace-nowrap text-fg-1", className)}>
			{series && <span className="mr-1 text-xs font-normal text-fg-3">{series}</span>}
			{focusValueText(item)}
			{item.unit && <small className="ml-0.75 text-xs font-normal text-fg-3">{item.unit}</small>}
		</span>
	);
}
