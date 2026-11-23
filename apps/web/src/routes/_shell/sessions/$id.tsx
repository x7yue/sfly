import { createFileRoute } from "@tanstack/react-router";
import { PAGE } from "#/lib/copy";
import { SessionPage } from "#/sessions/SessionPage";

export const Route = createFileRoute("/_shell/sessions/$id")({
	staticData: { crumb: [PAGE.assistant, PAGE.session] },
	component: SessionRoute,
});

/** 会话页（#542）：带外壳（侧边栏和顶栏）。 */
function SessionRoute() {
	const { id } = Route.useParams();
	return <SessionPage id={id} />;
}
