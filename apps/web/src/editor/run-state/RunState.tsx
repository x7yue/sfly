import { nodeCardText } from "@sfly/orchestration";
import {
	errorHeadline,
	isActiveStatus,
	type RunFocus,
	type RunFocusItem,
	type RunMetricCatalog,
	type RunView,
	type StoredOrchestrationDocument,
} from "@sfly/schema";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ActivityIcon, PanelRightCloseIcon } from "lucide-react";
import { forwardRef, type ReactNode, useId, useMemo } from "react";
import { currentActivity } from "#/actions/current-activity";
import { ActionArea, CurrentActions } from "#/actions/InspectorActions";
import { actionAttempt } from "#/actions/summary-model";
import { useActionSummary } from "#/actions/use-task-actions";
import { floatGroupClass } from "#/components/canvas/CanvasDock";
import { cardFocusLabel } from "#/components/canvas/CardFocus";
import type {
	CanvasContextValue,
	CanvasInfo,
	CardFocus,
	NodeDecoration,
} from "#/components/canvas/context";
import type { DocNode } from "#/components/canvas/flow";
import { KIND_META } from "#/components/canvas/node-display";
import { type CanvasSelection, soleNode } from "#/components/canvas/selection";
import { LOD_HIDDEN, ZOOM_TEXT_12 } from "#/components/canvas/zoom-text";
import { ErrorMessage } from "#/components/feedback/error-message";
import { runNodeName } from "#/components/node-name";
import { SectionHeading } from "#/components/page";
import { nodeStatusView, StatusPill } from "#/components/status";
import { UntrustedText } from "#/components/untrusted-text";
import { AnomalyMark } from "#/focus/AnomalyNote";
import { FocusReadoutStrip } from "#/focus/FocusReadout";
import { FocusRows } from "#/focus/FocusRows";
import { FocusTally } from "#/focus/FocusTally";
import { focusPreview, nodeFocusItems, nodePrimaryItem } from "#/focus/focus-preview";
import { isSavedNodeType } from "#/focus/saved-node";
import { useFocusItems } from "#/focus/use-focus-items";
import {
	ACTION,
	attemptLabel,
	DURATION_LABEL,
	ELAPSED_LABEL,
	ERROR_LOCATION_LABEL,
	FOCUS,
	MESSAGE,
	MONITOR_DETAIL_LABEL,
	NOT_RUN_IN_ENDED_RUN,
	openInLabel,
	PROGRESS_LABEL,
	TERM,
} from "#/lib/copy";
import { formatDateTime, formatProgress, formatSpan, shortId } from "#/lib/format";
import { NODE_STATUS } from "#/lib/node-status";
import { ACTIONS_POLL_MS } from "#/lib/polling";
import { untrustedPlain } from "#/lib/untrusted-text";
import { useNow } from "#/lib/use-now";
import { runViewTransition } from "#/lib/view-transition";
import { NodePrimaryMetric } from "#/metrics/PrimaryMetric";
import { catalogEntry } from "#/metrics/use-primary-metric";
import { runMonitorLink } from "#/monitor/run-link";
import { chainRunStatus, runStatus } from "#/monitor/run-model";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { InspectorWidthHandle, useInspectorWidth } from "../inspector/inspector-width";
import { NodeCharts } from "./NodeCharts";
import {
	type NodeRunSummary,
	nodeElapsed,
	type RunOverlay,
	withoutErrorClass,
} from "./run-overlay";
import type { CanvasRun } from "./use-canvas-run";

/**
 * 画布「运行状态」模式（原型 #/editor/:id?run=<id>，#41）的界面：画布叠加（decorateNode / decorateEdge /
 * regionMeta）、左上的运行状态、右上的监控页入口、右侧运行状态检查器。
 * 节点卡片显示属于它的关注项，检查器显示运行的全部关注项、选中节点声明的图表（#353）；日志、每次尝试的详情和能缩放的图表
 * 在运行监控页里。
 */

type Decorations = Pick<CanvasContextValue, "decorateNode" | "decorateEdge" | "regionMeta">;

/**
 * 卡片上属于这个节点的关注项：左上角的个数；节点开始执行过以后，底部换成前两项（有异常的在前）和「还有 N 个关注项」。
 * 场景没设关注项、或者没有属于这个节点的时为 undefined。
 */
