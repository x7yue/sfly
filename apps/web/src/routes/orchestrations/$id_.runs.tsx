import { createFileRoute } from "@tanstack/react-router";
import { RunList } from "#/runs/RunList";

/** 一份编排的运行记录。 */
export const Route = createFileRoute("/orchestrations/$id_/runs")({
	ssr: false,
	component: RunsPage,
});

function RunsPage() {
	const { id } = Route.useParams();
	return <RunList orchestrationId={id} />;
}
