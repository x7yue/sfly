import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { MonitorPage } from "#/monitor/MonitorPage";

/** 运行监控页（全屏，不带外壳）：实时或回看某次运行。`?node=<节点 ID>` 打开时选中该节点。 */
export const Route = createFileRoute("/runs/$id")({
	validateSearch: z.object({ node: z.string().optional() }),
	component: MonitorRoute,
});

function MonitorRoute() {
	const { id } = Route.useParams();
	const { node } = Route.useSearch();
	return <MonitorPage key={id} runId={id} initialNode={node} />;
}
