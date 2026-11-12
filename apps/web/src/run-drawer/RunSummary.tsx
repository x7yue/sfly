import {
	type CatalogNode,
	type ChainRunView,
	isActiveStatus,
	type NodeRunView,
	type RunNotificationState,
} from "@sfly/schema";
import { cn } from "cn";
import { useMemo } from "react";
import { ChainBar, doneCount } from "#/components/chain-progress";
import { ErrorState } from "#/components/feedback/states";
import { nodeStatusView, runNotificationView, StatusPill } from "#/components/status";
import { ViaTag } from "#/components/via-tag";
import { chainLabel as chainName, TERM } from "#/lib/copy";
import {
	formatClock,
	formatDateTime,
	formatDuration,
	formatFullDateTime,
	shortId,
	spansOtherDay,
	TIME_NOT_RECORDED,
} from "#/lib/format";
import { useNow } from "#/lib/use-now";
import { NodePrimaryMetric } from "#/metrics/PrimaryMetric";
import { catalogEntry } from "#/metrics/use-primary-metric";
import { useLiveRun } from "#/monitor/live-run";
import { logLineTime, useLogTimeKind } from "#/monitor/log-time-kind";
import { chainLabel, findNode, focusNode, orderedChains, runStatus } from "#/monitor/run-model";
import { attemptsSignature, useMetricCatalog } from "#/monitor/use-run-metrics";
import { useTaskLogs } from "#/monitor/use-task-logs";
import { Skeleton } from "@/components/ui/skeleton";

/** 摘要里显示的最新日志行数。 */
const LOG_LINES = 6;

/**
 * 运行抽屉的摘要阶段（原型 drawerHTML 的 summary）：运行状态与时长、各链进度、正在执行的节点（进度）、
 * 最新几行日志，实时更新；节点类型有主指标时，正在执行的节点显示主指标的最新值与趋势（#43）。
 * 底部按钮由 RunDrawer 渲染。
 */
export function RunSummary({ runId }: { runId: string }) {
	const query = useLiveRun(runId);
	const run = query.data;
	const signature = useMemo(() => (run ? attemptsSignature(run) : ""), [run]);
	const catalog = useMetricCatalog(runId, signature, !!run);
	const now = useNow(!run || run.status === "running");
	if (query.error && !run) {
		return (
			<ErrorState title="无法加载运行" error={query.error} onRetry={() => void query.refetch()} />
		);
	}
	if (!run) {
		return (
			<output aria-label="加载中" className="flex flex-col gap-3">
				<Skeleton className="h-6 w-full" />
				<Skeleton className="h-24 w-full" />
			</output>
		);
	}
	const status = runStatus(run);
	const chains = orderedChains(run);
	const elapsed = (run.ended_at ? Date.parse(run.ended_at) : now) - Date.parse(run.started_at);
	const active = chains.flatMap((chain) =>
		chain.nodes.filter((n) => isActiveStatus(n.status)).map((node) => ({ chain, node })),
	);
	const focus = findNode(run, focusNode(run));
	const taskId = focus?.attempts.at(-1)?.task_id;

	return (
		<section aria-label="运行摘要">
			<div className="mb-3 flex items-center gap-2.5">
				<span data-testid="summary-status">
					<StatusPill kind={status.kind} className="text-sm">
						{status.label}
					</StatusPill>
				</span>
				<span className="font-mono" data-slot="run-id">
					{shortId(run.id)}
				</span>
				<span className="font-mono text-fg-3">{formatDuration(elapsed)}</span>
				<span className="ml-auto text-xs text-fg-3">
					{run.triggered_by}
					<ViaTag via={run.triggered_via} /> 触发 · {formatDateTime(run.started_at)}
				</span>
			</div>
			{run.run_notification && <RunNotificationLine state={run.run_notification} />}
			<ul aria-label="各链进度" className="m-0 flex list-none flex-col gap-1.5 p-0">
				{chains.map((chain) => (
					<ChainRow key={chain.id} chain={chain} />
				))}
			</ul>
			<h3 className="mt-4.5 mb-2.5 text-2xs font-semibold tracking-wide text-fg-2">正在执行</h3>
			{active.length === 0 ? (
				<p className="m-0 text-xs text-fg-3">
					{run.status === "running" ? "没有正在执行的节点。" : `运行已结束：${status.label}。`}
				</p>
			) : (
				<ul aria-label="正在执行的节点" className="m-0 flex list-none flex-col gap-2 p-0">
					{active.map(({ chain, node }) => (
						<ActiveNode
							key={`${chain.id}:${node.node_id}`}
							runId={run.id}
							chain={chain}
							node={node}
							metric={catalogEntry(catalog.data, chain.id, node.node_id)}
							now={now}
						/>
					))}
				</ul>
			)}
			<h3 className="mt-4.5 mb-2.5 flex items-center text-2xs font-semibold tracking-wide text-fg-2">
				最新日志
				{focus && <span className="ml-auto font-mono font-normal text-fg-3">{focus.node_id}</span>}
			</h3>
			{taskId ? (
				<LatestLogs taskId={taskId} day={run.started_at} />
			) : (
				<p className="m-0 text-xs text-fg-3">还没有日志。</p>
			)}
		</section>
	);
}

/**
 * 运行通知的状态（一行）：排队中、已送达、投递失败、已丢弃、未发送。失败、已丢弃时写原因（里面已有机器人名称），
 * 未发送时写机器人和原因，其余写发给了哪个机器人。投递不改变运行的状态，所以这一行只是提示。
 */
