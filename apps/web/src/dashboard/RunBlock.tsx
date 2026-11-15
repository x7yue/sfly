import type { DashboardChain, DashboardRunningRun, RunListActiveNode } from "@sfly/schema";
import { isOnAgentStatus } from "@sfly/schema";
import { Link } from "@tanstack/react-router";
import { ActivityIcon, ChevronDownIcon, ChevronUpIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { listChainLabel } from "#/components/chain-progress";
import { NodeName } from "#/components/node-name";
import { Panel } from "#/components/page";
import { type LineChain, RunLines, RunLineThumb } from "#/components/run-lines";
import { nodeStatusView, runStatusView, StatusDot, StatusPill } from "#/components/status";
import { FocusReadoutStrip } from "#/focus/FocusReadout";
import { useRunFocus } from "#/focus/use-run-focus";
import {
	ACTION,
	ACTIVE_LABEL,
	ELAPSED_LABEL,
	LIST_LABEL,
	moreLabel,
	RUNNING_PRIMARY_LABEL,
	TERM,
} from "#/lib/copy";
import { formatClock, formatDateTime, formatDuration, shortId } from "#/lib/format";
import { useNow } from "#/lib/use-now";
import { CancelRunButton } from "#/monitor/CancelRunDialog";
import { runMonitorLink } from "#/monitor/run-link";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Truncate } from "@/components/ui/truncate";

/** 控制台统计里的链实例换成线路的输入。 */
export const lineChains = (chains: readonly DashboardChain[]): LineChain[] =>
	chains
		.filter((chain) => chain.nodes.length > 0)
		.map((chain) => ({
			id: chain.id,
			label: listChainLabel(chain),
			parent_chain_instance_id: chain.parent_chain_instance_id,
			async_node_id: chain.async_node_id,
			nodes: chain.nodes,
		}));

/**
 * 运行块（外壳页方案 4.1）：场景、版本、运行编号、触发人和开始时间，右上角是全站唯一的大号「已运行」时长；
 * 下面依次是线路、读数（{@link RunReadout}）、进行中的节点那一行，以及「打开运行监控」「在画布中查看」「取消运行」。
 * `activeLimit` 限制进行中的节点和读数列几个（运行多时，见 wall-rules）；`onCollapse` 给了时是从紧凑行展开的，
 * 页头多一个「收起」。
 */
export function RunBlock({
	run,
	activeLimit,
	onCollapse,
	focusCollapse = false,
}: {
	run: DashboardRunningRun;
	activeLimit: number | null;
	onCollapse?: () => void;
	/** 刚展开：焦点放到「收起」上（展开按钮已经换成了这个运行块）。 */
	focusCollapse?: boolean;
}) {
	const now = useNow(true);
	const status = runStatusView("running", { cancelling: run.cancelling });
	const headingId = useId();
	const collapse = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (focusCollapse) collapse.current?.focus();
	}, [focusCollapse]);
	return (
		<Panel aria-labelledby={headingId} className="border-border px-4 pt-3.5 pb-3">
			<div className="flex items-start gap-2.5">
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
						<StatusPill kind={status.kind} pulse>
							{status.label}
						</StatusPill>
						<h3 id={headingId} className="m-0 min-w-0 truncate text-base font-semibold">
							{run.orchestration_name}
						</h3>
						<Badge className="font-mono">v{run.orchestration_version}</Badge>
						<span data-slot="run-id" className="font-mono text-xs text-fg-3">
							{shortId(run.id)}
						</span>
					</div>
					<div className="mt-0.5 text-xs text-fg-3">
						{run.triggered_by} 触发 · 开始{" "}
						<span className="font-mono">{formatDateTime(run.started_at)}</span>
					</div>
				</div>
				<div className="flex-none text-right">
					<span data-testid="run-elapsed" className="block font-mono text-2xl font-semibold">
						{formatDuration(now - Date.parse(run.started_at))}
					</span>
					<span className="text-xs text-fg-3">{ELAPSED_LABEL}</span>
				</div>
				{onCollapse && (
					<Button
						ref={collapse}
						variant="ghost"
						size="icon-sm"
						aria-label={ACTION.collapse}
						aria-expanded
						onClick={onCollapse}
					>
						<ChevronUpIcon />
					</Button>
				)}
			</div>
			<RunLines chains={lineChains(run.chains)} className="mt-3.5" />
			<RunReadout runId={run.id} limit={activeLimit} />
			<ActiveNodes nodes={run.active_nodes} limit={activeLimit} now={now} />
			<div className="mt-2.5 flex gap-1.5">
				<Link {...runMonitorLink(run.id, {})} className={buttonVariants({ size: "sm" })}>
					<ActivityIcon />
					{ACTION.openRun}
				</Link>
				<Link
					to="/orchestrations/$id"
					params={{ id: run.orchestration_id }}
					search={{ run: run.id }}
					className={buttonVariants({ variant: "ghost", size: "sm" })}
				>
					<WorkflowIcon />
					{ACTION.viewInCanvas}
				</Link>
				<CancelRunButton
					size="sm"
					variant="ghost"
					runId={run.id}
					orchestrationId={run.orchestration_id}
					orchestrationVersion={run.orchestration_version}
					cancelling={run.cancelling}
				/>
			</div>
		</Panel>
	);
}

/**
 * 运行块的读数：现在是场景没设关注项时执行中节点的主指标（`GET /runs/:id/focus?points=0` 的 primary），
 * 设了关注项的场景这里暂时不显示（关注项读数由 #366 接在这里）。`limit` 同进行中的节点。
 */
