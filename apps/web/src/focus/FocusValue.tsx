import { focusLatestSeriesName, focusValueText, type RunFocusItem } from "@sfly/schema";
import { cn } from "cn";
import { UntrustedText } from "#/components/untrusted-text";

/** 这一项的值已经不新了：控制面给了 `stale_since`（没有新数据，和报哪一种异常无关）。值退成次要文字色都按它判断。 */
export const isStaleValue = (item: { stale_since?: RunFocusItem["stale_since"] | undefined }) =>
	!!item.stale_since;

/**
 * 关注项读数的最新值：等宽 16px 加粗的数值和三级文字的单位；图表有多个序列时，数值前面先写最近更新的那条的名字。
 * 没有新数据（控制面给了 `stale_since`，和报哪一种异常无关）时数值退成次要文字色：这个值已经不新了。
 * 读数（FocusReadout）、图表卡片（FocusChart）、Agent 槽位格和画布检查器的图表共用；画布卡片的行（FocusRows）用同一个 {@link isStaleValue}。
 */
export function FocusValue({
	item,
	className,
}: {
	item: Pick<RunFocusItem, "latest" | "metrics" | "unit"> & {
		stale_since?: RunFocusItem["stale_since"] | undefined;
	};
	className?: string;
}) {
	const series = focusLatestSeriesName(item);
	return (
		<span
			className={cn(
				"font-mono text-lg font-semibold whitespace-nowrap",
				isStaleValue(item) ? "text-fg-2" : "text-fg-1",
				className,
			)}
		>
			{series && (
				<span className="mr-1 text-xs font-normal text-fg-3">
					<UntrustedText text={series} />
				</span>
			)}
			{focusValueText(item)}
			{item.unit && (
				<small className="ml-0.75 text-xs font-normal text-fg-3">
					<UntrustedText text={item.unit} />
				</small>
			)}
		</span>
	);
}