function RunNotificationLine({ state }: { state: RunNotificationState }) {
	const view = runNotificationView(state.status);
	const text =
		state.reason === null
			? `发给「${state.bot}」`
			: state.status === "not_sent"
				? `「${state.bot}」${state.reason}`
				: state.reason;
	return (
		<fieldset
			aria-label={TERM.runNotification}
			className="m-0 mb-3 flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1 border-0 p-0 text-xs"
		>
			<span className="shrink-0 text-fg-3">{TERM.runNotification}</span>
			<StatusPill kind={view.kind} className="shrink-0">
				{view.label}
			</StatusPill>
			<span className="min-w-48 flex-1 text-fg-2">{text}</span>
		</fieldset>
	);
}

function ChainRow({ chain }: { chain: ChainRunView }) {
	const done = doneCount(chain.nodes);
	return (
		<li className="flex items-center gap-2.5 text-xs">
			<span className="w-36 truncate text-fg-2" title={chainLabel(chain)}>
				{chainLabel(chain)}
			</span>
			<ChainBar
				label={chainName({ chain_id: chain.chain_id, subflow: chain.depth > 0, name: chain.name })}
				nodes={chain.nodes}
			/>
			<span className="ml-auto font-mono text-2xs text-fg-3">
				{done}/{chain.nodes.length}
			</span>
		</li>
	);
}

function ActiveNode({
	runId,
	chain,
	node,
	metric,
	now,
}: {
	runId: string;
	chain: ChainRunView;
	node: NodeRunView;
	/** 指标目录里的这个节点（主指标）；还没开始执行时为 undefined。 */
	metric: CatalogNode | undefined;
	now: number;
}) {
	const s = nodeStatusView(node.status);
	const attempt = node.attempts.at(-1);
	const since = attempt?.started_at ?? attempt?.queued_at;
	const progress = attempt?.progress;
	const ratio = progress?.total
		? Math.min(1, Math.max(0, progress.current / progress.total))
		: null;
	return (
		<li className="rounded-lg border border-border-soft bg-raised px-3 py-2.5">
			<div className="flex items-center gap-2 text-sm">
				<StatusPill kind={s.kind}>{s.label}</StatusPill>
				<span className="font-mono">{node.node_id}</span>
				{chain.depth > 0 && <span className="truncate text-xs text-fg-3">{chainLabel(chain)}</span>}
				<span className="ml-auto font-mono text-2xs text-fg-3">
					{[node.agent, since ? formatDuration(now - Date.parse(since)) : null]
						.filter(Boolean)
						.join(" · ")}
				</span>
			</div>
			{metric?.primary_metric && (
				<NodePrimaryMetric
					runId={runId}
					entry={metric}
					status={node.status}
					variant="block"
					className="mt-2"
				/>
			)}
			{progress && (
				<div className="mt-2">
					{ratio !== null && (
						<div
							role="progressbar"
							aria-label={`${node.node_id} 进度`}
							aria-valuemin={0}
							aria-valuemax={progress.total ?? undefined}
							aria-valuenow={progress.current}
							className="h-1 overflow-hidden rounded-[2px] bg-track"
						>
							<i className="block h-full bg-signal" style={{ width: `${ratio * 100}%` }} />
						</div>
					)}
					<div className="mt-1 truncate font-mono text-2xs text-fg-3">
						{progress.total !== null
							? `${progress.current} / ${progress.total}`
							: String(progress.current)}
						{progress.message && ` · ${progress.message}`}
					</div>
				</div>
			)}
		</li>
	);
}

const LEVEL: Record<string, { label: string; className: string }> = {
	debug: { label: "DEBUG", className: "text-log-debug" },
	info: { label: "INFO", className: "text-log-info" },
	warn: { label: "WARN", className: "text-log-warn" },
	error: { label: "ERROR", className: "text-log-error" },
};

const NO_FILTER: never[] = [];

/** day：运行开始的时刻；有一行的时间不在那一天时每行都带上日期（与监控页的日志时间列同一条规则）。 */
function LatestLogs({ taskId, day }: { taskId: string; day: string }) {
	const logs = useTaskLogs(taskId, NO_FILTER);
	// 与监控页日志面板的时间列用同一个选择（默认 Agent 时间）。
	const timeKind = useLogTimeKind();
	const lines = logs.lines.slice(-LOG_LINES);
	const formatTime = spansOtherDay(
		lines.map((l) => logLineTime(l, timeKind)),
		day,
	)
		? formatFullDateTime
		: formatClock;
	if (logs.error) return <p className="m-0 text-xs text-danger-fg">无法加载日志：{logs.error}</p>;
	if (!logs.loaded) return <Skeleton className="h-16 w-full" />;
	if (lines.length === 0) return <p className="m-0 text-xs text-fg-3">还没有日志。</p>;
	return (
		<ol
			aria-label="最新日志"
			className="m-0 list-none overflow-hidden rounded-lg border border-border-soft bg-sunk px-2.5 py-2 font-mono text-2xs leading-5"
		>
			{lines.map((line) => {
				const level = LEVEL[line.level] ?? { label: line.level, className: "" };
				const time = logLineTime(line, timeKind);
				return (
					<li key={line.seq} className="truncate">
						<span className="text-fg-3">{time ? formatTime(time) : TIME_NOT_RECORDED}</span>{" "}
						<span className={level.className}>{level.label}</span>{" "}
						<span className={cn(line.level === "info" ? "text-log-info" : level.className)}>
							{line.text}
						</span>
					</li>
				);
			})}
		</ol>
	);
}
