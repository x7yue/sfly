import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { Panel } from "#/components/page";
import { buttonVariants } from "@/components/ui/button";

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

/** 导航用 `<a>`：读屏读作链接，外观与 ghost 小按钮相同。 */
const LINK_CLASS = buttonVariants({ variant: "ghost", size: "sm" });

/** 面板标题行右侧指向别的页面的链接。 */
export const panelLink = (
	to: "/runs" | "/agents" | "/packages" | "/orchestrations",
	label: string,
) => (
	<Link to={to} className={LINK_CLASS}>
		{label}
	</Link>
);

/** 面板里指向开发文档某一页的链接（`page` 是文档的 slug）。 */
export const panelDocLink = (page: string, children: React.ReactNode) => (
	<Link to="/docs/$page" params={{ page }} className={LINK_CLASS}>
		{children}
	</Link>
);