function cardFocus(
	focus: RunFocus | undefined,
	id: string,
	started: boolean,
	runEnded: boolean,
): CardFocus | undefined {
	const items = nodeFocusItems(focus, id);
	if (!focus || items.length === 0) return undefined;
	return {
		count: items.length,
		label: cardFocusLabel(items, focus.generated_at),
		rows: started ? (
			<FocusRows
				variant="card"
				preview={focusPreview(items)}
				generatedAt={focus.generated_at}
				mode={focus.mode}
				runEnded={runEnded}
				aria-hidden
				data-testid="node-focus"
				className={cn("rounded-md bg-sunk px-2 py-0.5", ZOOM_TEXT_12, LOD_HIDDEN)}
			/>
		) : undefined,
	};
}

/**
 * 场景没设关注项时，卡片上的主指标有异常（读数里这个节点的主指标，和别处同一份）：主指标旁画三角，原因写进卡片的可访问名称，
 * 没有异常时什么也不加。数值和迷你趋势仍是 `NodePrimaryMetric` 的。
 */
function primaryAnomaly(focus: RunFocus | undefined, id: string) {
	const item = nodePrimaryItem(focus, id);
	if (!focus || !item || item.anomaly === null) return undefined;
	return { label: cardFocusLabel([item], focus.generated_at, "primary") };
}

/**
 * 节点卡片、连线与子流程区域的运行状态叠加。卡片上（docs/DESIGN-SYSTEM.md §2.3）：站点灯换成状态标记，第一行右侧是这次
 * 运行里最要紧的那个数——执行中有总数的进度（282/600）、其余状态的耗时；第二行换成失败原因、
 * 主指标的最新值与迷你趋势（#43）或第几次尝试，没有时沿用配置摘要；执行中、等待中的底边画进度线。
 * `now` 是控制面时间（运行中每秒更新），耗时按它算。
 * 执行中的节点第二行写此刻在做什么（#356）：最外层、开始得最早的动作，没有动作时是进度的说明。
 * 有关注项的节点（#353）卡片上边线外写个数，开始执行过以后两行字下面列出前两项。
 */
export function useRunDecorations(
	run: RunView | undefined,
	overlay: RunOverlay | undefined,
	metrics: RunMetricCatalog | undefined,
	focus: RunFocus | undefined,
	now: number,
) {
	return useMemo((): Decorations => {
		if (!run || !overlay) return {};
		const ended = run.status !== "running";
		return {
			decorateNode: (id): NodeDecoration => {
				const summary = overlay.node(id);
				if (!summary) {
					// 子流程还没有触发（或运行结束时也没有触发）：节点没有运行记录。
					return {
						run: "pending",
						status: {
							kind: "pending",
							label: ended ? NOT_RUN_IN_ENDED_RUN.label : NODE_STATUS.pending.label,
						},
						focus: cardFocus(focus, id, false, ended),
					};
				}
				const { node } = summary;
				const status = nodeStatusView(node.status);
				const last = node.attempts.at(-1);
				const elapsed = nodeElapsed(node, now);
				const entry = catalogEntry(metrics, summary.chain.id, id);
				const started = node.attempts.some((a) => a.started_at !== null);
				// 三角画在主指标旁，卡片上没有主指标时不写异常（名称里也不写）。
				const anomaly = entry?.primary_metric ? primaryAnomaly(focus, id) : undefined;
				const decoration: NodeDecoration = {
					run: summary.state,
					status,
					activity: currentActivity(last) ?? undefined,
					focus: cardFocus(focus, id, started, ended) ?? anomaly,
				};
				// 执行中、等待中的时长每秒都在变：按进行中的写法（formatSpan）。
				const live = summary.state === "running" || summary.state === "waiting";
				if (elapsed !== null) {
					decoration.figure = formatSpan(elapsed, live);
					if (live)
						decoration.overview = (
							<>
								{ELAPSED_LABEL} <span className="font-mono">{formatSpan(elapsed, true)}</span>
							</>
						);
				}
				if (summary.state === "running" && last?.progress?.total) {
					const done = formatProgress(last.progress.current, last.progress.total);
					decoration.figure = done;
					decoration.overview = <span className="font-mono">{done}</span>;
					decoration.progress = last.progress.current / last.progress.total;
				}
				const error = node.error ?? last?.error;
				// 失败原因（错误的第一行，和检查器一样）在卡片和站外一行上去掉开头的异常类名，悬停提示里是带类名的原文；
				// 多行错误的全文在运行监控里。
				const reason = summary.state === "failed" && error ? errorHeadline(error.message) : "";
				if (summary.state === "failed")
					decoration.overview = (
						<span title={reason ? untrustedPlain(reason) : undefined} className="text-danger-fg">
							<UntrustedText text={withoutErrorClass(reason) || NODE_STATUS.failed.label} />
						</span>
					);
				if (reason) {
					decoration.detail = (
						<span title={untrustedPlain(reason)} className="min-w-0 flex-1 truncate text-danger-fg">
							<UntrustedText text={withoutErrorClass(reason)} />
						</span>
					);
				} else if (entry?.primary_metric) {
					decoration.detail = (
						<>
							{anomaly && <AnomalyMark className="flex-none" />}
							<NodePrimaryMetric
								runId={run.id}
								entry={entry}
								status={node.status}
								variant="inline"
							/>
						</>
					);
				} else if (summary.state === "running" && node.attempts.length > 1) {
					decoration.detail = (
						<span className="min-w-0 flex-1 truncate">{attemptLabel(node.attempts.length)}</span>
					);
				}
				return decoration;
			},
			decorateEdge: overlay.edge,
			regionMeta: (entryId) => {
				const instances = overlay.instances(entryId);
				if (instances.length === 0) return ended ? "未触发" : "还没有触发";
				const cancelling = run.cancel !== null;
				const statuses = instances.map((c) => chainRunStatus(c, cancelling));
				const shown =
					statuses.find((s) => s.kind === "running") ??
					statuses.find((s) => s.kind === "failed") ??
					statuses[0];
				return (
					<span className="inline-flex items-center gap-1.5">
						{instances.length > 1 && <span>{instances.length} 个实例 ·</span>}
						{shown && (
							<StatusPill kind={shown.kind} className={ZOOM_TEXT_12}>
								{shown.label}
							</StatusPill>
						)}
					</span>
				);
			},
		};
	}, [run, overlay, metrics, focus, now]);
}

