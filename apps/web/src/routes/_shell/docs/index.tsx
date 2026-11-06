import { createFileRoute } from "@tanstack/react-router";
import { DocsPage } from "#/docs/DocsPage";
import { PAGE } from "#/lib/copy";

/** 「开发文档」入口：显示目录里的第一页。 */
export const Route = createFileRoute("/_shell/docs/")({
	staticData: { crumb: PAGE.docs },
	component: () => <DocsPage />,
});
