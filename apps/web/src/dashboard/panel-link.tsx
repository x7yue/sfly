import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";

/**
 * 控制台里去往完整页面的链接（面板标题行右侧的「运行记录」「管理」「场景编排」，「开始使用」各步完成后的页名）：链接，
 * 样式是 ghost 小按钮。去开发文档的同样样子的链接是 `DocPageLink` 的 `look="button"`。
 */
export function PanelLink({
	to,
	children,
}: {
	to: "/runs" | "/agents" | "/orchestrations" | "/packages";
	children: string;
}) {
	return (
		<Link to={to} className={buttonVariants({ variant: "ghost", size: "sm" })}>
			{children}
		</Link>
	);
}
