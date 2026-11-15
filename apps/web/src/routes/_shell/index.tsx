import { subflowLabel } from "@sfly/orchestration";
import {
	type DashboardAgent,
	type DashboardFailure,
	type DashboardRunningRun,
	type DashboardView,
	dashboardApi,
	isActiveStatus,
} from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRightIcon, PlayIcon } from "lucide-react";
import { useOverlays } from "#/components/app-shell/overlays";
import { ChainBars } from "#/components/chain-progress";
import { ErrorState } from "#/components/feedback/states";
import { NodeName } from "#/components/node-name";
import { Page, PageHeader, Panel } from "#/components/page";
import { nodeStatusView, SlotBar, STATUS, StatusDot, StatusPill } from "#/components/status";
import { DashboardPanel, panelLink } from "#/dashboard/DashboardPanel";
import { GettingStarted } from "#/dashboard/GettingStarted";
import { apiQuery } from "#/lib/api";
import { ACTION, MESSAGE, PAGE } from "#/lib/copy";
import { formatClock, formatDateTime, formatDuration, shortId } from "#/lib/format";
import { LIVE_POLL_MS } from "#/lib/polling";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Truncate } from "@/components/ui/truncate";

export const Route = createFileRoute("/_shell/")({
	staticData: { crumb: PAGE.dashboard },
	component: Dashboard,
});

/**
 * 控制台（原型 #/dashboard）：页头一行（控制面时间、计数、运行场景），下面是正在运行、最近失败、Agent 状态。
 * 环境里还没有运行过任何场景时只显示「开始使用」（原型 #/empty），页头也只剩标题和一句说明。
 */
