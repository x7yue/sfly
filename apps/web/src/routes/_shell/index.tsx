import { createFileRoute, Link } from "@tanstack/react-router";
import { LayoutDashboardIcon } from "lucide-react";
import { EmptyState } from "#/components/feedback/states";
import { Page, PageHeader, Panel } from "#/components/page";

export const Route = createFileRoute("/_shell/")({
	staticData: { crumb: "控制台" },
	component: Dashboard,
});

/** 控制台（#34 实现统计与各模块）；在此之前给出常用入口。 */
function Dashboard() {
	return (
		<Page>
			<PageHeader title="控制台" />
			<Panel>
				<EmptyState
					icon={<LayoutDashboardIcon />}
					title="控制台正在建设中"
					description="运行统计、正在运行的场景与 Agent 状态会显示在这里。"
				>
					<p className="m-0 text-sm">
						先去{" "}
						<Link to="/orchestrations" className="text-fg-1 underline underline-offset-2">
							场景编排
						</Link>{" "}
						或{" "}
						<Link to="/agents" className="text-fg-1 underline underline-offset-2">
							Agent 管理
						</Link>
						。
					</p>
				</EmptyState>
			</Panel>
		</Page>
	);
}
