import type { AgentView, QueuedTaskView } from "@sfly/schema";
import { cn } from "cn";
import { useId } from "react";
import { agentAnchor } from "#/agents/agent-anchor";
import { acceptsTasks, agentStatusView, updateStatus } from "#/agents/agent-status";
import { PreparingBadge } from "#/agents/PreparingBadge";
import { queueTiming } from "#/agents/queue-timing";
import { TaskSlot } from "#/agents/TaskSlot";
import { canUpdateNow, UpdateNowButton } from "#/agents/UpdateNowButton";
import type { FocusByRun } from "#/agents/use-slot-focus";
import { NodeName } from "#/components/node-name";
import { Panel } from "#/components/page";
import { IdleSlots, idleSlotCount, taskChainLabel } from "#/components/slot-cell";
import { nodeStatusView, StatusDot, StatusPill } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { attemptLabel, queuedLabel, slotUsageLabel, TERM } from "#/lib/copy";
import { formatClockOffset, formatDateTime, formatFullDateTime, shortId } from "#/lib/format";
import { useNow } from "#/lib/use-now";
import { Truncate } from "@/components/ui/truncate";

/**
 * 一台 Agent 的机架面板（外壳页方案 4.1）：头部一行是状态、名称、版本、系统、对外地址和最后在线，状态后面跟着各种告警，
 * 右侧是被引用的场景数和「立即更新」；主体是槽位格，格子下面是排队的任务；底部是节点包与能力。
 * 接不了新任务的 Agent（离线、准备环境中、版本不一致或更新中，`acceptsTasks`）槽位不算空闲，所以不画空闲矮条、不写占用数。
 */
export function AgentRack({
	agent,
	controlPlaneVersion,
	runFocus,
}: {
	agent: AgentView;
	controlPlaneVersion: string;
	/** 占着槽位的任务所属运行的关注项读数（页面按运行读好，`useSlotFocus`）。 */
	runFocus: FocusByRun;
}) {
	const headingId = useId();
	const slotsHeadingId = useId();
	const slots = agent.info.slots;
	const used = agent.running_tasks.length;
	const queued = agent.queued_tasks.length;
	const accepts = acceptsTasks(agent);
	const idle = idleSlotCount(slots, used);
	// 接不了新任务的 Agent 槽位不算空闲：不画空闲矮条、不写占用数；没有任务还占着槽位时槽位一栏整个不画。
	const showSlots = accepts || used > 0;
	const hasBody = showSlots || queued > 0;
	const packages = [
		...agent.installed_packages.map((p) => `${p.name}@${p.version}`),
		...agent.dev_packages.map((p) => `${p.name}@dev`),
	];
	return (
		<Panel
			id={agentAnchor(agent.name)}
			aria-labelledby={headingId}
			className="scroll-mt-4 target:border-border-strong"
		>
			<header className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-b border-border-soft px-4 py-3">
				<RackStatus agent={agent} />
				<h2 id={headingId} className="m-0 font-mono text-base font-semibold">
					<UntrustedText text={agent.name} />
				</h2>
				<RackFacts agent={agent} controlPlaneVersion={controlPlaneVersion} />
				<span className="flex-1" />
				<span className="text-xs text-fg-3">
					{agent.referencing_orchestrations > 0
						? `被 ${agent.referencing_orchestrations} 个${TERM.scenario}引用`
						: "未被引用"}
				</span>
				{canUpdateNow(agent) && (
					<UpdateNowButton agent={agent} controlPlaneVersion={controlPlaneVersion} />
				)}
			</header>
			{hasBody && (
				<div className="flex flex-col gap-3 px-4 pt-3 pb-3.5">
					{showSlots && (
						<div>
							<div className="mb-2 flex items-center gap-2">
								<h3 id={slotsHeadingId} className="m-0 text-xs font-medium text-fg-2">
									槽位
								</h3>
								{accepts && (
									<span className="font-mono text-xs text-fg-3">
										{slotUsageLabel(used, slots)} · {queuedLabel(queued)}
									</span>
								)}
							</div>
							<ul
								aria-labelledby={slotsHeadingId}
								className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(300px,1fr))] items-start gap-2 p-0"
							>
								{agent.running_tasks.map((task) => (
									<TaskSlot key={task.task_id} task={task} runFocus={runFocus.get(task.run_id)} />
								))}
								{accepts && idle > 0 && <IdleSlots count={idle} />}
							</ul>
						</div>
					)}
					{queued > 0 && <QueuedTasks tasks={agent.queued_tasks} />}
				</div>
			)}
			<dl
				className={cn(
					"m-0 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1 border-border-soft px-4 py-2.5 text-xs",
					hasBody && "border-t",
				)}
			>
				<dt className="text-fg-3">{TERM.nodePackage}</dt>
				<dd className="m-0 text-fg-2">
					<IdentifierList items={packages} />
				</dd>
				<dt className="text-fg-3">能力</dt>
				<dd className="m-0 text-fg-2">
					<IdentifierList items={agent.capabilities.map((c) => `${c.name} v${c.version}`)} />
				</dd>
			</dl>
		</Panel>
	);
}

/**
 * 状态（在线、离线，更新中、更新失败这些优先）和跟在它后面的告警：准备环境、更新的说明、安装、时钟偏差、
 * 能力不能被其它 Agent 调用、节点包安装失败。
 */
