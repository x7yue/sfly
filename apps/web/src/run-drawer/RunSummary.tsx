import {
	type CatalogNode,
	type ChainRunView,
	isActiveStatus,
	type MetricIncrement,
	type NodeRunView,
	queryKey,
	type RunView,
	runsApi,
} from "@sfly/schema";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { useMemo, useRef } from "react";
import { ErrorState } from "#/components/feedback/states";
import { StatusPill } from "#/components/status";
import { apiQuery } from "#/lib/api";
import { formatClock, formatDateTime, formatDuration } from "#/lib/format";
import { useEventSource } from "#/lib/sse";
import { useNow } from "#/lib/use-now";
import { NodePrimaryMetric } from "#/metrics/PrimaryMetric";
import { catalogEntry } from "#/metrics/use-primary-metric";
import {
	applyProgress,
	chainLabel,
	findNode,
	focusNode,
	nodeStatus,
	orderedChains,
	runStatus,
	shortId,
} from "#/monitor/run-model";
import {
	applyMetricIncrement,
	attemptsSignature,
	refetchSeries,
	useMetricCatalog,
} from "#/monitor/use-run-metrics";
import { useTaskLogs } from "#/monitor/use-task-logs";
import { ChainBar } from "#/run-records/ChainProgress";
import { Skeleton } from "@/components/ui/skeleton";

/** 摘要里显示的最新日志行数。 */
const LOG_LINES = 6;

const isDone = (status: string) => status === "success" || status === "skipped";

/**
 * 运行视图（GET /runs/:id），运行中通过 SSE 实时更新（与监控页共用同一份缓存）。
 * metrics 为 true 时还把指标增量追加进序列缓存（主指标的趋势），重连后重新获取序列；
 * 同一运行只让一处订阅指标，免得同一个增量被追加多次。
 */
export function useLiveRun(runId: string, { metrics = false }: { metrics?: boolean } = {}) {
	const queryClient = useQueryClient();
	const key = queryKey(runsApi.get, { params: { id: runId } });
	const run = useQuery(apiQuery(runsApi.get, { params: { id: runId } }));
	const running = !run.data || run.data.status === "running";
	const opened = useRef(false);
	useEventSource(
		runsApi.events,
		running ? { params: { id: runId } } : null,
		{
			run: (view) => queryClient.setQueryData(key, view),
			progress: (event) =>
				queryClient.setQueryData(key, (old: RunView | undefined) => applyProgress(old, event)),
			...(metrics && {
				metrics: (increment: MetricIncrement) =>
					applyMetricIncrement(queryClient, runId, increment),
			}),
		},
		() => {
			if (metrics && opened.current) refetchSeries(queryClient, runId);
			opened.current = true;
		},
	);
	return run;
}

/**
 * 运行抽屉的摘要阶段（原型 drawerHTML 的 summary）：运行状态与时长、各链进度、正在执行的节点（进度）、
 * 最新几行日志，实时更新；节点类型有主指标时，正在执行的节点显示主指标的最新值与趋势（#43）。
 * 底部按钮由 RunDrawer 渲染。
 */
export function RunSummary({ runId }: { runId: string }) {
	const query = useLiveRun(runId, { metrics: true });
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
					{run.triggered_by} 触发 · {formatDateTime(run.started_at)}
				</span>
			</div>
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
				<LatestLogs taskId={taskId} />
			) : (
				<p className="m-0 text-xs text-fg-3">还没有日志。</p>
			)}
		</section>
	);
}

function ChainRow({ chain }: { chain: ChainRunView }) {
	const done = chain.nodes.filter((n) => isDone(n.status)).length;
	return (
		<li className="flex items-center gap-2.5 text-xs">
			<span className="w-36 truncate text-fg-2" title={chainLabel(chain)}>
				{chainLabel(chain)}
			</span>
			<ChainBar
				chain={{
					id: chain.id,
					chain_id: chain.chain_id,
					subflow: chain.depth > 0,
					status: chain.status,
					nodes: chain.nodes.map((n) => ({ node_id: n.node_id, status: n.status })),
				}}
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
	const s = nodeStatus(node.status);
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

function LatestLogs({ taskId }: { taskId: string }) {
	const logs = useTaskLogs(taskId, NO_FILTER);
	const lines = logs.lines.slice(-LOG_LINES);
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
				return (
					<li key={line.seq} className="truncate">
						<span className="text-fg-3">{formatClock(line.time)}</span>{" "}
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