/** 左上控件组里替换检查状态的部分：运行状态、运行编号、耗时。 */
export function RunStateBadge({ state }: { state: CanvasRun }) {
	const running = state.status === "ready" && state.run.status === "running";
	const now = useNow(running);
	let body: ReactNode;
	switch (state.status) {
		case "loading":
			body = <span className="text-xs text-fg-3">{MESSAGE.loading}</span>;
			break;
		case "none":
			body = <StatusPill kind="pending">还没有运行</StatusPill>;
			break;
		case "error":
			body = <StatusPill kind="failed">{MESSAGE.loadFailed(TERM.run)}</StatusPill>;
			break;
		case "ready": {
			const { run } = state;
			const s = runStatus(run);
			const end = run.ended_at ? Date.parse(run.ended_at) : now;
			body = (
				<>
					<StatusPill kind={s.kind} className="vt-run-state">
						{s.label}
					</StatusPill>
					<span className="font-mono text-xs">{shortId(run.id)}</span>
					<span className="font-mono text-xs text-fg-3">
						{formatSpan(end - Date.parse(run.started_at), !run.ended_at)}
					</span>
				</>
			);
		}
	}
	return (
		<span
			data-testid="canvas-run"
			title={state.status === "error" ? untrustedPlain(state.error.message, "text") : undefined}
			className="flex items-center gap-1.5 px-1.5"
		>
			{body}
		</span>
	);
}

/** 右上控件组（运行状态下替换保存 / 运行）：打开运行监控（主操作）；没有运行时不显示。 */
export function RunTopRight({ run }: { run: RunView | undefined }) {
	if (!run) return null;
	return (
		<div className={cn(floatGroupClass, "top-3 right-3")}>
			<Link
				to="/runs/$id"
				params={{ id: run.id }}
				viewTransition={runViewTransition("to-monitor")}
				className={buttonVariants({ variant: "primary" })}
			>
				<ActivityIcon />
				{ACTION.openRun}
			</Link>
		</div>
	);
}

/**
 * 运行状态检查器：选中一个节点时是该节点在这次运行里的摘要（运行编号与版本、Agent、耗时、尝试次数、错误）、
 * 它声明的图表（带「关注」开关）和「在运行监控详情里打开」（跳转后定位到该节点）；没有选中时是这次运行的概况和全部关注项，
 * 点一项选中它所在的节点。
 */
