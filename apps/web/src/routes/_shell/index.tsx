import { type DashboardView, dashboardApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { cn } from "cn";
import { PlayIcon } from "lucide-react";
import { useOverlays } from "#/components/app-shell/overlays";
import { ErrorState } from "#/components/feedback/states";
import { Page, PageHeader, Panel } from "#/components/page";
import { AgentsPanel } from "#/dashboard/AgentsPanel";
import { EndedPanel } from "#/dashboard/EndedPanel";
import { RunningRuns } from "#/dashboard/RunningRuns";
import { ScenariosPanel } from "#/dashboard/ScenariosPanel";
import { apiQuery } from "#/lib/api";
import { MESSAGE, PAGE } from "#/lib/copy";
import { formatClock } from "#/lib/format";
import { LIVE_POLL_MS } from "#/lib/polling";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_shell/")({
	staticData: { crumb: PAGE.dashboard },
	component: Dashboard,
});

/**
 * 控制台：此刻的实况墙（外壳页方案 4.1）。页头一行是控制面时间、计数和「运行场景」；左栏是正在运行的运行块和最近结束，
 * 右栏是 Agent 的槽位和场景。数量多时的退化规则见 dashboard/wall-rules。
 */
function Dashboard() {
	const dashboard = useQuery({ ...apiQuery(dashboardApi.get), refetchInterval: LIVE_POLL_MS });
	const overlays = useOverlays();
	const data = dashboard.data;
	return (
		<Page>
			<PageHeader
				title={PAGE.dashboard}
				description={
					data && (
						<span className="font-mono text-xs">控制面时间 {formatClock(data.generated_at)}</span>
					)
				}
				actions={
					<>
						{data && <RunCounts runs={data.runs} />}
						<Button variant="default" onClick={() => overlays.open("run-scenario")}>
							<PlayIcon />
							运行场景
						</Button>
					</>
				}
			/>
			{data ? (
				<Wall data={data} />
			) : dashboard.isError ? (
				<ErrorState
					title="无法加载控制台数据"
					error={dashboard.error}
					onRetry={() => dashboard.refetch()}
				/>
			) : (
				<DashboardSkeleton />
			)}
		</Page>
	);
}

/** 页头右侧一行等宽的计数：此刻的运行中、执行中的任务、排队，以及最近 24 小时的成功、失败、取消。 */
function RunCounts({ runs }: { runs: DashboardView["runs"] }) {
	return (
		<ul
			aria-label="运行计数"
			className="m-0 mr-2 flex list-none items-center gap-4 p-0 text-xs text-fg-3"
		>
			<Count label="运行中" value={runs.running} />
			<Count label="执行中任务" value={runs.running_tasks} />
			<Count label="排队" value={runs.queued_tasks} />
			<li aria-hidden className="h-3.5 w-px bg-border" />
			<li>
				最近 24 小时 <Count label="成功" value={runs.success} inline />
				{" · "}
				{/* 数值为 0 时不着色：颜色只在有失败时传达信号。 */}
				<Count
					label="失败"
					value={runs.failed}
					inline
					className={runs.failed > 0 ? "text-danger-fg" : undefined}
				/>
				{" · "}
				<Count label="取消" value={runs.cancelled} inline />
			</li>
		</ul>
	);
}

function Count({
	label,
	value,
	inline,
	className,
}: {
	label: string;
	value: number;
	inline?: boolean;
	className?: string;
}) {
	const content = (
		<>
			{label} <b className={cn("font-mono font-semibold text-fg-1", className)}>{value}</b>
		</>
	);
	return inline ? <span>{content}</span> : <li>{content}</li>;
}

/** 两栏：左栏随宽度伸缩，右栏 352px（1360 以下 320px）。 */
const WALL =
	"grid grid-cols-[minmax(0,1fr)_22rem] items-start gap-3.5 max-[85rem]:grid-cols-[minmax(0,1fr)_20rem]";

function Wall({ data }: { data: DashboardView }) {
	return (
		<div className={WALL}>
			<div className="flex min-w-0 flex-col gap-3.5">
				<RunningRuns runs={data.running_runs} />
				<EndedPanel runs={data.recent_ended} />
			</div>
			<div className="flex min-w-0 flex-col gap-3.5">
				<AgentsPanel />
				<ScenariosPanel />
			</div>
		</div>
	);
}

function DashboardSkeleton() {
	return (
		<output aria-label={MESSAGE.loading} aria-busy="true" className={cn(WALL, "w-full")}>
			{[0, 1].map((col) => (
				<div key={col} className="flex flex-col gap-3.5">
					{[0, 1].map((p) => (
						<Panel key={p} className="px-3.5 py-4">
							<Skeleton className="h-3 w-1/4" />
							<Skeleton className="mt-4 h-3 w-3/4" />
							<Skeleton className="mt-3 h-3 w-2/3" />
						</Panel>
					))}
				</div>
			))}
		</output>
	);
}
