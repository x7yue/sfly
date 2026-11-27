import {
	type AttemptView,
	isActiveStatus,
	isOnAgentStatus,
	type NodeRunView,
	type QueueWaitView,
	type RunFocus,
	type RunFocusItem,
	type RunView,
} from "@sfly/schema";
import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { type CurrentActivity, currentActivity } from "#/actions/current-activity";
import { activeDetail, activeOrder } from "#/components/active-node";
import { ErrorState } from "#/components/feedback/states";
import { NodeName } from "#/components/node-name";
import { RunLines } from "#/components/run-lines";
import { nodeStatusView, StatusDot } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { FocusChart } from "#/focus/FocusChart";
import { FocusReadoutStrip } from "#/focus/FocusReadout";
import { FocusSettingsLink } from "#/focus/FocusSettingsLink";
import { emptyReadingsNote } from "#/focus/focus-format";
import { useRunFocus } from "#/focus/use-run-focus";
import {
	ACTIVE_LABEL,
	attemptLabel,
	chainCountLabel,
	FOCUS,
	LIST_LABEL,
	MESSAGE,
	moreLabel,
	NODE_ACTIONS,
	QUEUE_WAIT,
	RUNNING_PRIMARY_LABEL,
	TERM,
} from "#/lib/copy";
import { Skeleton } from "@/components/ui/skeleton";
import { Truncate } from "@/components/ui/truncate";
import { Attention, OtherWarnings } from "./Attention";
import { FailureAnnouncer, FailureArea } from "./FailureArea";
import { useTimeAxis } from "./monitor-state";
import { QueueWaitNote } from "./QueueWaitNote";
import type { PanelTab } from "./run-link";
import { chainLabelParts, orderedChains } from "./run-model";
import { StatusLegend } from "./StatusLegend";
import { statusLegend } from "./status-legend";

/**
 * 概览里点一项要去详情里看的地方：节点（所在的子流程还没触发时没有链实例），可以再指定底部面板的页签，
 * 以及日志要定位的时刻（控制面时间，与 API 的 `Timestamp` 同写法）。
 */
export interface OverviewTarget {
	chainInstanceId: string | null;
	nodeId: string;
	tab?: PanelTab;
	at?: string;
}

/**
 * 运行监控的「概览」：从上到下是失败区域（运行里已有节点失败时才有，FailureArea.tsx）、链路（各链的进度和进行中的节点）、「需要注意」（只在有异常时出现）、关注项（数值类排成
 * 一条读数，图表类两列排开，有异常的排在前面）和其他警告与错误。点任何一项都进入「详情」并定位到来源节点
 * （`onOpenNode`），「需要注意」的直达按钮还定位到那一行日志或那个页签。数据是 `GET /runs/:id/focus`，运行中每 2 秒
 * 重新读取。场景没设关注项时显示执行中节点的主指标，并给出「设置关注项」的入口。
 * `located` 是地址里的 `node`（控制台运行块的读数进来时带上）：属于这个节点的关注项标出位置（`aria-current="location"`，
 * 中性高亮），第一项滚到视野里；版面变高或可视区域变小时重新对准，直到用户自己滚动或点按页面。
 */