function RunReadout({ runId, limit }: { runId: string; limit: number | null }) {
	const focus = useRunFocus(runId, { live: true, points: 0 });
	const data = focus.data;
	if (data?.mode !== "primary" || data.items.length === 0) return null;
	const items = limit === null ? data.items : data.items.slice(0, limit);
	return (
		<section aria-label={RUNNING_PRIMARY_LABEL} className="mt-3">
			<h4 className="m-0 mb-1.5 flex items-center gap-2 text-xs font-normal text-fg-3 after:h-px after:flex-1 after:bg-border-soft">
				{RUNNING_PRIMARY_LABEL}
			</h4>
			<FocusReadoutStrip
				items={items}
				generatedAt={data.generated_at}
				className="rounded-md border border-border-soft"
			/>
		</section>
	);
}

/** 先执行中（含准备中），再排队、等待；同一类按链与链上的顺序。 */
const ORDER = (node: RunListActiveNode) =>
	isOnAgentStatus(node.status) ? 0 : node.status === "queued" ? 1 : 2;

/**
 * 进行中的节点那一行：节点、Agent、尝试号、已执行时长；准备中、排队中写状态，等待节点写唤醒时间。
 * 给了 `limit` 时只列前几个，其余写「还有 N 个」。
 */
function ActiveNodes({
	nodes,
	limit,
	now,
}: {
	nodes: readonly RunListActiveNode[];
	limit: number | null;
	now: number;
}) {
	if (nodes.length === 0) return null;
	const ordered = [...nodes].sort((a, b) => ORDER(a) - ORDER(b));
	const shown = limit === null ? ordered : ordered.slice(0, limit);
	return (
		<div className="mt-3 flex items-baseline gap-x-4 border-t border-border-soft pt-2.5 text-xs">
			<span className="flex-none text-fg-3">{ACTIVE_LABEL}</span>
			<ul
				aria-label={LIST_LABEL.activeNodes}
				className="m-0 flex min-w-0 list-none flex-wrap gap-x-5 gap-y-1 p-0"
			>
				{shown.map((node) => (
					<li
						key={`${node.chain_instance_id}/${node.node_id}`}
						className="flex min-w-0 items-center gap-1.5"
					>
						<StatusDot kind={nodeStatusView(node.status).kind} />
						<NodeName node={node} className="font-medium text-fg-1" />
						<span className="whitespace-nowrap text-fg-3">{activeDetail(node, now)}</span>
					</li>
				))}
				{shown.length < nodes.length && (
					<li className="text-fg-3">{moreLabel(nodes.length - shown.length)}</li>
				)}
			</ul>
		</div>
	);
}

/** 「agent-a · 尝试 2 · 1m 05s」；还没开始执行写状态，等待节点写「等待中 · 唤醒 10:30:00」。 */
function activeDetail(node: RunListActiveNode, now: number): string {
	const status = nodeStatusView(node.status);
	if (node.agent === null) {
		return node.wake_at === null
			? status.label
			: `${status.label} · 唤醒 ${formatClock(node.wake_at)}`;
	}
	const time =
		node.started_at === null ? status.label : formatDuration(now - Date.parse(node.started_at));
	return `${node.agent} · ${TERM.attempt} ${node.attempt} · ${time}`;
}

/**
 * 紧凑行（6 个以上运行时）：场景、运行编号、主链的线路缩略、当前节点、已运行，整行是展开按钮。
 * 紧凑行不取读数；展开后换成运行块。
 */
export function CompactRunRow({
	run,
	onExpand,
	focusExpand = false,
}: {
	run: DashboardRunningRun;
	onExpand: () => void;
	/** 刚收起：焦点放回这一行（运行块已经换回了它）。 */
	focusExpand?: boolean;
}) {
	const now = useNow(true);
	const status = runStatusView("running", { cancelling: run.cancelling });
	const button = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (focusExpand) button.current?.focus();
	}, [focusExpand]);
	const [main] = lineChains(run.chains);
	const current = [...run.active_nodes].sort((a, b) => ORDER(a) - ORDER(b))[0];
	return (
		<article
			aria-label={`${TERM.run} ${shortId(run.id)}`}
			className="rounded-lg border border-border bg-surface"
		>
			<Truncate
				label={run.orchestration_name}
				render={
					<button
						ref={button}
						type="button"
						aria-expanded={false}
						onClick={onExpand}
						className="flex h-10 w-full min-w-0 items-center gap-3 rounded-lg px-3.5 text-left hover:bg-fg-1/3"
					/>
				}
			>
				<StatusPill kind={status.kind} pulse>
					{status.label}
				</StatusPill>
				<span className="flex min-w-0 flex-1 items-baseline gap-2">
					<Truncate className="font-semibold">{run.orchestration_name}</Truncate>
					<span data-slot="run-id" className="flex-none font-mono text-xs text-fg-3">
						{shortId(run.id)}
					</span>
				</span>
				{main && <RunLineThumb chain={main} />}
				<span className="flex w-40 min-w-0 flex-none items-center gap-1.5 text-xs">
					{current && (
						<>
							<StatusDot kind={nodeStatusView(current.status).kind} />
							<NodeName node={current} className="text-fg-1" />
							{run.active_nodes.length > 1 && (
								<span className="flex-none font-mono text-fg-3">
									+{run.active_nodes.length - 1}
								</span>
							)}
						</>
					)}
				</span>
				<span className="w-16 flex-none text-right font-mono text-sm">
					<span className="sr-only">{ELAPSED_LABEL} </span>
					{formatDuration(now - Date.parse(run.started_at))}
				</span>
				<ChevronDownIcon aria-hidden className="size-4 flex-none text-fg-3" />
			</Truncate>
		</article>
	);
}