function Dashboard() {
	const dashboard = useQuery({ ...apiQuery(dashboardApi.get), refetchInterval: LIVE_POLL_MS });
	const overlays = useOverlays();
	const data = dashboard.data;
	const gettingStarted = data !== undefined && !data.setup.run.done;
	// 第一次加载完成之前不显示按钮：全新环境里它马上又会消失。
	const showActions = !gettingStarted && !dashboard.isPending;
	return (
		<Page>
			<PageHeader
				title={PAGE.dashboard}
				description={
					gettingStarted
						? "这套环境还没有运行过场景。按顺序做完下面四步，控制台会换成正在运行的内容。"
						: data && (
								<span className="font-mono text-xs">
									控制面时间 {formatClock(data.generated_at)}
								</span>
							)
				}
				actions={
					showActions && (
						<>
							{data && <RunCounts runs={data.runs} />}
							<Button variant="default" onClick={() => overlays.open("run-scenario")}>
								<PlayIcon />
								{ACTION.runScenario}
							</Button>
						</>
					)
				}
			/>
			{data ? (
				gettingStarted ? (
					<GettingStarted setup={data.setup} />
				) : (
					<DashboardBody data={data} />
				)
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

function DashboardBody({ data }: { data: DashboardView }) {
	return (
		<div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] items-start gap-3.5">
			<RunningPanel runs={data.running_runs} now={Date.parse(data.generated_at)} />
			<div className="flex flex-col gap-3.5">
				<FailuresPanel failures={data.recent_failures} />
				<AgentsPanel agents={data.agents.list} />
			</div>
		</div>
	);
}

// —— 面板 ——

/** 面板里的空状态：一行说明。 */
function PanelEmpty({ children }: { children: React.ReactNode }) {
	return <p className="m-0 px-3.5 py-6 text-center text-sm text-fg-3">{children}</p>;
}

/** 面板里的一行可点击条目（原型 .rrow）。 */
const ROW =
	"group flex items-center gap-3 border-b border-border-soft px-3.5 py-2.5 text-fg-1 no-underline last:border-0 hover:bg-raised";

// —— 正在运行 ——

function RunningPanel({ runs, now }: { runs: DashboardRunningRun[]; now: number }) {
	return (
		<DashboardPanel title="正在运行" count={runs.length} aside={panelLink("/runs", "全部运行")}>
			{runs.length === 0 ? (
				<PanelEmpty>没有正在运行的运行</PanelEmpty>
			) : (
				runs.map((run) => <RunningRow key={run.id} run={run} now={now} />)
			)}
		</DashboardPanel>
	);
}

const ACTIVE_SUFFIX: Partial<Record<string, string>> = { queued: "（排队）", waiting: "（等待）" };

function RunningRow({ run, now }: { run: DashboardRunningRun; now: number }) {
	const current = run.chains.flatMap((c) =>
		c.nodes
			.filter((n) => isActiveStatus(n.status))
			.map((n) => ({ ...n, key: `${c.id}:${n.node_id}` })),
	);
	return (
		<Link to="/runs/$id" params={{ id: run.id }} className={ROW}>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					{run.cancelling ? (
						<StatusPill kind="cancelled">取消中</StatusPill>
					) : (
						<StatusPill kind="running" pulse>
							运行中
						</StatusPill>
					)}
					<b className="truncate font-semibold">{run.orchestration_name}</b>
					<span data-slot="run-id" className="font-mono text-xs text-fg-3">
						{shortId(run.id)}
					</span>
				</div>
				<div className="mt-1 flex flex-wrap gap-x-3 text-xs text-fg-3">
					<span>
						{run.triggered_by} 触发 · v{run.orchestration_version}
					</span>
					<span className="font-mono">
						已运行 {formatDuration(now - Date.parse(run.started_at))}
					</span>
					{current.length > 0 && (
						<span>
							执行中：
							{current.map((n, i) => (
								<span key={n.key}>
									{i > 0 && "、"}
									<NodeName node={n} className={STATUS[nodeStatusView(n.status).kind].text} />
									{ACTIVE_SUFFIX[n.status]}
								</span>
							))}
						</span>
					)}
				</div>
			</div>
			<ChainBars chains={run.chains} variant="wide" />
			<ChevronRightIcon aria-hidden className="size-4 text-fg-3" />
		</Link>
	);
}

// —— 最近失败 ——

function FailuresPanel({ failures }: { failures: DashboardFailure[] }) {
	return (
		<DashboardPanel title="最近失败" count={failures.length} aside={panelLink("/runs", "运行记录")}>
			{failures.length === 0 ? (
				<PanelEmpty>最近 24 小时没有失败</PanelEmpty>
			) : (
				failures.map((f) => <FailureRow key={f.chain_instance_id} failure={f} />)
			)}
		</DashboardPanel>
	);
}

function FailureRow({ failure }: { failure: DashboardFailure }) {
	const still = failure.subflow && failure.run_status === "running";
	return (
		<Link to="/runs/$id" params={{ id: failure.run_id }} className={ROW}>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<StatusPill kind="failed">
						{failure.subflow
							? `子流程失败 · ${subflowLabel({ id: failure.chain_id, name: failure.subflow_name })}`
							: "失败"}
					</StatusPill>
					<b className="truncate font-semibold">{failure.orchestration_name}</b>
					<span data-slot="run-id" className="font-mono text-xs text-fg-3">
						{shortId(failure.run_id)}
					</span>
				</div>
				<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">
					{failure.error && (
						<Badge variant="danger" className="font-mono">
							{failure.error.kind}
						</Badge>
					)}
					<span>
						{failure.node_id ? (
							<>
								失败节点{" "}
								<NodeName
									node={{ node_id: failure.node_id, display_name: failure.display_name }}
									className="text-fg-2"
								/>
							</>
						) : (
							"没有失败节点"
						)}
						{still && " · 主链仍在运行"}
					</span>
					<span className="font-mono">{formatDateTime(failure.failed_at)}</span>
				</div>
				{failure.error?.message && (
					<div className="mt-1 truncate text-xs text-fg-2" title={failure.error.message}>
						{failure.error.message}
					</div>
				)}
			</div>
			<ChevronRightIcon aria-hidden className="size-4 text-fg-3" />
		</Link>
	);
}

// —— Agent 状态 ——

function AgentsPanel({ agents }: { agents: DashboardAgent[] }) {
	return (
		<DashboardPanel title="Agent 状态" count={agents.length} aside={panelLink("/agents", "管理")}>
			{agents.length === 0 ? (
				<PanelEmpty>
					{MESSAGE.noAgents}。
					<Link
						to="/agents"
						className="ml-1 text-fg-2 underline underline-offset-2 hover:text-fg-1"
					>
						查看安装命令
					</Link>
				</PanelEmpty>
			) : (
				<Table aria-label="Agent 状态">
					<TableBody>
						{agents.map((agent) => (
							<TableRow key={agent.name}>
								<TableCell width="fit" className="font-mono">
									<span className="inline-flex items-center gap-2">
										<StatusDot
											kind={
												agent.status === "offline" ? "pending" : agent.installing ? "warn" : "ok"
											}
										/>
										{agent.name}
									</span>
								</TableCell>
								<TableCell width="fit">
									<SlotBar used={agent.used_slots} total={agent.slots} />
								</TableCell>
								<TableCell width="grow" className="text-xs text-fg-3">
									<AgentState agent={agent} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</DashboardPanel>
	);
}

function AgentState({ agent }: { agent: DashboardAgent }) {
	const state = agentState(agent);
	return <Truncate className={state.className}>{state.text}</Truncate>;
}

function agentState(agent: DashboardAgent): { text: string; className?: string } {
	if (agent.status === "offline") return { text: `离线 · ${formatDateTime(agent.last_seen_at)}` };
	if (agent.installing) {
		return {
			text: `正在安装 ${agent.installing.package}@${agent.installing.version}`,
			className: "text-warn-fg",
		};
	}
	return { text: "在线" };
}

// —— 加载骨架 ——

function DashboardSkeleton() {
	return (
		<output aria-label="加载中" aria-busy="true" className="block">
			<div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-3.5">
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
			</div>
		</output>
	);
}