export function Overview({
	run,
	onOpenNode,
	located,
}: {
	run: RunView;
	onOpenNode: (target: OverviewTarget) => void;
	located?: string;
}) {
	const focus = useRunFocus(run.id, { live: run.status === "running" });
	const container = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	// 用户自己滚动或点按过页面以后不再替他对准（同时间线的跟随定位，#359）；换了要定位的节点重新开始。
	const touched = useRef(false);
	const target = useRef<string | undefined>(undefined);
	const loaded = focus.data !== undefined;
	// 读数到了以后对准一次；之后内容变高（图表、日志读到了）或可视区域变小（窗口缩放）时再对准（ResizeObserver），
	// 每 2 秒重新读取时尺寸不变，不动页面。
	useEffect(() => {
		if (located === undefined || !loaded) return;
		if (target.current !== located) {
			target.current = located;
			touched.current = false;
		}
		const align = () => {
			if (touched.current) return;
			container.current
				?.querySelector('[aria-current="location"]')
				?.scrollIntoView({ block: "nearest" });
		};
		align();
		const observer = new ResizeObserver(align);
		for (const el of [container.current, content.current]) if (el) observer.observe(el);
		return () => observer.disconnect();
	}, [located, loaded]);
	const stop = () => {
		touched.current = true;
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: 只记下用户自己滚动、点按过，之后不再替他对准；元素本身不可操作
		<div
			ref={container}
			onWheel={stop}
			onPointerDown={stop}
			onKeyDown={stop}
			onTouchStart={stop}
			className="min-h-0 flex-1 overflow-auto bg-bg"
		>
			<div ref={content} className="flex flex-col gap-5 p-4">
				<FailureAnnouncer run={run} />
				<FailureArea run={run} onOpen={onOpenNode} />
				<ChainSection run={run} />
				{focus.data && <Attention focus={focus.data} onOpen={onOpenNode} />}
				<FocusSection run={run} focus={focus} onOpenNode={onOpenNode} located={located} />
				<OtherWarnings run={run} focus={focus.data} onOpen={onOpenNode} />
			</div>
		</div>
	);
}

/** 正在 Agent 上的节点（准备中、执行中）有没有：没设关注项时，读数为空的原因就不是「没有执行中的节点」。 */
const hasExecutingNodes = (run: RunView) =>
	run.chains.some((chain) =>
		chain.nodes.some((node) => {
			const attempt = node.attempts.at(-1);
			return !!attempt && isOnAgentStatus(attempt.status) && node.status === attempt.status;
		}),
	);

/**
 * 进行中的节点（排队中、准备中、执行中、等待中）和它们最新的一次尝试：先执行中，再排队、等待，同一类按链与链上的顺序，
 * 和控制台运行块的那一行一样（`activeOrder`）。
 */
const activeNodes = (run: RunView) =>
	orderedChains(run)
		.flatMap((chain) =>
			chain.nodes.flatMap((node) => {
				const attempt = node.attempts.at(-1);
				return attempt && isActiveStatus(node.status) ? [{ chain, node, attempt }] : [];
			}),
		)
		.sort((a, b) => activeOrder(a.node) - activeOrder(b.node));

/** 排队中、写着在等什么的节点和它最新一次尝试（排队的尝试）。 */
interface QueuedNode {
	node: NodeRunView;
	attempt: AttemptView & { queue_wait: QueueWaitView };
}

const queuedNodes = (run: RunView): QueuedNode[] =>
	activeNodes(run).flatMap(({ node, attempt }) =>
		node.status === "queued" && attempt.queue_wait
			? [{ node, attempt: { ...attempt, queue_wait: attempt.queue_wait } }]
			: [],
	);

/**
 * 没设关注项、没有节点在 Agent 上执行、排队的节点还在等：主指标这一栏写它们都在排队，不写「没有执行中的节点」。
 * 在等什么上面「进行中」那一行已经写了，这里只列节点，不再写一遍原因。最多列 3 个，其余写「还有 N 个」。
 */
function WaitingNodes({ nodes }: { nodes: QueuedNode[] }) {
	const shown = nodes.slice(0, MAX_WAITING_NODES);
	return (
		<div
			data-testid="waiting-nodes"
			className="rounded-lg border border-dashed border-border-soft px-4 py-4 text-sm text-fg-3"
		>
			<p className="m-0">
				{QUEUE_WAIT.allQueued}
				{shown.map(({ node }, i) => (
					<span key={node.node_id}>
						{i > 0 && "、"}
						<NodeName node={node} className="text-fg-1" />
					</span>
				))}
				{nodes.length > shown.length && `，${moreLabel(nodes.length - shown.length)}`}
			</p>
		</div>
	);
}

/** 主指标一栏最多列出几个排队的节点。 */
const MAX_WAITING_NODES = 3;

/**
 * 链路：各链的线路（components/run-lines），下面一行写进行中的节点，写法和控制台运行块相同（`activeDetail`）：
 * 所在 Agent、尝试号和已执行时长，还没开始执行的写状态；执行中的节点再接上此刻在做什么。
 */
