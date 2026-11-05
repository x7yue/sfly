import {
	type DashboardAgent,
	type DashboardFailure,
	type DashboardRunningRun,
	type DashboardView,
	dashboardApi,
} from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRightIcon, WorkflowIcon } from "lucide-react";
import { useId } from "react";
import { ErrorState } from "#/components/feedback/states";
import { Page, PageHeader, Panel } from "#/components/page";
import { SlotBar, StatusDot, StatusPill } from "#/components/status";
import { ChainBars, Sparkline, TrendChart, TrendLegend } from "#/dashboard/charts";
import { apiQuery } from "#/lib/api";
import { formatDateTime, formatDuration } from "#/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_shell/")({
	staticData: { crumb: "控制台" },
	component: Dashboard,
});

/** 控制台轮询间隔：运行与 Agent 的变化几秒内反映到页面上。 */
const REFRESH_MS = 2_000;

const shortId = (id: string) => id.slice(0, 8);

/** 控制台（原型 #/dashboard）：模块固定——统计卡、正在运行、运行趋势、最近失败、Agent 状态、最近发布的节点包。 */
function Dashboard() {
	const dashboard = useQuery({ ...apiQuery(dashboardApi.get), refetchInterval: REFRESH_MS });
	return (
		<Page>
			<PageHeader
				title="控制台"
				description="最近 24 小时 · 实时更新"
				actions={
					<Button variant="default" render={<Link to="/orchestrations" />} nativeButton={false}>
						<WorkflowIcon />
						场景编排
					</Button>
				}
			/>
			{dashboard.data ? (
				<DashboardBody data={dashboard.data} />
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

function DashboardBody({ data }: { data: DashboardView }) {
	return (
		<>
			<Stats data={data} />
			<div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] items-start gap-3.5">
				<div className="flex flex-col gap-3.5">
					<RunningPanel runs={data.running_runs} now={Date.parse(data.generated_at)} />
					<DashboardPanel title="运行趋势" aside={<TrendLegend />}>
						<div className="px-3.5 pt-3 pb-2.5">
							<TrendChart hours={data.hourly} />
						</div>
					</DashboardPanel>
					<PackagesPanel packages={data.recent_packages} />
				</div>
				<div className="flex flex-col gap-3.5">
					<FailuresPanel failures={data.recent_failures} />
					<AgentsPanel agents={data.agents.list} />
				</div>
			</div>
		</>
	);
}

// —— 统计卡 ——

function Stats({ data }: { data: DashboardView }) {
	const { runs, agents, hourly } = data;
	const offline = agents.list.filter((a) => a.status === "offline");
	return (
		<section aria-label="运行统计" className="mb-3.5 grid grid-cols-6 gap-2.5">
			<StatCard
				label={
					<>
						<StatusDot kind="running" className="text-signal" />
						运行中
					</>
				}
				name="运行中"
				value={runs.running}
				detail={`${runs.running_chains} 条链 · ${runs.running_tasks} 个任务执行中`}
			/>
			<StatCard
				name="成功"
				value={runs.success}
				valueClassName="text-ok"
				detail={<Sparkline values={hourly.map((h) => h.success)} className="text-ok" />}
			/>
			<StatCard
				name="失败"
				value={runs.failed}
				valueClassName="text-danger-fg"
				unit={runs.failed_subflows > 0 ? `含 ${runs.failed_subflows} 个子流程` : undefined}
				detail={<Sparkline values={hourly.map((h) => h.failed)} className="text-danger" />}
			/>
			<StatCard
				name="成功率"
				value={runs.success_rate === null ? "—" : (runs.success_rate * 100).toFixed(1)}
				unit={runs.success_rate === null ? undefined : "%"}
				detail={rateChange(runs.success_rate, runs.previous_success_rate)}
			/>
			<StatCard
				name="Agent 在线"
				value={agents.online}
				unit={`/ ${agents.list.length}`}
				detail={
					offline.length === 0 ? (
						agents.list.length === 0 ? (
							"还没有 Agent"
						) : (
							"全部在线"
						)
					) : (
						<span className="text-warn">{offline.map((a) => a.name).join("、")} 离线</span>
					)
				}
			/>
			<StatCard
				name="槽位占用"
				value={agents.used_slots}
				unit={`/ ${agents.slots}`}
				detail={`排队任务 ${runs.queued_tasks}`}
			/>
		</section>
	);
}

/** 与前 24 小时的成功率对比：`较前 24 小时 −3.1%`。 */
function rateChange(current: number | null, previous: number | null): string {
	if (current === null) return "最近 24 小时没有结束的运行";
	if (previous === null) return "前 24 小时没有结束的运行";
	const diff = (current - previous) * 100;
	const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
	return `较前 24 小时 ${sign}${Math.abs(diff).toFixed(1)}%`;
}

function StatCard({
	name,
	label,
	value,
	unit,
	valueClassName,
	detail,
}: {
	/** 可访问名称（统计项名称）。 */
	name: string;
	/** 显示的标签；默认同 name。 */
	label?: React.ReactNode;
	value: React.ReactNode;
	unit?: string;
	valueClassName?: string;
	detail?: React.ReactNode;
}) {
	return (
		<section
			aria-label={name}
			className="min-w-0 rounded-lg border border-border-soft bg-surface px-3.5 py-3"
		>
			<div className="flex items-center gap-1.5 text-xs text-fg-3">{label ?? name}</div>
			<div className={cn("mt-1.5 font-mono text-2xl font-semibold", valueClassName)}>
				{value}
				{unit && <small className="ml-1 text-xs font-normal text-fg-3">{unit}</small>}
			</div>
			{detail && <div className="mt-0.5 truncate text-2xs text-fg-3">{detail}</div>}
		</section>
	);
}

// —— 面板 ——

/** 控制台的面板：标题行（标题、计数、右侧操作）+ 内容；以标题作为区域名称。 */
function DashboardPanel({
	title,
	count,
	aside,
	children,
}: {
	title: string;
	count?: number;
	aside?: React.ReactNode;
	children: React.ReactNode;
}) {
	const id = useId();
	return (
		<Panel aria-labelledby={id}>
			<div className="flex h-11 items-center gap-2 border-b border-border-soft px-3.5">
				<h2 id={id} className="m-0 text-base font-semibold">
					{title}
				</h2>
				{count !== undefined && <span className="font-mono text-xs text-fg-3">{count}</span>}
				<span className="flex-1" />
				{aside}
			</div>
			{children}
		</Panel>
	);
}

/** 面板里的空状态：一行说明。 */
function PanelEmpty({ children }: { children: React.ReactNode }) {
	return <p className="m-0 px-3.5 py-6 text-center text-sm text-fg-3">{children}</p>;
}

const panelLink = (to: "/runs" | "/agents" | "/packages", label: string) => (
	<Button variant="ghost" size="sm" render={<Link to={to} />} nativeButton={false}>
		{label}
	</Button>
);

/** 面板里的一行可点击条目（原型 .rrow）。 */
const ROW =
	"group flex items-center gap-3 border-b border-border-soft px-3.5 py-2.5 text-fg-1 no-underline last:border-0 hover:bg-raised";

// —— 正在运行 ——

/** 当前节点：已派发、执行中、等待中或排队中的节点。 */
const CURRENT = new Set(["queued", "dispatched", "running", "waiting"]);

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

function RunningRow({ run, now }: { run: DashboardRunningRun; now: number }) {
	const current = run.chains.flatMap((c) =>
		c.nodes
			.filter((n) => CURRENT.has(n.status))
			.map((n) => ({ ...n, key: `${c.id}:${n.node_id}` })),
	);
	return (
		<Link to="/runs/$id" params={{ id: run.id }} className={ROW}>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					{run.cancelling ? (
						<StatusPill kind="cancelled">取消中</StatusPill>
					) : (
						<StatusPill kind="running">运行中</StatusPill>
					)}
					<b className="truncate font-medium">{run.orchestration_name}</b>
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
									<span
										className={cn(
											"font-mono",
											n.status === "queued" ? "text-fg-2" : "text-signal-fg",
										)}
									>
										{n.node_id}
									</span>
									{n.status === "queued" && "（排队）"}
								</span>
							))}
						</span>
					)}
				</div>
			</div>
			<ChainBars chains={run.chains} />
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
						{failure.subflow ? `子流程失败 · ${failure.chain_id}` : "失败"}
					</StatusPill>
					<b className="truncate font-medium">{failure.orchestration_name}</b>
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
								失败节点 <span className="font-mono text-fg-2">{failure.node_id}</span>
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
				<PanelEmpty>还没有 Agent 连接</PanelEmpty>
			) : (
				<Table aria-label="Agent 状态">
					<TableBody>
						{agents.map((agent) => (
							<TableRow key={agent.name}>
								<TableCell className="font-mono">
									<span className="inline-flex items-center gap-2">
										<StatusDot
											kind={
												agent.status === "offline" ? "pending" : agent.installing ? "warn" : "ok"
											}
											className={
												agent.status === "offline"
													? "text-pending"
													: agent.installing
														? "text-warn"
														: "text-ok"
											}
										/>
										{agent.name}
									</span>
								</TableCell>
								<TableCell>
									<SlotBar used={agent.used_slots} total={agent.slots} />
								</TableCell>
								<TableCell className="text-xs text-fg-3">{agentState(agent)}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</DashboardPanel>
	);
}

function agentState(agent: DashboardAgent): React.ReactNode {
	if (agent.status === "offline") return `离线 · ${formatDateTime(agent.last_seen_at)}`;
	if (agent.installing) {
		return (
			<span className="text-warn">
				正在安装 {agent.installing.package}@{agent.installing.version}
			</span>
		);
	}
	return "在线";
}

// —— 最近发布的节点包 ——

function PackagesPanel({ packages }: { packages: DashboardView["recent_packages"] }) {
	return (
		<DashboardPanel title="最近发布的节点包" aside={panelLink("/packages", "节点包管理")}>
			{packages.length === 0 ? (
				<PanelEmpty>还没有发布节点包</PanelEmpty>
			) : (
				<Table aria-label="最近发布的节点包">
					<TableBody>
						{packages.map((p) => (
							<TableRow key={`${p.name}@${p.version}`}>
								<TableCell className="font-mono">
									<Link
										to="/packages"
										search={{ name: p.name, version: p.version }}
										className="text-fg-1 no-underline hover:underline"
									>
										{p.name}
									</Link>
								</TableCell>
								<TableCell className="font-mono">{p.version}</TableCell>
								<TableCell className="text-xs text-fg-3">
									{formatDateTime(p.published_at)} ·{" "}
									{p.locked_orchestrations > 0
										? `${p.locked_orchestrations} 个场景锁定`
										: "未被锁定"}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</DashboardPanel>
	);
}

// —— 加载骨架 ——

function DashboardSkeleton() {
	return (
		<output aria-label="加载中" aria-busy="true" className="block">
			<div className="mb-3.5 grid grid-cols-6 gap-2.5">
				{Array.from({ length: 6 }, (_, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 骨架没有标识
					<div key={i} className="rounded-lg border border-border-soft bg-surface px-3.5 py-3">
						<Skeleton className="h-3 w-1/2" />
						<Skeleton className="mt-3 h-5 w-1/3" />
					</div>
				))}
			</div>
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
