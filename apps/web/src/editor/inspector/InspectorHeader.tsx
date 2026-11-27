import { PanelRightCloseIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * 检查器的标题区：上面一行是种类和 ID（`row`）、操作按钮和收起按钮，下面是标题。
 * 标题可能是节点包里的节点标题（别人写的）：这样的标题传 `UntrustedText` 组件，不要传先写成纯文字的字符串，纯文字没有方向隔离。
 */
export function Header({
	row,
	title,
	actions,
	onCollapse,
}: {
	row: ReactNode;
	title: ReactNode;
	actions?: ReactNode;
	onCollapse(): void;
}) {
	return (
		<div className="flex-none border-b border-border-soft px-3.5 pt-3 pb-2.5">
			<div className="flex items-center gap-1.75 text-xs text-fg-3">
				{row}
				<span className="ml-auto flex items-center">
					{actions}
					<Button variant="ghost" size="icon-sm" aria-label="收起检查器" onClick={onCollapse}>
						<PanelRightCloseIcon />
					</Button>
				</span>
			</div>
			<h2 className="mt-1.5 mb-0.5 line-clamp-2 text-base font-semibold wrap-anywhere">{title}</h2>
		</div>
	);
}
