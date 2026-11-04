import { createFileRoute } from "@tanstack/react-router";
import { RunPage } from "#/runs/RunPage";

/** 运行视图：实时（运行中）或回看（已结束）某次运行。 */
export const Route = createFileRoute("/runs/$id")({
	// 画布只在浏览器中渲染。
	ssr: false,
	component: RunRoute,
});

function RunRoute() {
	const { id } = Route.useParams();
	return <RunPage key={id} runId={id} />;
}
