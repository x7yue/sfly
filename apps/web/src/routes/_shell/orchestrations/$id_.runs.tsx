import { createFileRoute } from "@tanstack/react-router";
import { RunList } from "#/runs/RunList";

/** 一份编排的运行记录。 */
export const Route = createFileRoute("/_shell/orchestrations/$id_/runs")({
	staticData: { crumb: ["场景编排", "运行列表"] },
	component: RunsPage,
});

function RunsPage() {
	const { id } = Route.useParams();
	return <RunList orchestrationId={id} />;
}
