import { useRef, useState } from "react";
import { StatusPill } from "#/components/status";
import { useHostKeyboardFocus } from "#/lib/host-focus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * 节点卡片右上角的「N 警告」：鼠标悬停在徽标上，或用键盘把焦点移到这张卡片上时，提示里列出每条警告。
 * 节点卡片不在 Tab 顺序里（方向键切换），徽标本身也不可聚焦，所以键盘看警告跟随卡片的键盘焦点
 * （`:focus-visible`；鼠标点选卡片时不弹出）。
 */
export function WarningBadge({
	warnings,
	className,
}: {
	warnings: readonly { message: string }[];
	className?: string;
}) {
	const badge = useRef<HTMLSpanElement>(null);
	const [hovered, setHovered] = useState(false);
	const focused = useHostKeyboardFocus(badge, "[data-node-id]");

	return (
		<Tooltip open={hovered || focused} onOpenChange={setHovered}>
			<TooltipTrigger render={<span ref={badge} className="inline-flex cursor-default" />}>
				<StatusPill kind="warn" className={className}>
					{warnings.length} 警告
				</StatusPill>
			</TooltipTrigger>
			<TooltipContent role="tooltip" side="top" align="end" className="max-w-sm">
				<ul className="m-0 flex list-none flex-col gap-1 p-0">
					{warnings.map((w, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 同一节点可能有文字相同的两条警告，列表只读不重排
						<li key={i}>{w.message}</li>
					))}
				</ul>
			</TooltipContent>
		</Tooltip>
	);
}
