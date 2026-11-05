import { createFileRoute } from "@tanstack/react-router";
import { RunPage } from "#/runs/RunPage";

/** 运行视图：实时（运行中）或回看（已结束）某次运行。 */
export const Route = createFileRoute("/_shell/runs/$id")({
	staticData: { crumb: "运行详情" },
	component: RunRoute,
});

function RunRoute() {
	const { id } = Route.useParams();
	return <RunPage key={id} runId={id} />;
}
