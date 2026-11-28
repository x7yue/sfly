import { type OrchestrationSummary, orchestrationsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ErrorState } from "#/components/feedback/states";
import { runStatusView, StatusPill } from "#/components/status";
import { apiQuery } from "#/lib/api";
import { MESSAGE, PAGE, TERM } from "#/lib/copy";
import { formatDateTime } from "#/lib/format";
import { STATUS_POLL_MS } from "#/lib/polling";
import { PROJECT } from "#/lib/project";
import { Skeleton } from "@/components/ui/skeleton";
import { Truncate } from "@/components/ui/truncate";
import { DashboardPanel } from "./DashboardPanel";
import { PanelLink } from "./panel-link";

/** 右栏最多列出的场景数；完整的列表在场景编排页。 */
const SCENARIOS_SHOWN = 10;

/** 按最近一次运行的开始时间从新到旧；没运行过的排在后面，按最近保存的时间。 */
export function byLastRun(scenarios: readonly OrchestrationSummary[]): OrchestrationSummary[] {
	const key = (s: OrchestrationSummary) => s.last_run?.started_at ?? "";
	return [...scenarios].sort(
		(a, b) => key(b).localeCompare(key(a)) || b.updated_at.localeCompare(a.updated_at),
	);
}

/**
 * 右栏的场景：给搭场景的人用的入口，按最近一次运行的时间排，写上次运行的结果，从没运行过的写「从未运行」；
 * 点一行进入画布。和命令面板读的是同一份场景列表。
 */
export function ScenariosPanel() {
	const scenarios = useQuery({
		...apiQuery(orchestrationsApi.list, { params: { project: PROJECT }, query: {} }),
		refetchInterval: STATUS_POLL_MS,
	});
	const all = scenarios.data?.orchestrations ?? [];
	const shown = byLastRun(all).slice(0, SCENARIOS_SHOWN);
	return (
		<DashboardPanel
			title={TERM.scenario}
			count={scenarios.data && all.length}
			aside={<PanelLink to="/orchestrations">{PAGE.scenarios}</PanelLink>}
		>
			{scenarios.data && shown.length === 0 ? (
				<p className="m-0 px-3.5 py-3 text-xs text-fg-2">{MESSAGE.noScenariosListed}</p>
			) : scenarios.data ? (
				<ul className="m-0 list-none p-0">
					{shown.map((scenario) => (
						<li key={scenario.id} className="border-b border-border-soft last:border-0">
							<Truncate
								label={scenario.name}
								render={
									<Link
										to="/orchestrations/$id"
										params={{ id: scenario.id }}
										className="flex min-h-10 items-center gap-2.5 px-3.5 py-2.5 text-fg-1 no-underline hover:bg-raised"
									/>
								}
							>
								<Truncate className="flex-1 font-medium">{scenario.name}</Truncate>
								<LastRun scenario={scenario} />
							</Truncate>
						</li>
					))}
				</ul>
			) : scenarios.isError ? (
				<div className="p-3.5">
					<ErrorState
						title={MESSAGE.loadFailed(TERM.scenario)}
						error={scenarios.error}
						onRetry={() => void scenarios.refetch()}
					/>
				</div>
			) : (
				<div className="flex flex-col gap-2 p-3.5">
					<Skeleton className="h-3 w-1/3" />
					<Skeleton className="h-8 w-full" />
				</div>
			)}
		</DashboardPanel>
	);
}

function LastRun({ scenario }: { scenario: OrchestrationSummary }) {
	const run = scenario.last_run;
	if (!run) return <StatusPill kind="pending">{MESSAGE.neverRun}</StatusPill>;
	const status = runStatusView(run.status, { cancelling: run.cancelling });
	return (
		<StatusPill kind={status.kind}>
			{status.label}
			{run.ended_at && <span className="font-mono text-fg-3">{formatDateTime(run.ended_at)}</span>}
		</StatusPill>
	);
}
