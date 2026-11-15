import { cn } from "cn";
import { viaLabel } from "#/lib/copy";
import { formatDateTime } from "#/lib/format";

/**
 * 跟在触发人、取消人、版本作者后面的「经 Claude Code」。没有经 AI 编程助手时什么都不渲染，
 * 所以人在浏览器里的操作显示和以前完全一样。前面带一个空格，直接接在名字后面。
 */
export function ViaTag({ via, className }: { via: string | null; className?: string }) {
	if (!via) return null;
	return (
		<span data-slot="via" className={cn(className)}>
			{` ${viaLabel(via)}`}
		</span>
	);
}

/** 「tester 经 Claude Code 触发 · 开始 01-01 09:05」：运行的触发人和开始时间（控制台的运行块、运行记录的卡片、运行监控页顶栏）。 */
export function TriggeredAt({
	by,
	via = null,
	at,
}: {
	by: string;
	via?: string | null;
	at: string;
}) {
	return (
		<>
			{by}
			<ViaTag via={via} /> 触发 · 开始 <span className="font-mono">{formatDateTime(at)}</span>
		</>
	);
}
