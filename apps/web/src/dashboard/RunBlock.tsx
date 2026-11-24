import type { DashboardActiveNode, DashboardChain, DashboardRunningRun } from "@sfly/schema";
import { isOnAgentStatus } from "@sfly/schema";
import { Link } from "@tanstack/react-router";
import { ActivityIcon, ChevronDownIcon, ChevronUpIcon, WorkflowIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { activeDetail, activeOrder } from "#/components/active-node";
import { listChainLabel } from "#/components/chain-progress";
import { NodeName } from "#/components/node-name";
import { Panel } from "#/components/page";
import { type LineChain, RunLines, RunLineThumb } from "#/components/run-lines";
import { nodeStatusView, runStatusView, StatusDot, StatusPill } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { TriggeredAt } from "#/components/via-tag";
import { FocusReadoutStrip } from "#/focus/FocusReadout";
import { FocusSettingsLink } from "#/focus/FocusSettingsLink";
import { FocusTally } from "#/focus/FocusTally";
import { emptyReadingsNote } from "#/focus/focus-format";
import { useRunFocus } from "#/focus/use-run-focus";
import {
	ACTION,
	ACTIVE_LABEL,
	attemptLabel,
	ELAPSED_LABEL,
	FOCUS,
	LIST_LABEL,
	MESSAGE,
	MONITOR_VIEW_LABEL,
	moreLabel,
	RUNNING_PRIMARY_LABEL,
	TERM,
} from "#/lib/copy";
import { formatElapsed, shortId } from "#/lib/format";
import { useElementWidth } from "#/lib/use-element-width";
import { useNow } from "#/lib/use-now";
import { CancelRunButton } from "#/monitor/CancelRunDialog";
import { QueueWaitNote } from "#/monitor/QueueWaitNote";
import { runMonitorLink } from "#/monitor/run-link";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Truncate } from "@/components/ui/truncate";
import { readoutPlan } from "./wall-rules";

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
 * 下面依次是线路、读数（{@link RunReadout}）、进行中的节点那一行，以及「打开运行监控」「在画布中打开」「取消运行」。
 * `activeLimit` 限制进行中的节点和读数列几个（运行多时，见 wall-rules）；`onCollapse` 给了时是从紧凑行展开的，
 * 页头多一个「收起」。
 */