export const RunStateInspector = forwardRef<
	HTMLElement,
	{
		state: CanvasRun;
		/** 画布上选中了什么（只含画布上有的节点）。 */
		selection: CanvasSelection;
		/** 画布上节点的内容。 */
		nodeOf(id: string): DocNode | undefined;
		info: CanvasInfo;
		/** 编辑起点的场景版本：控制面按已保存的版本检查新加的关注项，节点在那一版里变了就不能设。 */
		saved: StoredOrchestrationDocument;
		/** 选中一个节点（点概况里的一项关注项）。 */
		onSelectNode(id: string): void;
		onCollapse(): void;
		onEscape(): void;
	}
>(function RunStateInspector(
	{ state, selection, nodeOf, info, saved, onSelectNode, onCollapse, onEscape },
	ref,
) {
	const width = useInspectorWidth();
	const id = soleNode(selection);
	const node = id === null ? undefined : nodeOf(id);
	return (
		<aside
			ref={ref}
			aria-label="检查器"
			tabIndex={-1}
			onKeyDown={(e) => {
				if (e.key === "Escape" && !e.defaultPrevented) {
					e.preventDefault();
					onEscape();
				}
			}}
			className="absolute top-15.5 right-3 bottom-3.5 z-10 flex flex-col overflow-hidden rounded-xl border border-border-soft bg-surface shadow-float"
			style={{ width }}
		>
			{state.status === "ready" && id !== null && node ? (
				<NodeRunInspector
					state={state}
					id={id}
					node={node}
					summary={state.overlay.node(id)}
					info={info}
					saved={saved}
					onCollapse={onCollapse}
				/>
			) : (
				<RunOverview state={state} onSelectNode={onSelectNode} onCollapse={onCollapse} />
			)}
			<InspectorWidthHandle />
		</aside>
	);
});

function Header({
	row,
	title,
	onCollapse,
}: {
	row: ReactNode;
	title: ReactNode;
	onCollapse(): void;
}) {
	return (
		<div className="flex-none border-b border-border-soft px-3.5 pt-3 pb-2.5">
			<div className="flex items-center gap-1.75 text-xs text-fg-3">
				{row}
				<span className="ml-auto flex items-center">
					<Button variant="ghost" size="icon-sm" aria-label="收起检查器" onClick={onCollapse}>
						<PanelRightCloseIcon />
					</Button>
				</span>
			</div>
			<h2 className="mt-1.5 mb-0.5 truncate text-base font-semibold">{title}</h2>
		</div>
	);
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
	return (
		<>
			<dt className="text-fg-3">{label}</dt>
			<dd className="m-0 min-w-0 truncate font-mono" data-testid={testId}>
				{children}
			</dd>
		</>
	);
}

/** 摘要里的一行说明文字：可以折行，不是等宽的数据（进度的说明是节点写的一句话）。 */
function TextRow({
	label,
	children,
	testId,
}: {
	label: string;
	children: ReactNode;
	testId: string;
}) {
	return (
		<>
			<dt className="text-fg-3">{label}</dt>
			<dd className="m-0 min-w-0 wrap-anywhere" data-testid={testId}>
				{children}
			</dd>
		</>
	);
}

const HINT = `日志和每次${TERM.attempt}在${MONITOR_DETAIL_LABEL}里。`;

