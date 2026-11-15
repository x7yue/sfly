import { Link } from "@tanstack/react-router";

/** 链接到开发文档的一页（正文里的行内链接）。 */
export function DocPageLink({ page, children }: { page: string; children: React.ReactNode }) {
	return (
		<Link
			to="/docs/$page"
			params={{ page }}
			className="text-fg-1 underline decoration-fg-3 underline-offset-2 hover:decoration-fg-1"
		>
			{children}
		</Link>
	);
}
