import { createFileRoute, Link } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { EmptyState } from "#/components/feedback/states";
import { Page, PageHeader, Panel } from "#/components/page";

export const Route = createFileRoute("/_shell/runs/")({
	staticData: { crumb: "运行记录" },
	component: Runs,
});

/** 跨场景的运行记录（#37 实现）；在此之前从场景进入它的运行列表。 */
function Runs() {
	return (
		<Page>
			<PageHeader title="运行记录" />
			<Panel>
				<EmptyState
					icon={<PlayIcon />}
					title="运行记录正在建设中"
					description="所有场景的进行中与历史运行会显示在这里。"
				>
					<p className="m-0 text-sm">
						现在可以在{" "}
						<Link to="/orchestrations" className="text-fg-1 underline underline-offset-2">
							场景编排
						</Link>{" "}
						里打开某个场景的运行列表。
					</p>
				</EmptyState>
			</Panel>
		</Page>
	);
}
