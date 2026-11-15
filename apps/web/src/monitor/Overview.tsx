import { isOnAgentStatus, type RunFocus, type RunFocusItem, type RunView } from "@sfly/schema";
import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { EyeIcon } from "lucide-react";
import { ChainBar, doneCount } from "#/components/chain-progress";
import { ErrorState } from "#/components/feedback/states";
import { NodeName } from "#/components/node-name";
import { StatusDot } from "#/components/status";
import { FocusChart } from "#/focus/FocusChart";
import { FocusReadoutStrip } from "#/focus/FocusReadout";
import { useRunFocus } from "#/focus/use-run-focus";
import { chainCountLabel, LIST_LABEL, MESSAGE, TERM } from "#/lib/copy";
import { formatDuration } from "#/lib/format";
import { NODE_STATUS } from "#/lib/node-status";
import { Skeleton } from "@/components/ui/skeleton";
import { Truncate } from "@/components/ui/truncate";
import { useTimeAxis } from "./monitor-state";
import { chainLabelParts, orderedChains } from "./run-model";

/** 概览里点一项要去详情里看的节点；节点所在的子流程还没触发时没有链实例。 */
export interface OverviewTarget {
	chainInstanceId: string | null;
	nodeId: string;
}

/**
 * 运行监控的「概览」：从上到下是链路（各链的进度和执行中的节点）和关注项（数值类排成一条读数，图表类两列排开）。
 * 点任何一项都进入「详情」并定位到来源节点（`onOpenNode`）。数据是 `GET /runs/:id/focus`，运行中每 2 秒重新读取。
 * 场景没设关注项时显示执行中节点的主指标，并给出「设置关注项」的入口。
 */
export function Overview({
	run,
	onOpenNode,
}: {
	run: RunView;
	onOpenNode: (target: OverviewTarget) => void;
}) {
	const focus = useRunFocus(run.id, { live: run.status === "running" });
	return (
		<div className="min-h-0 flex-1 overflow-auto bg-bg">
			<div className="flex flex-col gap-5 p-4">
				<ChainSection run={run} />
				<FocusSection run={run} focus={focus} onOpenNode={onOpenNode} />
			</div>
		</div>
	);
}

/** 链路：每条链一行进度，下面一行写执行中的节点、所在 Agent、尝试号和已执行的时长。 */
function ChainSection({ run }: { run: RunView }) {
	const { now } = useTimeAxis();
	const chains = orderedChains(run);
	const nodeCount = chains.reduce((n, chain) => n + chain.nodes.length, 0);
	const executing = chains.flatMap((chain) =>
		chain.nodes.flatMap((node) => {
			const attempt = node.attempts.at(-1);
			return attempt && isOnAgentStatus(attempt.status) && node.status === attempt.status
				? [{ chain, node, attempt }]
				: [];
		}),
	);
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
			<ul aria-label={LIST_LABEL.chainProgress} className="m-0 flex list-none flex-col gap-2 p-0">
				{chains.map((chain) => {
					const { name, id } = chainLabelParts(chain);
					return (
						<li key={chain.id} className="flex items-center gap-3">
							<span className="flex w-40 min-w-0 flex-none text-xs text-fg-2">
								<Truncate>{name}</Truncate>
								{id && (
									<span data-chain-id className="ml-1.5 flex-none font-mono text-fg-3">
										{id}
									</span>
								)}
							</span>
							<ChainBar label={name} nodes={chain.nodes} variant="wide" />
							<span className="font-mono text-xs text-fg-3">
								{doneCount(chain.nodes)} / {chain.nodes.length}
							</span>
						</li>
					);
				})}
			</ul>
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
}: {
	run: RunView;
	focus: UseQueryResult<RunFocus>;
	onOpenNode: (target: OverviewTarget) => void;
}) {
	const data = focus.data;
	const primary = data?.mode === "primary";
	const open = (item: RunFocusItem) =>
		onOpenNode({ chainInstanceId: item.source.chain_instance_id, nodeId: item.node_id });
	return (
		<section aria-labelledby="overview-focus" className="flex flex-col gap-3">
			<div className="flex items-baseline gap-2.5">
				<h2 id="overview-focus" className="m-0 text-base font-semibold">
					{primary ? `${NODE_STATUS.running.label}节点的${TERM.primaryMetric}` : TERM.focusItem}
				</h2>
				{data && !primary && (
					<span className="font-mono text-xs text-fg-3" data-testid="focus-count">
						{data.items.length}
					</span>
				)}
				<span className="text-xs text-fg-3">
					{primary ? `场景没有设置${TERM.focusItem}` : `由场景设置，按设定的顺序排`}
				</span>
				<span className="flex-1" />
				<Link
					to="/orchestrations/$id"
					params={{ id: run.orchestration_id }}
					search={{ settings: "focus" }}
					className="inline-flex items-center gap-1.5 rounded-sm text-xs text-fg-2 hover:text-fg-1"
				>
					<EyeIcon aria-hidden="true" className="size-3.5" />
					{primary ? `设置${TERM.focusItem}` : `调整${TERM.focusItem}`}
				</Link>
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
				<FocusBody data={data} onOpen={open} />
			)}
		</section>
	);
}

function FocusBody({ data, onOpen }: { data: RunFocus; onOpen: (item: RunFocusItem) => void }) {
	if (data.items.length === 0) {
		return (
			<p className="m-0 rounded-lg border border-dashed border-border-soft px-4 py-6 text-center text-sm text-fg-3">
				{data.mode === "primary"
					? MESSAGE.noRunningNodes
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
					renderItem={(item) => <button type="button" onClick={() => onOpen(item)} />}
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
						/>
					))}
				</div>
			)}
		</>
	);
}
