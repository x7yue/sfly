import { useId } from "react";
import { Panel } from "#/components/page";

/** 控制台的面板：标题行（标题、计数、右侧操作）+ 内容；以标题作为区域名称。 */
export function DashboardPanel({
	title,
	count,
	aside,
	children,
}: {
	title: string;
	count?: number | string;
	aside?: React.ReactNode;
	children: React.ReactNode;
}) {
	const id = useId();
	return (
		<Panel aria-labelledby={id}>
			<div className="flex h-11 items-center gap-2 border-b border-border-soft px-3.5">
				<h2 id={id} className="m-0 text-base font-semibold">
					{title}
				</h2>
				{count !== undefined && <span className="font-mono text-xs text-fg-3">{count}</span>}
				<span className="flex-1" />
				{aside}
			</div>
			{children}
		</Panel>
	);
}
