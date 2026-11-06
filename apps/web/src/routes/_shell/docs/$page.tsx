import { createFileRoute } from "@tanstack/react-router";
import { DocsPage } from "#/docs/DocsPage";
import { PAGE } from "#/lib/copy";

/** 「开发文档」的一页：`/docs/<slug>`，原文在控制面的 `/docs/<slug>.md`。 */
export const Route = createFileRoute("/_shell/docs/$page")({
	staticData: { crumb: PAGE.docs },
	component: DocPageRoute,
});

function DocPageRoute() {
	const { page } = Route.useParams();
	return <DocsPage slug={page} />;
}