function ChainSection({ run }: { run: RunView }) {
	const { now } = useTimeAxis();
	const chains = orderedChains(run);
	const nodeCount = chains.reduce((n, chain) => n + chain.nodes.length, 0);
	const active = activeNodes(run);
	return (
		<section
			aria-labelledby="overview-chains"
			className="rounded-lg border border-border-soft bg-surface px-4 py-3.5"
		>
			<div className="mb-3 flex items-baseline gap-2.5">
				<h2 id="overview-chains" className="m-0 text-base font-semibold">
					链路
				</h2>
				<span className="flex-none text-xs text-fg-3">
					{chainCountLabel(chains.length, nodeCount)}
				</span>
				<StatusLegend
					entries={statusLegend(chains.flatMap((chain) => chain.nodes.map((node) => node.status)))}
				/>
			</div>
			<RunLines
				chains={chains.map((chain) => {
					const { name, id } = chainLabelParts(chain);
					return {
						id: chain.id,
						label: name,
						instance: id ?? undefined,
						parent_chain_instance_id: chain.parent_chain_instance_id,
						async_node_id: chain.async_node_id,
						nodes: chain.nodes,
					};
				})}
			/>
			{active.length > 0 && (
				<div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1.5 border-t border-border-soft pt-3 text-xs text-fg-2">
					<span className="text-fg-3">{ACTIVE_LABEL}</span>
					<ul
						aria-label={LIST_LABEL.activeNodes}
						className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1.5 p-0"
					>
						{active.map(({ chain, node, attempt }) => {
							const waiting = node.status === "queued" ? attempt.queue_wait : null;
							return (
								<li
									key={`${chain.id}/${node.node_id}`}
									// 排队中的节点写着在等谁，一句话比较长：单独占一行。
									className={
										waiting ? "flex basis-full items-baseline gap-1.5" : "flex items-center gap-1.5"
									}
								>
									<StatusDot kind={nodeStatusView(node.status).kind} className="self-center" />
									<NodeName node={node} className="flex-none text-fg-1" />{" "}
									{waiting ? (
										<span className="min-w-0 text-fg-3">
											{attemptLabel(attempt.attempt)} · {nodeStatusView(node.status).label} ·{" "}
											<QueueWaitNote wait={waiting} queuedAt={attempt.queued_at} now={now} />
										</span>
									) : (
										<span className="whitespace-nowrap text-fg-3">
											<UntrustedText
												text={activeDetail({ ...attempt, status: node.status }, now)}
											/>
										</span>
									)}
									<ExecutingActivity activity={currentActivity(attempt)} />
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</section>
	);
}

/**
 * 执行中那一行里节点此刻在做什么：有动作时写「正在 保持 4 小时」（最外层、开始得最早的那个），没有动作时写进度的说明。
 * 准备中的节点还没有可写的，什么都不画。
 */
function ExecutingActivity({ activity }: { activity: CurrentActivity | null }) {
	if (!activity) return null;
	return (
		<span className="flex max-w-80 min-w-0 items-baseline gap-1.5 text-fg-3">
			<span aria-hidden>·</span>
			{activity.kind === "action" ? (
				<span className="flex min-w-0 items-baseline gap-1">
					{NODE_ACTIONS.doingNow}{" "}
					<Truncate untrusted className="text-fg-1">
						{activity.name}
					</Truncate>
				</span>
			) : (
				<Truncate untrusted className="text-fg-2">
					{activity.message}
				</Truncate>
			)}
		</span>
	);
}

/** 数值类（数值卡），以及这次运行的节点包版本里没有的图表（没有数值可画）：排成一条读数。 */
const isReadout = (item: RunFocusItem) => item.chart_type === "stat" || item.unavailable;

function FocusSection({
	run,
	focus,
	onOpenNode,
	located,
}: {
	run: RunView;
	focus: UseQueryResult<RunFocus>;
	onOpenNode: (target: OverviewTarget) => void;
	located?: string;
}) {
	const data = focus.data;
	const primary = data?.mode === "primary";
	// 运行已经结束、没设关注项：主指标是执行中节点的，不会再有读数，标题不再写「执行中节点的主指标」，下面一句说明。
	const emptyEnded = primary && run.status !== "running" && data?.items.length === 0;
	const open = (item: RunFocusItem) =>
		onOpenNode({ chainInstanceId: item.source.chain_instance_id, nodeId: item.node_id });
	return (
		<section aria-labelledby="overview-focus" className="flex flex-col gap-3">
			<div className="flex items-baseline gap-2.5">
				<h2 id="overview-focus" className="m-0 text-base font-semibold">
					{primary && !emptyEnded ? RUNNING_PRIMARY_LABEL : TERM.focusItem}
				</h2>
				{data && !primary && (
					<span className="font-mono text-xs text-fg-3" data-testid="focus-count">
						{data.items.length}
					</span>
				)}
				<span className="text-xs text-fg-3">
					{primary ? FOCUS.noneSet : `由场景设置，按设定的顺序排，${FOCUS.anomalyFirst}`}
				</span>
				<span className="flex-1" />
				<FocusSettingsLink orchestrationId={run.orchestration_id} configured={!primary} />
			</div>
			{focus.error && !data ? (
				<ErrorState
					title={MESSAGE.loadFailed(TERM.focusItem)}
					error={focus.error}
					onRetry={() => void focus.refetch()}
				/>
			) : !data ? (
				<Skeleton className="h-28 w-full" />
			) : (
				<FocusBody
					data={data}
					runEnded={run.status !== "running"}
					executing={hasExecutingNodes(run)}
					waiting={queuedNodes(run)}
					onOpen={open}
					located={located}
				/>
			)}
		</section>
	);
}

function FocusBody({
	data,
	runEnded,
	executing,
	waiting,
	onOpen,
	located,
}: {
	data: RunFocus;
	runEnded: boolean;
	/** 链路里列着执行中的节点：没设关注项时没有读数，原因就不是「没有执行中的节点」。 */
	executing: boolean;
	/** 排队中、写着在等什么的节点：没有节点执行时，说明里写它们在等什么，不写「没有执行中的节点」。 */
	waiting: QueuedNode[];
	onOpen: (item: RunFocusItem) => void;
	/** 要标出位置的节点（地址里的 `node`）。 */
	located?: string;
}) {
	if (data.items.length === 0 && data.mode === "primary" && !executing && waiting.length > 0) {
		return <WaitingNodes nodes={waiting} />;
	}
	// 运行已经结束、没设关注项：主指标是执行中节点的，不会再有读数；不画一个只写「没有执行中的节点」的空框，
	// 一句说明写清为什么这里没有读数、怎么才会有（标题也不再写「执行中节点的主指标」，见 FocusSection）。
	if (data.items.length === 0 && data.mode === "primary" && runEnded) {
		return <p className="m-0 text-sm text-fg-3">{FOCUS.endedNoneSet}</p>;
	}
	if (data.items.length === 0) {
		return (
			<p className="m-0 rounded-lg border border-dashed border-border-soft px-4 py-6 text-center text-sm text-fg-3">
				{emptyReadingsNote(data.mode, executing)}
			</p>
		);
	}
	const readouts = data.items.filter(isReadout);
	const charts = data.items.filter((item) => !isReadout(item));
	return (
		<>
			{data.expired && <p className="m-0 text-xs text-fg-3">{MESSAGE.metricsExpired}</p>}
			{readouts.length > 0 && (
				<FocusReadoutStrip
					items={readouts}
					generatedAt={data.generated_at}
					runEnded={runEnded}
					className="rounded-lg border border-border-soft bg-surface"
					renderItem={(item) => (
						<button
							type="button"
							onClick={() => onOpen(item)}
							aria-current={item.node_id === located ? "location" : undefined}
							className={item.node_id === located ? "selected-row" : undefined}
						/>
					)}
				/>
			)}
			{charts.length > 0 && (
				<div className="grid grid-cols-2 gap-3">
					{charts.map((item) => (
						<FocusChart
							key={`${item.node_id}\n${item.chart}\n${item.position}`}
							item={item}
							generatedAt={data.generated_at}
							runEnded={runEnded}
							onOpen={() => onOpen(item)}
							located={item.node_id === located}
						/>
					))}
				</div>
			)}
		</>
	);
}