function NodeRunInspector({
	state,
	id,
	node,
	summary,
	info,
	saved,
	onCollapse,
}: {
	state: Extract<CanvasRun, { status: "ready" }>;
	id: string;
	node: DocNode;
	summary: NodeRunSummary | undefined;
	info: CanvasInfo;
	saved: StoredOrchestrationDocument;
	onCollapse(): void;
}) {
	const { run, focus } = state;
	const focusItems = useFocusItems(run.orchestration_id);
	const entry = summary && catalogEntry(state.metrics, summary.chain.id, id);
	const view = summary?.node;
	const now = useNow(run.status === "running");
	const elapsed = view ? nodeElapsed(view, now) : null;
	const status = view ? nodeStatusView(view.status) : null;
	const latest = view?.attempts.at(-1);
	// 动作记在尝试上；结束以后摘要还在，只是不再轮询。
	const attempt = actionAttempt(view);
	const live = attempt?.status === "running";
	const actions = useActionSummary(attempt?.task_id, live && ACTIONS_POLL_MS);
	const actionSummary = actions.data;
	const hasActions = actionSummary !== undefined && actionSummary.total > 0;
	const running = live && actionSummary ? actionSummary.running : [];
	// 没有正在做的动作时，进度的说明代替「正在做」（#345 故事 29）。
	const activity = running.length === 0 ? currentActivity(latest) : null;
	return (
		<>
			<Header
				row={
					<>
						<span className="font-mono text-fg-2">{id}</span>
						<span>· {KIND_META[node.kind].label}</span>
						<span className="ml-auto">
							{status && <StatusPill kind={status.kind}>{status.label}</StatusPill>}
						</span>
					</>
				}
				title={<UntrustedText text={nodeCardText(node, info).title} />}
				onCollapse={onCollapse}
			/>
			<div
				data-testid="run-inspector-body"
				className="min-h-0 flex-1 overflow-auto px-3.5 py-3 text-sm"
			>
				<dl
					data-testid="run-summary"
					className="m-0 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5 text-xs"
				>
					<Row label="运行">
						{shortId(run.id)} · v{run.orchestration_version}
					</Row>
					<Row label="Agent">
						{view?.agent == null ? "控制面" : <UntrustedText text={view.agent} />}
					</Row>
					<Row label={DURATION_LABEL}>
						{elapsed === null ? "—" : formatSpan(elapsed, !view?.attempts.at(-1)?.ended_at)}
					</Row>
					<Row label="尝试" testId="run-attempts">
						{view?.attempts.length ?? 0}
					</Row>
					{summary && summary.instances > 1 && (
						<Row label="实例">第 1 个（共 {summary.instances} 个）</Row>
					)}
					{activity?.kind === "progress" && (
						<TextRow label={PROGRESS_LABEL} testId="run-progress">
							<UntrustedText text={activity.message} />
						</TextRow>
					)}
				</dl>
				{view?.error && (
					<div
						role="alert"
						className="mt-3 rounded-lg border border-danger-line bg-danger-soft px-3 py-2.5"
					>
						<Badge variant="danger" className="font-mono">
							<UntrustedText text={view.error.kind} />
						</Badge>
						<p className="m-0 mt-1.5 break-words text-xs">
							<UntrustedText text={errorHeadline(view.error.message)} />
						</p>
						{view.error.location && (
							<p
								data-testid="run-error-location"
								className="m-0 mt-1 break-words font-mono text-xs text-fg-2"
							>
								{ERROR_LOCATION_LABEL}：<UntrustedText text={view.error.location} />
							</p>
						)}
					</div>
				)}
				{!view && (
					<p className="m-0 mt-3 text-xs text-fg-2">
						{NOT_RUN_IN_ENDED_RUN.subflowNote(run.status !== "running")}
					</p>
				)}
				{running.length > 0 && actionSummary && (
					<CurrentActions running={running} complete={actionSummary.running_complete} />
				)}
				{view && entry && (
					<NodeCharts
						runId={run.id}
						node={view}
						entry={entry}
						readings={
							focus && {
								items: nodeFocusItems(focus, id),
								generatedAt: focus.generated_at,
							}
						}
						focus={focusItems}
						enabled={state.doc && isSavedNodeType(saved, state.doc, id)}
						runEnded={run.status !== "running"}
					/>
				)}
				{view && !entry && node.kind === "package" && (
					<NoCharts
						run={run}
						view={view}
						metrics={state.metrics}
						focused={nodeFocusItems(focus, id).length}
					/>
				)}
				{hasActions && attempt && view && (
					<ActionArea
						summary={actionSummary}
						attempt={attempt.attempt}
						attempts={view.attempts.length}
						day={run.started_at}
					/>
				)}
				{actions.error && !actionSummary && (
					<p role="alert" className="m-0 mt-3 text-xs text-danger-fg">
						{MESSAGE.loadFailed(TERM.action)}：<ErrorMessage error={actions.error} />
					</p>
				)}
				<p className="m-0 mt-3.5 mb-2.5 text-xs text-fg-3">{HINT}</p>
				{view && (
					<div className="flex flex-wrap gap-1.5">
						<Link
							{...runMonitorLink(run.id, { view: "detail", node: id })}
							viewTransition={runViewTransition("to-monitor")}
							className={buttonVariants()}
						>
							{openInLabel(MONITOR_DETAIL_LABEL, runNodeName(view))}
						</Link>
						{hasActions && (
							<Link
								{...runMonitorLink(run.id, { view: "detail", node: id, tab: "actions" })}
								viewTransition={runViewTransition("to-monitor")}
								className={buttonVariants({ variant: "ghost" })}
							>
								{ACTION.openActionDetails}
							</Link>
						)}
					</div>
				)}
			</div>
		</>
	);
}

/**
 * 包节点还没有图表可画时（运行指标目录里没有它：还没开始执行，或者指标已过保留期）写明原因；还会开始执行的，说明开始以后
 * 这里显示它声明的图表、其中几张是关注项。开始执行了、目录还没刷新到时什么也不写。
 */
