import type { RunFocusItem } from "@sfly/schema";
import { cn } from "cn";
import { StatusDot } from "#/components/status";
import { anomalyText } from "./focus-format";

/**
 * 关注项异常的标记：琥珀色实心三角（状态表的 `warn`，DESIGN-SYSTEM 6.1）。只是形状，不带名称：
 * 旁边必须有写明原因的文字（{@link AnomalyNote}），或者原因写在所在元素的可访问名称里。
 */
export function AnomalyMark({ className }: { className?: string }) {
	return <StatusDot kind="warn" className={className} />;
}

/**
 * 关注项异常的原因：三角加文字（`warn-fg`），例如「▲ 已 2m 10s 无新数据」。读数和图表卡片用它代替「来源节点 · 多久前」；
 * `suffix` 接在原因后面（图表卡片接「 · 来源节点」）。没有异常时什么也不画。
 */
export function AnomalyNote({
	item,
	generatedAt,
	suffix = "",
	className,
}: {
	item: Pick<RunFocusItem, "anomaly" | "source">;
	generatedAt: string;
	suffix?: string;
	className?: string;
}) {
	const text = anomalyText(item, generatedAt);
	if (text === null) return null;
	return (
		<span
			data-anomaly={item.anomaly?.kind}
			className={cn("flex items-start gap-1.5 text-xs text-warn-fg", className)}
		>
			<AnomalyMark className="mt-1.25" />
			<span className="min-w-0 wrap-anywhere">
				{text}
				{suffix}
			</span>
		</span>
	);
}
