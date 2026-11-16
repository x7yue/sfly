import { Link } from "@tanstack/react-router";
import { DOC_PAGE, type DocPage } from "#/lib/copy";
import { buttonVariants } from "@/components/ui/button";

const LOOK = {
	/** 正文里的行内链接。 */
	inline: "text-fg-1 underline decoration-fg-3 underline-offset-2 hover:decoration-fg-1",
	/** 面板标题行和步骤右侧的链接，外观是 ghost 小按钮（同 `PanelLink`）。 */
	button: buttonVariants({ variant: "ghost", size: "sm" }),
} as const;

/** 链接到开发文档的一页；链接文字缺省是这一页的页名（{@link DOC_PAGE}）。 */
export function DocPageLink({
	page,
	look = "inline",
	children = DOC_PAGE[page],
}: {
	page: DocPage;
	look?: keyof typeof LOOK;
	children?: React.ReactNode;
}) {
	return (
		<Link to="/docs/$page" params={{ page }} className={LOOK[look]}>
			{children}
		</Link>
	);
}