function NoCharts({
	run,
	view,
	metrics,
	focused,
}: {
	run: RunView;
	view: NodeRunSummary["node"];
	metrics: RunMetricCatalog | undefined;
	/** 属于这个节点的关注项个数。 */
	focused: number;
}) {
	let text: string;
	if (metrics?.expired) text = MESSAGE.metricsExpired;
	else if (!metrics || view.attempts.some((a) => a.started_at !== null)) return null;
	else {
		const later =
			run.status === "running" && (view.status === "pending" || isActiveStatus(view.status));
		text = `${NODE_STATUS[view.status].notRun}${
			later
				? `开始执行以后，这里显示它声明的${TERM.chart}${focused > 0 ? `，其中 ${focused} 张是${TERM.focusItem}` : ""}。`
				: ""
		}`;
	}
	return <p className="m-0 mt-3 text-xs text-fg-3">{text}</p>;
}

function RunOverview({
	state,
	onSelectNode,
	onCollapse,
}: {
	state: CanvasRun;
	onSelectNode(id: string): void;
	onCollapse(): void;
}) {
	const running = state.status === "ready" && state.run.status === "running";
	const now = useNow(running);
	let body: ReactNode;
	switch (state.status) {
		case "loading":
			body = <p className="m-0 text-xs text-fg-3">{MESSAGE.loading}</p>;
			break;
		case "none":
			body = (
				<>
					<p className="m-0 text-sm">这个场景还没有运行过。</p>
					<p className="m-0 mt-1 text-xs text-fg-3">触发一次运行后，这里会显示各节点的状态。</p>
				</>
			);
			break;
		case "error":
			body = (
				<p role="alert" className="m-0 text-xs text-danger-fg">
					{MESSAGE.loadFailed(TERM.run)}：<ErrorMessage error={state.error} />
				</p>
			);
			break;
		case "ready": {
			const { run } = state;
			const s = runStatus(run);
			const end = run.ended_at ? Date.parse(run.ended_at) : now;
			body = (
				<>
					<dl className="m-0 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5 text-xs">
						<Row label="运行">
							{shortId(run.id)} · v{run.orchestration_version}
						</Row>
						<dt className="text-fg-3">状态</dt>
						<dd className="m-0">
							<StatusPill kind={s.kind}>{s.label}</StatusPill>
						</dd>
						<Row label="触发人">{run.triggered_by}</Row>
						<Row label="开始">{formatDateTime(run.started_at)}</Row>
						<Row label={DURATION_LABEL}>
							{formatSpan(end - Date.parse(run.started_at), !run.ended_at)}
						</Row>
					</dl>
					{state.focus?.mode === "focus" && state.focus.items.length > 0 && (
						<RunFocusList
							focus={state.focus}
							runEnded={run.status !== "running"}
							onSelect={(item) => onSelectNode(item.node_id)}
						/>
					)}
					<p className="m-0 mt-3.5 text-xs text-fg-3">选中节点查看它在这次运行里的摘要。{HINT}</p>
				</>
			);
		}
	}
	return (
		<>
			<Header row={<span>运行状态</span>} title="这次运行" onCollapse={onCollapse} />
			<div className="min-h-0 flex-1 overflow-auto px-3.5 py-3 text-sm">{body}</div>
		</>
	);
}

/**
 * 概况里的全部关注项（原型 `#canvas-run` 没有选中节点）：标题旁写个数和其中几项需要注意，读数按控制面排好的顺序
 * （有异常的在最前），每一格是按钮，点了选中它所在的节点。
 */
function RunFocusList({
	focus,
	runEnded,
	onSelect,
}: {
	focus: RunFocus;
	runEnded: boolean;
	onSelect(item: RunFocusItem): void;
}) {
	const headingId = useId();
	return (
		<section aria-labelledby={headingId}>
			<SectionHeading id={headingId}>
				{TERM.focusItem}
				<FocusTally items={focus.items} />
			</SectionHeading>
			<FocusReadoutStrip
				items={focus.items}
				generatedAt={focus.generated_at}
				runEnded={runEnded}
				className="rounded-lg border border-border-soft bg-bg"
				renderItem={(item) => <button type="button" onClick={() => onSelect(item)} />}
			/>
			<p className="m-0 mt-2 text-xs text-fg-3">{FOCUS.anomalyFirst}。点一项选中它所在的节点。</p>
		</section>
	);
}