export function RunBlock({
	run,
	activeLimit,
	labelWidth,
	onCollapse,
	focusCollapse = false,
}: {
	run: DashboardRunningRun;
	activeLimit: number | null;
	/** 线路里链名那一列的宽度：上下排着的运行块用同一个，线路才从同一个横坐标开始（`labelColumnWidth`）。 */
	labelWidth?: string | undefined;
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
						<TriggeredAt by={run.triggered_by} via={run.triggered_via} at={run.started_at} />
					</div>
				</div>
				<div className="flex-none text-right">
					<span data-testid="run-elapsed" className="block font-mono text-2xl font-semibold">
						{formatElapsed(now - Date.parse(run.started_at))}
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
			<RunLines chains={lineChains(run.chains)} labelWidth={labelWidth} className="mt-3.5" />
			<RunReadout run={run} limit={activeLimit} />
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
					{ACTION.openInCanvas}
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
 * 运行块的读数区（`GET /runs/:id/focus?points=0`，只要最新值、异常和排序）。场景设了关注项是一排关注项读数，没设是准备中、
 * 执行中节点的主指标；两种都一样排：有异常的在最前，标题旁写「N 项需要注意」；按读数区的实际宽度放 3 或 4 格，有异常的总在
 * 里面，其余写「还有 N 个关注项（主指标）· 打开概览」；点一格进入运行监控概览并定位到它所在的节点。3 个以上运行时只放前
 * `limit` 项（有异常的加上前两项，见 wall-rules 的 `readoutPlan`）。标题行右侧总有去「关注项」页的入口；没设关注项时标题旁写明。
 * 没有可显示的读数时写原因，读取失败时写「无法加载关注项」，都保留标题行。还没读到时不画这一块。
 */
function RunReadout({ run, limit }: { run: DashboardRunningRun; limit: number | null }) {
	const focus = useRunFocus(run.id, { live: true, points: 0 });
	const [measure, width] = useElementWidth<HTMLElement>();
	const data = focus.data;
	if (!data) {
		if (!focus.isError) return null;
		return (
			<section aria-label={TERM.focusItem} className="mt-3">
				<ReadoutHeading
					title={TERM.focusItem}
					orchestrationId={run.orchestration_id}
					configured={null}
				>
					<RuleLine />
				</ReadoutHeading>
				<p className="m-0 text-xs text-fg-3">{MESSAGE.loadFailed(TERM.focusItem)}</p>
			</section>
		);
	}
	const primary = data.mode === "primary";
	const title = primary ? RUNNING_PRIMARY_LABEL : TERM.focusItem;
	const { shown, more, columns } = readoutPlan(data.items, width, limit);
	const executing = run.active_nodes.some((node) => isOnAgentStatus(node.status));
	return (
		<section ref={measure} aria-label={title} className="mt-3">
			<ReadoutHeading title={title} orchestrationId={run.orchestration_id} configured={!primary}>
				<FocusTally items={data.items} showCount={!primary} />
				<RuleLine />
				{primary && <span>{FOCUS.noneSet} ·</span>}
			</ReadoutHeading>
			{data.items.length === 0 ? (
				<p className="m-0 text-xs text-fg-3">{emptyReadingsNote(data.mode, executing)}</p>
			) : (
				<FocusReadoutStrip
					items={shown}
					generatedAt={data.generated_at}
					columns={columns}
					className="rounded-md border border-border-soft"
					renderItem={(item) => (
						<Link {...runMonitorLink(run.id, { view: "overview", node: item.node_id })} />
					)}
					trailing={
						more > 0 && (
							<Link
								{...runMonitorLink(run.id, { view: "overview" })}
								className="flex h-full min-w-0 items-center px-3 py-2 text-xs text-fg-2 no-underline hover:bg-fg-1/3 hover:text-fg-1"
							>
								<span>
									<span className="whitespace-nowrap">
										{primary ? FOCUS.morePrimary(more) : FOCUS.moreItems(more)}
									</span>{" "}
									· <span className="whitespace-nowrap">打开{MONITOR_VIEW_LABEL.overview}</span>
								</span>
							</Link>
						)
					}
				/>
			)}
		</section>
	);
}

/**
 * 读数区的标题行：标题、`children`（计数、分隔线、说明），右边是去场景设置「关注项」页的链接（读取失败时不知道
 * 场景设没设关注项，`configured` 是 null）。
 */
function ReadoutHeading({
	title,
	orchestrationId,
	configured,
	children,
}: {
	title: string;
	orchestrationId: string;
	configured: boolean | null;
	children: ReactNode;
}) {
	return (
		<div className="mb-1.5 flex items-center gap-2 text-xs text-fg-3">
			<h4 className="m-0 text-xs font-normal">{title}</h4>
			{children}
			<FocusSettingsLink orchestrationId={orchestrationId} configured={configured} />
		</div>
	);
}

const RuleLine = () => <span aria-hidden className="h-px min-w-4 flex-1 bg-border-soft" />;

/**
 * 进行中的节点那一行：节点、Agent、尝试号、已执行时长；准备中、排队中写状态。
 * 给了 `limit` 时只列前几个，其余写「还有 N 个」。
 */
function ActiveNodes({
	nodes,
	limit,
	now,
}: {
	nodes: readonly DashboardActiveNode[];
	limit: number | null;
	now: number;
}) {
	if (nodes.length === 0) return null;
	const ordered = [...nodes].sort((a, b) => activeOrder(a) - activeOrder(b));
	const shown = limit === null ? ordered : ordered.slice(0, limit);
	return (
		<div className="mt-3 flex items-baseline gap-x-4 border-t border-border-soft pt-2.5 text-xs">
			<span className="flex-none text-fg-3">{ACTIVE_LABEL}</span>
			<ul
				aria-label={LIST_LABEL.activeNodes}
				className="m-0 flex min-w-0 flex-1 list-none flex-wrap gap-x-5 gap-y-1 p-0"
			>
				{shown.map((node) => {
					const waiting = node.status === "queued" ? node.queue_wait : null;
					return (
						<li
							key={`${node.chain_instance_id}/${node.node_id}`}
							// 排队中的节点写着在等谁，一句话比较长：单独占一行（和运行监控概览一样）。
							className={
								waiting
									? "flex basis-full items-baseline gap-1.5"
									: "flex min-w-0 items-center gap-1.5"
							}
						>
							<StatusDot
								kind={nodeStatusView(node.status).kind}
								className={waiting ? "self-center" : undefined}
							/>
							<NodeName node={node} className="flex-none font-medium text-fg-1" />
							{waiting && node.queued_at ? (
								<span className="min-w-0 text-fg-3">
									{attemptLabel(node.attempt)} · {nodeStatusView(node.status).label} ·{" "}
									<QueueWaitNote wait={waiting} queuedAt={node.queued_at} now={now} />
								</span>
							) : (
								<span className="whitespace-nowrap text-fg-3">
									<UntrustedText dir="ltr" text={activeDetail(node, now)} />
								</span>
							)}
						</li>
					);
				})}
				{shown.length < nodes.length && (
					<li className="text-fg-3">{moreLabel(nodes.length - shown.length)}</li>
				)}
			</ul>
		</div>
	);
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
	const current = [...run.active_nodes].sort((a, b) => activeOrder(a) - activeOrder(b))[0];
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
					{formatElapsed(now - Date.parse(run.started_at))}
				</span>
				<ChevronDownIcon aria-hidden className="size-4 flex-none text-fg-3" />
			</Truncate>
		</article>
	);
}
