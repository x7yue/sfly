import { isOnAgentStatus, type RunFocus, type RunFocusItem, type RunView } from "@sfly/schema";
import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { ErrorState } from "#/components/feedback/states";
import { NodeName } from "#/components/node-name";
import { RunLines } from "#/components/run-lines";
import { StatusDot } from "#/components/status";
import { FocusChart } from "#/focus/FocusChart";
import { FocusReadoutStrip } from "#/focus/FocusReadout";
import { FocusSettingsLink } from "#/focus/FocusSettingsLink";
import { useRunFocus } from "#/focus/use-run-focus";
import {
	chainCountLabel,
	FOCUS,
	LIST_LABEL,
	MESSAGE,
	RUNNING_PRIMARY_LABEL,
	TERM,
} from "#/lib/copy";
import { formatDuration } from "#/lib/format";
import { NODE_STATUS } from "#/lib/node-status";
import { Skeleton } from "@/components/ui/skeleton";
import { Attention, OtherWarnings } from "./Attention";
import { useTimeAxis } from "./monitor-state";
import type { PanelTab } from "./run-link";
import { chainLabelParts, orderedChains } from "./run-model";

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
 * 运行监控的「概览」：从上到下是链路（各链的进度和执行中的节点）、「需要注意」（只在有异常时出现）、关注项（数值类排成
 * 一条读数，图表类两列排开，有异常的排在前面）和其他警告与错误。点任何一项都进入「详情」并定位到来源节点
 * （`onOpenNode`），「需要注意」的直达按钮还定位到那一行日志或那个页签。数据是 `GET /runs/:id/focus`，运行中每 2 秒
 * 重新读取。场景没设关注项时显示执行中节点的主指标，并给出「设置关注项」的入口。
 * `located` 是地址里的 `node`（控制台运行块的读数进来时带上）：属于这个节点的关注项标出位置（`aria-current="location"`，
 * 中性高亮），第一项滚到视野里。
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
	const loaded = focus.data !== undefined;
	// 读数到了以后滚一次；之后每 2 秒重新读取不再动页面。
	useEffect(() => {
		if (located === undefined || !loaded) return;
		container.current
			?.querySelector('[aria-current="location"]')
			?.scrollIntoView({ block: "nearest" });
	}, [located, loaded]);
	return (
		<div ref={container} className="min-h-0 flex-1 overflow-auto bg-bg">
			<div className="flex flex-col gap-5 p-4">
				<ChainSection run={run} />
				{focus.data && <Attention focus={focus.data} onOpen={onOpenNode} />}
				<FocusSection run={run} focus={focus} onOpenNode={onOpenNode} located={located} />
				<OtherWarnings run={run} focus={focus.data} onOpen={onOpenNode} />
			</div>
		</div>
	);
}

/** 正在 Agent 上的节点（准备中、执行中）和它们最新的一次尝试，按链与链上的顺序。 */
const executingNodes = (run: RunView) =>
	orderedChains(run).flatMap((chain) =>
		chain.nodes.flatMap((node) => {
			const attempt = node.attempts.at(-1);
			return attempt && isOnAgentStatus(attempt.status) && node.status === attempt.status
				? [{ chain, node, attempt }]
				: [];
		}),
	);

/** 链路：各链的线路（components/run-lines），下面一行写执行中的节点、所在 Agent、尝试号和时长（从开始执行算起，准备中的节点从排队算起）。 */
function ChainSection({ run }: { run: RunView }) {
	const { now } = useTimeAxis();
	const chains = orderedChains(run);
	const nodeCount = chains.reduce((n, chain) => n + chain.nodes.length, 0);
	const executing = executingNodes(run);
	return (
		<section
			aria-labelledby="overview-chains"
			className="rounded-lg border border-border-soft bg-surface px-4 py-3.5"
		>
			<div className="mb-3 flex items-baseline gap-2.5">
				<h2 id="overview-chains" className="m-0 text-base font-semibold">
					链路
				</h2>
				<span className="text-xs text-fg-3">{chainCountLabel(chains.length, nodeCount)}</span>
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
			{executing.length > 0 && (
				<div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1.5 border-t border-border-soft pt-3 text-xs text-fg-2">
					<span className="text-fg-3">{NODE_STATUS.running.label}</span>
					<ul
						aria-label={LIST_LABEL.runningNodes}
						className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1.5 p-0"
					>
						{executing.map(({ chain, node, attempt }) => (
							<li key={`${chain.id}/${node.node_id}`} className="flex items-center gap-1.5">
								<StatusDot kind="running" />
								<NodeName node={node} className="text-fg-1" />{" "}
								<span className="text-fg-3">
									{attempt.agent && `${attempt.agent} · `}
									{TERM.attempt} {attempt.attempt} ·{" "}
									<span className="font-mono">
										{formatDuration(now - Date.parse(attempt.started_at ?? attempt.queued_at))}
									</span>
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
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
	const open = (item: RunFocusItem) =>
		onOpenNode({ chainInstanceId: item.source.chain_instance_id, nodeId: item.node_id });
	return (
		<section aria-labelledby="overview-focus" className="flex flex-col gap-3">
			<div className="flex items-baseline gap-2.5">
				<h2 id="overview-focus" className="m-0 text-base font-semibold">
					{primary ? RUNNING_PRIMARY_LABEL : TERM.focusItem}
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
					executing={executingNodes(run).length > 0}
					onOpen={open}
					located={located}
				/>
			)}
		</section>
	);
}

function FocusBody({
	data,
	executing,
	onOpen,
	located,
}: {
	data: RunFocus;
	/** 链路里列着执行中的节点：没设关注项时没有读数，原因就不是「没有执行中的节点」。 */
	executing: boolean;
	onOpen: (item: RunFocusItem) => void;
	/** 要标出位置的节点（地址里的 `node`）。 */
	located?: string;
}) {
	if (data.items.length === 0) {
		return (
			<p className="m-0 rounded-lg border border-dashed border-border-soft px-4 py-6 text-center text-sm text-fg-3">
				{data.mode === "primary"
					? executing
						? MESSAGE.noPrimaryMetric
						: MESSAGE.noRunningNodes
					: `这次运行里没有可显示的${TERM.focusItem}：场景设置的${TERM.focusItem}所在的节点不在这次运行的版本里。`}
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
							onOpen={() => onOpen(item)}
							located={item.node_id === located}
						/>
					))}
				</div>
			)}
		</>
	);
}
