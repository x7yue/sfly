import { type AgentView, agentsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useId } from "react";
import { acceptsTasks, agentStatusView } from "#/agents/agent-status";
import { PreparingBadge } from "#/agents/PreparingBadge";
import { ErrorState } from "#/components/feedback/states";
import { IdleSlots, idleSlotCount, SlotCell } from "#/components/slot-cell";
import { STATUS, StatusDot } from "#/components/status";
import { apiQuery } from "#/lib/api";
import { AGENT_STATUS_LABEL, MESSAGE, queuedLabel, slotUsageLabel, TERM } from "#/lib/copy";
import { STATUS_POLL_MS } from "#/lib/polling";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardPanel } from "./DashboardPanel";
import { PanelLink } from "./panel-link";
import { agentColumn } from "./wall-rules";

/**
 * 右栏的 Agent：每台 Agent 的槽位格（紧凑形式），按派发顺序列出正在执行的任务，连续的空闲槽合并成一行，下面是排队数；
 * 不重复关注项的数值（只在运行块里出现一次）。数据是 Agent 列表接口，和 Agent 管理页共用查询缓存。
 * Agent 很多时只列需要看的，其余合并成「N 台空闲」（wall-rules）。
 */
export function AgentsPanel() {
	const agents = useQuery({ ...apiQuery(agentsApi.list), refetchInterval: STATUS_POLL_MS });
	const list = agents.data?.agents ?? [];
	const online = list.filter((a) => a.status === "online").length;
	const { listed, idle } = agentColumn(list);
	return (
		<DashboardPanel
			title={TERM.agent}
			count={agents.data && `${online} / ${list.length} ${AGENT_STATUS_LABEL.online}`}
			aside={<PanelLink to="/agents">管理</PanelLink>}
		>
			{agents.data && list.length === 0 ? (
				<div className="flex flex-col gap-1 px-3.5 py-3 text-xs">
					<p className="m-0 text-fg-2">{MESSAGE.noAgents}</p>
					<Link to="/agents" className="text-fg-1">
						{MESSAGE.agentInstallLink}
					</Link>
				</div>
			) : agents.data ? (
				<div className="divide-y divide-border-soft">
					{listed.map((agent) => (
						<AgentSlots key={agent.name} agent={agent} />
					))}
					{idle > 0 && <p className="m-0 px-3.5 py-2.5 text-xs text-fg-3">{idle} 台空闲</p>}
				</div>
			) : agents.isError ? (
				<div className="p-3.5">
					<ErrorState
						title="无法加载 Agent 列表"
						error={agents.error}
						onRetry={() => void agents.refetch()}
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

/**
 * 一台 Agent：名称行（状态点、名称、版本；不是「在线」时写状态文字，准备环境中写「准备环境中」；能接新任务时写占用数），
 * 下面是槽位格和排队数。接不了新任务的 Agent（`acceptsTasks`）槽位不算空闲：不画空闲矮条、不写占用数（同 Agent 管理页的机架）。
 */
function AgentSlots({ agent }: { agent: AgentView }) {
	const headingId = useId();
	const status = agentStatusView(agent);
	const accepts = acceptsTasks(agent);
	const used = agent.running_tasks.length;
	const idle = idleSlotCount(agent.info.slots, used);
	const queued = agent.queued_tasks.length;
	return (
		<section aria-labelledby={headingId} className="px-3.5 pt-2.5 pb-3">
			<div className="flex items-center gap-2">
				<StatusDot kind={status.kind} />
				<h3 id={headingId} className="m-0 font-mono text-sm font-medium">
					{agent.name}
				</h3>
				<span className="font-mono text-xs text-fg-3">{agent.info.agent_version || "—"}</span>
				{status.kind === "ok" ? (
					<span className="sr-only">{status.label}</span>
				) : (
					<span className={cn("text-xs", STATUS[status.kind].text)}>{status.label}</span>
				)}
				{agent.status === "online" && agent.preparing_since && (
					<PreparingBadge since={agent.preparing_since} />
				)}
				<span className="flex-1" />
				{accepts && (
					<span className="font-mono text-xs text-fg-2">
						{slotUsageLabel(used, agent.info.slots)}
					</span>
				)}
			</div>
			{(used > 0 || (accepts && idle > 0)) && (
				<ul aria-labelledby={headingId} className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
					{agent.running_tasks.map((task) => (
						<SlotCell key={task.task_id} task={task} compact />
					))}
					{accepts && idle > 0 && <IdleSlots count={idle} compact />}
				</ul>
			)}
			{queued > 0 && <p className="m-0 mt-2 text-xs text-fg-3">{queuedLabel(queued)}</p>}
		</section>
	);
}
