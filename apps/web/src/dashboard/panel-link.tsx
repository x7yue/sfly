import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";

/** 控制台面板标题行右侧去往完整页面的链接（「运行记录」「管理」「场景编排」）：链接，样式是 ghost 小按钮。 */
export function PanelLink({
	to,
	children,
}: {
	to: "/runs" | "/agents" | "/orchestrations";
	children: string;
}) {
	return (
		<Link to={to} className={buttonVariants({ variant: "ghost", size: "sm" })}>
			{children}
		</Link>
	);
}
