import { focusLatestSeriesName, focusValueText, type RunFocusItem } from "@sfly/schema";
import { cn } from "cn";

/**
 * 关注项读数的最新值：等宽 16px 加粗的数值和三级文字的单位；图表有多个序列时，数值前面先写最近更新的那条的名字。
 * 没有新数据（`anomaly` 是 stale）时数值退成次要文字色：这个值已经不新了。
 * 读数（FocusReadout）、图表卡片（FocusChart）、Agent 槽位格和画布检查器的图表共用，退色只在这里判断。
 */
export function FocusValue({
	item,
	className,
}: {
	item: Pick<RunFocusItem, "latest" | "metrics" | "unit"> & {
		anomaly?: RunFocusItem["anomaly"] | undefined;
	};
	className?: string;
}) {
	const series = focusLatestSeriesName(item);
	return (
		<span
			className={cn(
				"font-mono text-lg font-semibold whitespace-nowrap",
				item.anomaly?.kind === "stale" ? "text-fg-2" : "text-fg-1",
				className,
			)}
		>
			{series && <span className="mr-1 text-xs font-normal text-fg-3">{series}</span>}
			{focusValueText(item)}
			{item.unit && <small className="ml-0.75 text-xs font-normal text-fg-3">{item.unit}</small>}
		</span>
	);
}