function RackStatus({ agent }: { agent: AgentView }) {
	const online = agent.status === "online";
	const update = online ? updateStatus(agent) : undefined;
	const installing = online && agent.install?.state === "installing";
	const failed = agent.install?.state === "failed";
	// 时钟偏差只在达到阈值时提示（由接口判断）；离线 Agent 的偏差是断开前测的，不显示。
	const clockOffset = online && agent.clock_offset?.exceeds_threshold ? agent.clock_offset : null;
	// 能力不能被其它 Agent 调用的原因（端口被占用等）只对在线、监听端口的 Agent 提示：离线时本来就调用不了；
	// 不监听端口的旧版本 Agent 也没有能力（能力显示「无」），不再重复说明。
	const unavailable =
		online && agent.endpoint.port !== null ? agent.endpoint.unavailable_reason : null;
	const status = agentStatusView(agent);
	return (
		<div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
			<StatusPill kind={status.kind}>{status.label}</StatusPill>
			{online && agent.preparing_since && <PreparingBadge since={agent.preparing_since} />}
			{update?.detail && (
				<span className={cn("text-xs", update.kind === "failed" ? "text-danger-fg" : "text-fg-3")}>
					<UntrustedText text={update.detail} />
				</span>
			)}
			{!update && installing && agent.install && (
				<span className="font-mono text-2xs text-fg-3">
					<UntrustedText text={`${agent.install.package}@${agent.install.version}`} />
				</span>
			)}
			{clockOffset && (
				<span
					className="text-xs text-warn-fg"
					title={`Agent 时间与控制面时间不一致，测于 ${formatFullDateTime(clockOffset.measured_at)}`}
				>
					时间比控制面{formatClockOffset(clockOffset.offset_ms)}
				</span>
			)}
			{unavailable !== null && (
				<span className="text-xs">
					<span className="text-warn-fg">不能被其它 Agent 调用</span>
					<span className="text-fg-3">
						{" "}
						· <UntrustedText text={unavailable} />
					</span>
				</span>
			)}
			{failed && agent.install && (
				<span className="text-xs text-danger-fg">
					安装 <UntrustedText text={`${agent.install.package}@${agent.install.version}`} /> 失败
				</span>
			)}
		</div>
	);
}

/** 版本、系统、对外地址、最后在线。 */
function RackFacts({
	agent,
	controlPlaneVersion,
}: {
	agent: AgentView;
	controlPlaneVersion: string;
}) {
	const online = agent.status === "online";
	return (
		<div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-0.5 text-xs text-fg-3">
			<span className="font-mono text-fg-2">
				<UntrustedText text={agent.info.agent_version || "—"} />
			</span>
			{online && agent.version_mismatch && <span>控制面 {controlPlaneVersion}</span>}
			<span className="font-mono text-fg-2">
				<UntrustedText text={`${agent.info.os || "?"}/${agent.info.arch || "?"}`} />
			</span>
			<span>
				对外地址{" "}
				<span className="font-mono text-fg-2">
					<UntrustedText text={endpointLabel(agent.endpoint) || "—"} />
				</span>
				{agent.endpoint.address_source === "configured" && " · 安装时配置"}
			</span>
			<span>
				最后在线{" "}
				{online ? "现在" : <span className="font-mono">{formatDateTime(agent.last_seen_at)}</span>}
			</span>
		</div>
	);
}

/** 排队的任务，按排队顺序：写排队了多久、多久后排队超时，看得出是不是槽位不够。 */
function QueuedTasks({ tasks }: { tasks: QueuedTaskView[] }) {
	const now = useNow(true);
	const headingId = useId();
	return (
		<div>
			<div className="mb-1.5 flex items-center gap-2">
				<h3 id={headingId} className="m-0 text-xs font-medium text-fg-2">
					排队的任务
				</h3>
				<span className="font-mono text-xs text-fg-3">{tasks.length}</span>
			</div>
			<ul aria-labelledby={headingId} className="m-0 flex list-none flex-col gap-1 p-0">
				{tasks.map((task) => (
					<li
						key={task.task_id}
						className="flex min-w-0 items-center gap-2 rounded-md border border-border-soft bg-bg px-3 py-1.5 text-xs"
					>
						<StatusDot kind={nodeStatusView("queued").kind} />
						<NodeName node={task} className="text-sm" />
						<span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-fg-3">
							<Truncate>{`${task.orchestration_name} · ${taskChainLabel(task)} · ${attemptLabel(task.attempt)}`}</Truncate>
							<span className="flex-none font-mono text-2xs">{shortId(task.run_id)}</span>
						</span>
						<span className="flex-none text-fg-2">{queueTiming(task, now)}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/** 每项 `nowrap`：浏览器会在连字符处折行，`sfly-stub@0.1.0` 会被拆成两行。 */
function IdentifierList({ items }: { items: readonly string[] }) {
	if (items.length === 0) return <span className="text-fg-3">无</span>;
	return (
		<span className="font-mono">
			{items.map((item, i) => (
				<span key={item} className="whitespace-nowrap">
					<UntrustedText text={item} />
					{i < items.length - 1 && "、"}
				</span>
			))}
		</span>
	);
}

/** 其它 Agent 连接它用的 `地址:端口`（IPv6 地址加方括号）；没有端口（旧版本 Agent）时只有地址。 */
function endpointLabel({ address, port }: AgentView["endpoint"]): string {
	if (port === null) return address;
	return `${address.includes(":") ? `[${address}]` : address}:${port}`;
}
