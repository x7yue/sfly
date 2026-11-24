import { type NodeDisplayLookup, nodeOutsideCardText, subflowLabels } from "@sfly/orchestration";
import type { ChainRunView, NodeRunView, RunView, StoredOrchestrationDocument } from "@sfly/schema";
import { cn } from "cn";
import { ChevronRightIcon, CrosshairIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NodeName, type RunNodeName, runNodeName } from "#/components/node-name";
import { ResizeHandle } from "#/components/ResizeHandle";
import { useShortcut } from "#/components/shortcuts";
import { nodeStatusView, STATUS, StatusDot, type StatusKind } from "#/components/status";
import {
	ACTION,
	attemptLabel,
	chainCountLabel,
	LIST_LABEL,
	PROGRESS_LABEL,
	QUEUED_LABEL,
} from "#/lib/copy";
import { formatClock, formatDuration, formatSpan } from "#/lib/format";
import { NODE_STATUS } from "#/lib/node-status";
import { shortcutText } from "#/lib/shortcuts";
import { useElementWidth } from "#/lib/use-element-width";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Truncate } from "@/components/ui/truncate";
import { ActionLegend, ActionTracks } from "./ActionTracks";
import type { PreparedTracks, TrackView } from "./action-tracks";
import { TIMELINE_BODY_MAX, TIMELINE_BODY_MAX_PX } from "./detail-layout";
import { useMonitor, useMonitorActions, useScope, useTimeAxis } from "./monitor-state";
import { type NodeRef, nodeKey, sameNode } from "./node-ref";
import {
	chainLabelParts,
	chainRunStatus,
	documentNodes,
	findNode,
	isAlways,
	orderedChains,
	progressLabel,
} from "./run-model";
import {
	AXIS_HEIGHT,
	attentionRow,
	CHAIN_ROW_HEIGHT,
	defaultTimelineMode,
	fractionOf,
	NODE_ROW_HEIGHT,
	nodeSegments,
	ROWS_BOTTOM_PADDING,
	type Segment,
	type SegmentKind,
	type TimeRange,
	ticks,
	timelineContentHeight,
	zoomFromFractions,
	zoomStep,
	zoomToSegments,
} from "./timeline-model";
import { useActionTracks } from "./use-action-tracks";

/** 标签列宽度，所有行共用这一个变量；节点 ID 不截断，显示名称和说明文字在剩余宽度里截断（先截说明）。 */
const LABEL_W = "var(--label-w)";
/** 拖动超过轨道宽度的这个比例才算拖选（否则是点击）。 */
const BRUSH_MIN = 0.004;
/** 拖选范围小于轨道宽度的这个比例时不缩放。 */
const ZOOM_MIN = 0.01;

/** 区段种类对应的状态（docs/DESIGN-SYSTEM.md §6.1）。执行中的段不用实心青（只有段尾的脉冲头是实心）：长时间的运行里最大的几块不能全是饱和青。 */
const SEGMENT_STATUS: Record<SegmentKind, StatusKind> = {
	ok: "ok",
	run: "running",
	fail: "failed",
	wait: "warn",
	queue: "queued",
	cancel: "cancelled",
	stop: "stopped",
};
const segmentArea = (kind: SegmentKind) => STATUS[SEGMENT_STATUS[kind]].area;

const SEGMENT_LABEL: Record<SegmentKind, string> = {
	ok: "执行",
	run: "执行中",
	fail: "失败的尝试",
	cancel: "已取消",
	stop: "已停止",
	queue: "排队等待 Agent",
	wait: "等待子流程结束",
};

const LEGEND: SegmentKind[] = ["ok", "run", "fail", "wait", "queue", "cancel", "stop"];
const LEGEND_LABEL: Record<SegmentKind, string> = {
	...SEGMENT_LABEL,
	ok: "完成",
	fail: "失败尝试",
	queue: QUEUED_LABEL,
};

/** 节点的总耗时：第一段开始到最后一段结束（含排队与等待）。 */
const spanOf = (segments: Segment[]) =>
	segments.length === 0
		? null
		: Math.max(...segments.map((s) => s.end)) - Math.min(...segments.map((s) => s.start));

/**
 * 链路时间线（原型 timelineHTML）：每条链实例一行汇总，可以展开到每个节点一行；子流程实例缩进排在派发它的链后面，
 * 起点画一条调度线。轨道上悬停显示竖线、拖选一段缩放；点节点（标签或区段）选中，底部面板切换到它。
 * 时间范围、悬停、标记与选中都在共享状态里（monitor-state.tsx），图表工作区（#42）同步使用。
 */
export function Timeline({
	run,
	doc,
	bodyMax,
}: {
	run: RunView;
	doc: StoredOrchestrationDocument | undefined;
	/**
	 * 窗口矮时主体最高的高度（px，`detail-layout.ts` 的 `timelineBodyMax`）：默认的上限是视口的 30%，窗口矮的时候再受这个限制，
	 * 图表和底部面板的位置才留得出来；还没量到详情的高度时不给，窗口高时它比 30% 大，不起作用。
	 */
	bodyMax?: number;
}) {
	const { range, extent, live, following, now } = useTimeAxis();
	const zoom = useMonitor((s) => s.zoom);
	const { selected, attempt } = useScope(run);
	const actions = useMonitorActions();
	// 链或节点很多时默认汇总（打开页面时定一次，之后以用户的切换为准）。
	const [mode, setMode] = useState(() =>
		defaultTimelineMode(
			run.chains.length,
			run.chains.reduce((n, c) => n + c.nodes.length, 0),
		),
	);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [height, setHeight] = useState<number | null>(null);
	const body = useRef<HTMLDivElement>(null);
	const chains = useMemo(() => orderedChains(run), [run]);
	const decls = useMemo(() => documentNodes(doc), [doc]);
	// 运行监控页没有节点包元信息：包节点写 `包名/节点类型名`，不查节点类型的标题。
	const display = useMemo<NodeDisplayLookup>(
		() => ({ subflowLabelOf: subflowLabels({ nodes: doc?.nodes ?? [] }) }),
		[doc],
	);
	const nodeCount = run.chains.reduce((n, c) => n + c.nodes.length, 0);
	useShortcut("monitor-toggle-timeline", () =>
		setMode((m) => (m === "expanded" ? "summary" : "expanded")),
	);
	useShortcut("monitor-follow-live", actions.followLive, zoom !== null);

	const isOpen = (chain: Pick<ChainRunView, "id">) =>
		mode === "expanded" && !collapsed.has(chain.id);
	const toggleChain = (chain: ChainRunView) => {
		if (mode === "summary") {
			// 汇总模式下点一条链：只展开这一条。
			setMode("expanded");
			setCollapsed(new Set(chains.filter((c) => c.id !== chain.id).map((c) => c.id)));
			return;
		}
		setCollapsed((s) => {
			const next = new Set(s);
			if (next.has(chain.id)) next.delete(chain.id);
			else next.add(chain.id);
			return next;
		});
	};

	const tracks = useActionTracks(run, isOpen);
	const tracksOf = (chain: Pick<ChainRunView, "id">, nodeId: string) =>
		tracks.get(nodeKey({ chainInstanceId: chain.id, nodeId }));
	const contentHeight = timelineContentHeight(
		chains,
		isOpen,
		(chain) => chain.nodes.filter((n) => tracksOf(chain, n.node_id)).length,
	);
	// 轨道区域的像素宽度（刻度那一行的轨道，没有横向内边距）：动作轨道按它分桶。
	const [axisTrack, width] = useElementWidth<HTMLDivElement>();
	const trackView = useMemo(() => ({ range, now, width }), [range, now, width]);
	const [hidden, setHidden] = useState(false);
	const rows = useRef<HTMLDivElement>(null);
	const reveal = useRevealScope({
		body,
		rows,
		chains,
		isOpen,
		selected,
		scopeTask: attempt?.task_id ?? null,
	});

	const selectedNode = findNode(run, selected);
	const selectedSegments = useMemo(
		() => (selectedNode ? nodeSegments(selectedNode, now) : []),
		[selectedNode, now],
	);
	const zoomTo = (next: TimeRange | null) => (next ? actions.zoom(next) : actions.followLive());
	const canZoomToNode = selectedNode !== undefined && selectedSegments.length > 0;
	const zoomToNode = () => zoomTo(zoomToSegments(selectedSegments, extent));
	useShortcut("monitor-zoom-node", zoomToNode, canZoomToNode);

	return (
		<section
			aria-label="链路时间线"
			className="relative flex-none border-b border-border-soft bg-bg [--label-w:clamp(260px,22cqi,440px)] [container-type:inline-size]"
		>
			<div className="flex min-w-0 items-center gap-2 border-b border-border-soft px-3 py-1.5">
				<h2 className="m-0 flex-none text-sm font-semibold">链路时间线</h2>
				<span className="flex-none text-xs whitespace-nowrap text-fg-3">
					{chainCountLabel(run.chains.length, nodeCount)}
				</span>
				<fieldset
					aria-label="时间线显示"
					className="ml-1.5 flex flex-none rounded-md border border-border p-px whitespace-nowrap"
				>
					{(
						[
							["summary", "汇总"],
							["expanded", "展开节点"],
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							type="button"
							aria-pressed={mode === value}
							onClick={() => {
								setMode(value);
								setCollapsed(new Set());
							}}
							className="h-5.5 rounded-sm px-2 text-xs text-fg-2 aria-pressed:bg-raised-2 aria-pressed:text-fg-1"
						>
							{label}
						</button>
					))}
				</fieldset>
				<span className="flex-1" />
				<ul
					aria-label={LIST_LABEL.legend}
					data-viz
					className="m-0 flex list-none items-center gap-3 p-0 text-xs whitespace-nowrap text-fg-3 max-xl:hidden"
				>
					{LEGEND.map((kind) => {
						const area = segmentArea(kind);
						return (
							<li
								key={kind}
								// 有动作轨道时一行放不下两套图例：窄于 2xl 时只留动作轨道的，区段的状态在行上的状态形状和读屏名称里。
								className={cn(
									"inline-flex items-center gap-1.25",
									tracks.size > 0 && "max-2xl:hidden",
								)}
							>
								<b
									aria-hidden
									className={cn(
										"inline-block w-3.5 rounded-[2px]",
										area.tall ? "h-2.5" : "h-1.5",
										area.box,
									)}
								/>
								{LEGEND_LABEL[kind]}
							</li>
						);
					})}
					{tracks.size > 0 && <ActionLegend />}
				</ul>
				<span aria-hidden className="mx-1 h-4.5 w-px bg-border max-xl:hidden" />
				{zoom && (
					<>
						<span className="font-mono text-2xs text-fg-3" data-testid="zoom-range">
							{formatClock(zoom.start)} – {formatClock(zoom.end)}
						</span>
						{!live && (
							<Button
								size="sm"
								title={`重置时间范围（${shortcutText("monitor-follow-live")}）`}
								onClick={actions.followLive}
							>
								重置时间范围
							</Button>
						)}
					</>
				)}
				{/* 缩放不只能拖选：用键盘或单指针也能放大、缩小、缩放到所选节点 */}
				<fieldset
					aria-label="缩放时间范围"
					title="也可以在轨道上拖选一段时间缩放，拖到一半按 Esc 放弃"
					className="m-0 flex min-w-0 gap-0.5 border-0 p-0"
				>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="放大时间范围"
						onClick={() => zoomTo(zoomStep(range, 0.5, extent))}
					>
						<ZoomInIcon />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="缩小时间范围"
						disabled={!zoom}
						onClick={() => zoomTo(zoomStep(range, 2, extent))}
					>
						<ZoomOutIcon />
					</Button>
					{selectedNode && canZoomToNode && (
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={`缩放到所选节点 ${runNodeName(selectedNode)}`}
							title={`缩放到所选节点 ${runNodeName(selectedNode)}（${shortcutText("monitor-zoom-node")}）`}
							onClick={zoomToNode}
						>
							<CrosshairIcon />
						</Button>
					)}
				</fieldset>
				{live &&
					(following ? (
						<span className="inline-flex h-6.5 items-center gap-1.5 rounded-full border border-signal-line px-2.5 text-xs text-signal-fg">
							<StatusDot kind="running" />
							实时跟随
						</span>
					) : (
						<Button
							size="sm"
							title={`回到实时（${shortcutText("monitor-follow-live")}）`}
							onClick={actions.followLive}
						>
							回到实时
						</Button>
					))}
				<Button
					variant="ghost"
					size="sm"
					aria-expanded={!hidden}
					aria-controls={BODY_ID}
					onClick={() => setHidden((h) => !h)}
				>
					{hidden ? ACTION.expand : ACTION.collapse}时间线
				</Button>
			</div>
			<div
				ref={body}
				id={BODY_ID}
				hidden={hidden}
				{...reveal.userScroll}
				className={cn(
					"relative overflow-auto [container-type:scroll-state] [scrollbar-gutter:stable]",
					// 刻度行吸顶，上沿的阴影吸在它下面
					"before:pointer-events-none before:sticky before:top-5.5 before:z-2 before:-mb-3 before:block before:h-3 before:bg-linear-to-b before:from-black/50 before:to-transparent before:opacity-0 before:transition-opacity",
					"after:pointer-events-none after:sticky after:bottom-0 after:z-2 after:-mt-3 after:block after:h-3 after:bg-linear-to-t after:from-black/50 after:to-transparent after:opacity-0 after:transition-opacity",
					"[@container_scroll-state(scrollable:top)]:before:opacity-100 [@container_scroll-state(scrollable:bottom)]:after:opacity-100",
				)}
				style={
					height === null
						? {
								maxHeight: `min(${contentHeight + 2}px, ${TIMELINE_BODY_MAX}${
									bodyMax === undefined ? "" : `, ${bodyMax}px`
								})`,
							}
						: { height }
				}
			>
				<Axis range={range} origin={Date.parse(run.started_at)} trackRef={axisTrack} />
				<Rows contentRef={rows} run={run} range={range} now={now} live={live} onZoom={actions.zoom}>
					{chains.map((chain) => {
						const open = isOpen(chain);
						return (
							<ChainRows
								key={chain.id}
								chain={chain}
								cancelling={run.cancel !== null}
								open={open}
								range={range}
								now={now}
								trackView={trackView}
								dispatcher={dispatcherOf(run, chain)}
								decls={decls}
								display={display}
								tracksOf={(nodeId) => tracksOf(chain, nodeId)}
								onToggle={() => toggleChain(chain)}
							/>
						);
					})}
				</Rows>
			</div>
			{!hidden && (
				<ResizeHandle
					label="调整时间线高度"
					edge="bottom"
					size={height}
					measure={() => body.current?.clientHeight ?? 0}
					min={56}
					max={() => Math.min(window.innerHeight * 0.62, TIMELINE_BODY_MAX_PX)}
					onResize={setHeight}
					onReset={() => setHeight(null)}
				/>
			)}
		</section>
	);
}

const BODY_ID = "timeline-body";

/**
 * 把范围里的节点（底部面板看的节点和尝试）滚到时间线主体里看得见的地方，不被吸顶的刻度挡住；它所在的链收起时是链的汇总行。
 * 没选中节点时是要保证看得见的那一行（attentionRow：第一个正在执行或失败的节点）。
 *
 * 对准一次不够：轨道在摘要读到以后才多出两行，图表、底部面板加载也会改变时间线主体的高度。所以对准之后保持「对准中」，
 * 主体或行容器的大小每变一次就再对一次，直到用户自己滚动时间线（滚轮、按住、按键）。范围换了（换节点、切尝试）总是重新
 * 对准；没选中节点时只是要注意的那一行换了，用户滚动过以后不再跟着跳。返回要挂在主体上的事件处理。
 */
function useRevealScope({
	body,
	rows,
	chains,
	isOpen,
	selected,
	scopeTask,
}: {
	body: React.RefObject<HTMLDivElement | null>;
	rows: React.RefObject<HTMLDivElement | null>;
	chains: readonly ChainRunView[];
	isOpen: (chain: Pick<ChainRunView, "id">) => boolean;
	/** 范围里的节点和看的那一次尝试的任务 ID（共享状态的 scope，见 monitor-scope.ts）。 */
	selected: NodeRef | null;
	scopeTask: string | null;
}) {
	const rowOf = (chainId: string, nodeId: string | null) =>
		nodeId !== null && isOpen({ id: chainId })
			? `[data-node-item="${CSS.escape(nodeKey({ chainInstanceId: chainId, nodeId }))}"]`
			: `[data-chain-row="${CSS.escape(chainId)}"]`;
	const attention = attentionRow(chains, isOpen);
	const target = selected
		? rowOf(selected.chainInstanceId, selected.nodeId)
		: attention && rowOf(attention.chainId, attention.nodeId);
	const scope = selected ? `${nodeKey(selected)}\n${scopeTask ?? ""}` : null;
	const state = useRef({
		target: null as string | null,
		scope: null as string | null,
		armed: false,
		touched: false,
	});
	const align = useCallback(() => {
		const s = state.current;
		const box = body.current;
		const el = s.armed && s.target ? box?.querySelector<HTMLElement>(s.target) : null;
		if (box && el) revealIn(box, el);
	}, [body]);

	useEffect(() => {
		const s = state.current;
		if (scope !== s.scope) s.armed = scope !== null || !s.touched;
		else if (scope === null && target !== s.target) s.armed = !s.touched;
		s.scope = scope;
		s.target = target;
		align();
	}, [scope, target, align]);

	useEffect(() => {
		const observer = new ResizeObserver(align);
		for (const el of [body.current, rows.current]) if (el) observer.observe(el);
		return () => observer.disconnect();
	}, [body, rows, align]);

	const stop = () => {
		state.current.touched = true;
		state.current.armed = false;
	};
	return {
		userScroll: { onWheel: stop, onPointerDown: stop, onKeyDown: stop, onTouchStart: stop },
	};
}

/**
 * 把 `el` 滚进 `box` 看得见的部分（刻度行下面）；放不下时对齐上沿。滚到的位置对齐到行：停在某一行的中间时，那一行上半被吸顶的
 * 刻度行压住，看着像被切掉（`monitor-actions.png` 里第一行「主链」）——往下滚到下一行的上沿，不超过目标行。
 */
function revealIn(box: HTMLElement, el: HTMLElement) {
	const boxTop = box.getBoundingClientRect().top;
	const topOf = (node: Element) => node.getBoundingClientRect().top - boxTop + box.scrollTop;
	const top = topOf(el);
	const bottom = top + el.offsetHeight;
	let next: number;
	if (top < box.scrollTop + AXIS_HEIGHT) next = top - AXIS_HEIGHT;
	else if (bottom > box.scrollTop + box.clientHeight) {
		next = Math.min(top - AXIS_HEIGHT, bottom - box.clientHeight);
	} else return;
	const limit = top - AXIS_HEIGHT;
	let aligned = next;
	if (next > 0 && next < limit) {
		// 行的上沿（链的汇总行和节点行）：第一个不在 next 之上的，且目标行仍然看得见。
		const edges = [...box.querySelectorAll("[data-chain-row], [data-node-item]")]
			.map((row) => topOf(row) - AXIS_HEIGHT)
			.filter((edge) => edge >= next - 0.5 && edge <= limit + 0.5);
		if (edges.length > 0) aligned = Math.min(...edges);
	}
	box.scrollTop = aligned;
}

/** 时间轴刻度（吸顶）。`trackRef` 挂在轨道区域上，量它的宽度。 */
function Axis({
	range,
	origin,
	trackRef,
}: {
	range: TimeRange;
	origin: number;
	trackRef: (el: HTMLDivElement | null) => void;
}) {
	const items = ticks(range, { origin });
	return (
		<div
			className="sticky top-0 z-3 grid border-b border-border-soft bg-bg"
			style={{ height: AXIS_HEIGHT, gridTemplateColumns: `${LABEL_W} 1fr` }}
		>
			<div className="px-3 pt-0.75 text-xs text-fg-3">
				<span className="font-mono">{formatClock(range.start)}</span> 起
			</div>
			<div ref={trackRef} className="relative mr-3.5" data-axis-track>
				{items.map((t) => (
					<span
						key={t.at}
						className="absolute top-0.75 -translate-x-1/2 font-mono text-2xs whitespace-nowrap text-fg-3"
						style={{ left: `${fractionOf(t.at, range) * 100}%` }}
					>
						{t.label}
					</span>
				))}
			</div>
		</div>
	);
}

/**
 * 行容器：在轨道区域上处理悬停（竖线）、拖选（缩放）与点击区段（选中节点），并画网格线、现在、日志标记与悬停竖线。
 */
function Rows({
	contentRef,
	run,
	range,
	now,
	live,
	onZoom,
	children,
}: {
	/** 行容器：它的高度变了（例如读到动作以后多出轨道），时间线重新把范围里的节点对准。 */
	contentRef: React.Ref<HTMLDivElement>;
	run: RunView;
	range: TimeRange;
	now: number;
	live: boolean;
	onZoom: (range: TimeRange) => void;
	children: React.ReactNode;
}) {
	const actions = useMonitorActions();
	const hoverAt = useMonitor((s) => s.hoverAt);
	const marker = useMonitor((s) => s.marker);
	const lines = useRef<HTMLDivElement>(null);
	const [brush, setBrush] = useState<{ from: number; to: number; moved: boolean } | null>(null);
	const brushRef = useRef(brush);
	brushRef.current = brush;
	const captured = useRef<{ element: Element; id: number } | null>(null);
	const brushing = brush !== null;
	// 拖选到一半的 Esc 只放弃拖选：捕获阶段拦下，不再把选中的节点一并清除。
	useEffect(() => {
		if (!brushing) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			brushRef.current = null;
			setBrush(null);
			const held = captured.current;
			if (held?.element.hasPointerCapture(held.id)) held.element.releasePointerCapture(held.id);
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [brushing]);

	/** 指针在轨道上的位置（0–1）；在标签列上时为 null。 */
	const fractionAt = (clientX: number) => {
		const rect = lines.current?.getBoundingClientRect();
		if (!rect || rect.width === 0) return null;
		const f = (clientX - rect.left) / rect.width;
		return f < 0 ? null : Math.min(1, f);
	};
	const timeAt = (f: number) => range.start + f * (range.end - range.start);
	const show = (t: number | null) => t !== null && t >= range.start && t <= range.end;
	const at = (t: number) => `${fractionOf(t, range) * 100}%`;
	const items = ticks(range, { origin: Date.parse(run.started_at) });

	return (
		// 指针悬停与拖选只是可视化辅助；节点用标签列的按钮选中（键盘可达）。
		<div
			ref={contentRef}
			className="relative select-none"
			style={{ paddingBottom: ROWS_BOTTOM_PADDING }}
			onPointerMove={(e) => {
				const f = fractionAt(e.clientX);
				actions.hover(f === null ? null : timeAt(f));
				const b = brushRef.current;
				if (b && f !== null) {
					setBrush({ ...b, to: f, moved: b.moved || Math.abs(f - b.from) > BRUSH_MIN });
				}
			}}
			onPointerLeave={() => {
				if (!brushRef.current) actions.hover(null);
			}}
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				const f = fractionAt(e.clientX);
				if (f === null) return;
				e.currentTarget.setPointerCapture(e.pointerId);
				captured.current = { element: e.currentTarget, id: e.pointerId };
				setBrush({ from: f, to: f, moved: false });
			}}
			onPointerUp={(e) => {
				const b = brushRef.current;
				setBrush(null);
				if (!b) return;
				const f = fractionAt(e.clientX) ?? b.to;
				if (b.moved) {
					if (Math.abs(f - b.from) > ZOOM_MIN) onZoom(zoomFromFractions(range, b.from, f));
					return;
				}
				// 没有拖动：点的是区段就选中它的节点（指针捕获后 target 是容器，按坐标找区段）。
				const hit = document
					.elementsFromPoint(e.clientX, e.clientY)
					.find((el) => el instanceof HTMLElement && el.dataset.segment);
				const ref = hit instanceof HTMLElement ? hit.dataset : undefined;
				if (ref?.chain && ref.node)
					actions.report({
						type: "select",
						node: { chainInstanceId: ref.chain, nodeId: ref.node },
					});
			}}
			onPointerCancel={() => setBrush(null)}
		>
			<ul className="m-0 list-none p-0">{children}</ul>
			<div
				ref={lines}
				aria-hidden
				className="pointer-events-none absolute top-0 right-3.5 bottom-0"
				style={{ left: LABEL_W }}
			>
				{items.map((t) => (
					<i
						key={t.at}
						className="absolute top-0 bottom-0 w-px bg-fg-1/4"
						style={{ left: at(t.at) }}
					/>
				))}
				{live && show(now) && (
					<div
						data-now-line
						className="absolute top-0 bottom-0 z-2 w-px bg-signal-line"
						style={{ left: at(now) }}
					/>
				)}
				{marker !== null && show(marker) && (
					<div
						data-marker-line
						className="absolute top-0 bottom-0 z-4 ml-px border-l-[1.5px] border-dashed border-fg-1"
						style={{ left: at(marker) }}
					/>
				)}
				{hoverAt !== null && show(hoverAt) && (
					<div
						data-hover-line
						className="absolute top-0 bottom-0 z-4 w-px bg-fg-1/55"
						style={{ left: at(hoverAt) }}
					/>
				)}
				{brush?.moved && (
					<div
						data-brush
						className="absolute top-0 bottom-0 z-3 border-x border-fg-1/40 bg-fg-1/7"
						style={{
							left: `${Math.min(brush.from, brush.to) * 100}%`,
							width: `${Math.abs(brush.to - brush.from) * 100}%`,
						}}
					/>
				)}
			</div>
		</div>
	);
}

/** 派发子流程实例的异步任务节点（在父链实例上）；主链为 null。 */
function dispatcherOf(run: RunView, chain: ChainRunView): RunNodeName | null {
	if (chain.async_node_id === null) return null;
	const ref = {
		chainInstanceId: chain.parent_chain_instance_id ?? "",
		nodeId: chain.async_node_id,
	};
	return findNode(run, ref) ?? { node_id: chain.async_node_id };
}

function ChainRows({
	chain,
	cancelling,
	open,
	range,
	now,
	trackView,
	dispatcher,
	decls,
	display,
	tracksOf,
	onToggle,
}: {
	chain: ChainRunView;
	/** 运行已取消、正在等待结束。 */
	cancelling: boolean;
	open: boolean;
	range: TimeRange;
	now: number;
	/** 动作轨道看的范围、现在和像素宽度。 */
	trackView: TrackView;
	/** 派发这个子流程实例的异步任务节点；主链为 null。 */
	dispatcher: RunNodeName | null;
	decls: ReturnType<typeof documentNodes>;
	display: NodeDisplayLookup;
	/** 这条链上有动作的节点的轨道数据；没有动作的节点为 undefined。 */
	tracksOf: (nodeId: string) => PreparedTracks | undefined;
	onToggle: () => void;
}) {
	const selected = useMonitor((s) => s.scope.selected);
	const status = chainRunStatus(chain, cancelling);
	const segments = chain.nodes.map((n) => nodeSegments(n, now));
	const end = chain.ended_at ? Date.parse(chain.ended_at) : now;
	const indent = chain.depth * 14;
	const label = chainLabelParts(chain);
	return (
		<li>
			<div
				data-chain-row={chain.id}
				className="grid scroll-mt-5.5 items-center border-b border-fg-1/3 bg-fg-1/2"
				style={{ height: CHAIN_ROW_HEIGHT, gridTemplateColumns: `${LABEL_W} 1fr` }}
			>
				<button
					type="button"
					aria-expanded={open}
					onClick={onToggle}
					title={dispatcher ? `由 ${runNodeName(dispatcher)} 派发` : undefined}
					className="flex h-full min-w-0 items-center gap-1.5 pr-2.5 text-left text-xs whitespace-nowrap"
					style={{ paddingLeft: 12 + indent }}
				>
					<span className="grid w-3.5 flex-none place-items-center text-fg-3">
						{chain.nodes.length > 0 && (
							<ChevronRightIcon
								className="size-3.5 transition-[rotate] duration-(--motion-base) ease-(--motion-ease-out) motion-reduce:transition-none"
								style={{ rotate: open ? "90deg" : "0deg" }}
							/>
						)}
					</span>
					<StatusDot kind={status.kind} />
					<span className="sr-only">{status.label}</span>
					<b className="min-w-0 truncate font-semibold">
						{label.name}
						{label.id && (
							<>
								{" · "}
								<span className="font-mono font-normal">{label.id}</span>
							</>
						)}
					</b>
					{dispatcher && (
						<span className="min-w-0 truncate font-mono text-2xs text-fg-3 @max-[1100px]:hidden">
							← {runNodeName(dispatcher)}
						</span>
					)}
					<span className="ml-auto min-w-13 flex-none text-right font-mono text-2xs text-fg-3">
						{formatSpan(end - Date.parse(chain.started_at), !chain.ended_at)}
					</span>
				</button>
				<div aria-hidden data-viz className="relative mr-3.5 h-full">
					{chain.depth > 0 && (
						<DispatchLine
							at={Date.parse(chain.started_at)}
							range={range}
							from={dispatcher ? runNodeName(dispatcher) : null}
						/>
					)}
					{chain.nodes.map((node, i) =>
						(segments[i] ?? []).map((seg) => (
							<SegmentBar
								key={`${node.node_id}:${seg.taskId}:${seg.kind}`}
								seg={seg}
								range={range}
								node={{ chainInstanceId: chain.id, nodeId: node.node_id }}
								name={runNodeName(node)}
								selected={sameNode(selected, { chainInstanceId: chain.id, nodeId: node.node_id })}
								chainRow
								// 展开时每个节点自己的行有脉冲头，汇总行不再画一份。
								pulse={!open}
							/>
						)),
					)}
				</div>
			</div>
			{open && (
				<ul className="m-0 list-none p-0">
					{chain.nodes.map((node, i) => (
						<NodeRow
							key={node.node_id}
							chain={chain}
							node={node}
							segments={segments[i] ?? []}
							range={range}
							trackView={trackView}
							tracks={tracksOf(node.node_id)}
							decls={decls}
							display={display}
							indent={indent}
							selected={sameNode(selected, { chainInstanceId: chain.id, nodeId: node.node_id })}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

/**
 * 一个节点一行；有动作的节点下面再接两条轨道（ActionTracks），链收起时一起收起。范围里的节点（选中的）用 `selected-row`：
 * 中性底色加左侧 2px 白色短条。
 */
function NodeRow({
	chain,
	node,
	segments,
	range,
	trackView,
	tracks,
	decls,
	display,
	indent,
	selected,
}: {
	chain: ChainRunView;
	node: NodeRunView;
	segments: Segment[];
	range: TimeRange;
	trackView: TrackView;
	tracks: PreparedTracks | undefined;
	decls: ReturnType<typeof documentNodes>;
	display: NodeDisplayLookup;
	indent: number;
	selected: boolean;
}) {
	const actions = useMonitorActions();
	const decl = decls.get(node.node_id);
	const status = nodeStatusView(node.status);
	const span = spanOf(segments);
	const progress = progressLabel(node);
	const ref = { chainInstanceId: chain.id, nodeId: node.node_id };
	const name = runNodeName(node);
	const title = nodeOutsideCardText(decl, node.kind, display);
	// 包节点的说明是「包/节点类型」，同一次运行里包名几乎都一样：行上只留区分度高的节点类型，完整的在悬停提示与读屏名称里。
	const packageNode = decl?.kind === "package";
	const shortTitle = packageNode ? decl.node : title;
	return (
		<li data-node-item={nodeKey(ref)}>
			<div
				data-node-row={node.node_id}
				data-selected={selected || undefined}
				className="grid items-center border-b border-fg-1/3 data-selected:selected-row"
				style={{ height: NODE_ROW_HEIGHT, gridTemplateColumns: `${LABEL_W} 1fr` }}
			>
				{/* 行上的节点名和说明被截断时，悬停或聚焦这个按钮就显示全文（按钮是唯一的停靠点，里面的 Truncate 只截断）。 */}
				<Truncate
					label={name === node.node_id ? title : `${name} · ${title}`}
					render={
						<button
							type="button"
							aria-pressed={selected}
							aria-label={`${name} ${title} ${status.label}${progress ? ` ${PROGRESS_LABEL} ${progress}` : ""}`}
							// 轨道上的区段只给鼠标（悬停看详情、点选节点），每次尝试写在这里：一行只有一个停靠点。
							aria-description={
								segments
									.map(
										(seg) =>
											`${attemptLabel(seg.attempt)}：${SEGMENT_LABEL[seg.kind]} ${formatDuration(seg.end - seg.start)}`,
									)
									.join("；") || undefined
							}
							onClick={() => actions.report({ type: "select", node: selected ? null : ref })}
							className="flex h-full min-w-0 items-center gap-1.5 pr-2.5 text-left text-xs whitespace-nowrap"
							style={{ paddingLeft: 30 + indent }}
						/>
					}
				>
					<StatusDot kind={status.kind} />
					{/* 名称列很窄：显示名称优先，放不下时先截断节点 ID；后面的节点类型只用名称之后剩下的宽度。 */}
					<NodeName node={node} priority="name" />
					{/*
					 * 节点类型：名称和 ID 之后剩下的宽度放得下才整个显示，放不下就整个收起（和「（节点 ID）」一样换到被裁掉的第二行），
					 * 不留半个字、几像素的竖线残片。
					 */}
					<span
						data-truncate-wrap=""
						className={cn(
							"flex h-[1lh] min-w-0 flex-1 flex-wrap overflow-hidden text-xs text-fg-3",
							packageNode && "font-mono",
						)}
					>
						{/* 弹性布局里只有一项时不会换行：先放一个零宽、一行高的占位，节点类型放不下才会换到被裁掉的第二行。 */}
						<span aria-hidden className="h-[1lh] w-0 flex-none" />
						<span className="flex-none whitespace-nowrap">{shortTitle}</span>
					</span>
					{node.attempts.length > 1 && <Badge className="h-4 px-1">×{node.attempts.length}</Badge>}
					{isAlways(decl) && (
						<Badge variant="warn" className="h-4 px-1">
							always
						</Badge>
					)}
					{progress && (
						<span data-progress className="ml-auto flex-none font-mono text-2xs text-fg-3">
							{progress}
						</span>
					)}
					<span
						className={cn(
							"min-w-13 flex-none text-right font-mono text-2xs text-fg-3",
							!progress && "ml-auto",
						)}
					>
						{span === null ? NODE_STATUS[node.status].notRunDuration : formatDuration(span)}
					</span>
				</Truncate>
				<div aria-hidden data-viz className="relative mr-3.5 h-full">
					{segments.map((seg) => (
						<SegmentBar
							key={`${seg.taskId}:${seg.kind}`}
							seg={seg}
							range={range}
							node={ref}
							name={name}
							selected={selected}
						/>
					))}
				</div>
			</div>
			{tracks && (
				<ActionTracks prepared={tracks} view={trackView} node={ref} name={name} indent={indent} />
			)}
		</li>
	);
}

/**
 * 一段区段：外层是满高的点击热区，里面按状态表画可见的形状。
 * 执行中的段在段尾有一个脉冲头：每个执行中的节点在一屏里只脉冲这一处（`pulse` 关掉时不画光环：这是汇总行；暂停动效由 app.css 统一处理）。
 */
function SegmentBar({
	seg,
	range,
	node,
	name,
	selected,
	chainRow,
	pulse = true,
}: {
	seg: Segment;
	range: TimeRange;
	node: NodeRef;
	/** 悬停提示里的节点：「显示名称（节点 ID）」。 */
	name: string;
	selected: boolean;
	chainRow?: boolean;
	pulse?: boolean;
}) {
	if (seg.end < range.start || seg.start > range.end) return null;
	const left = Math.max(0, fractionOf(seg.start, range)) * 100;
	const right = Math.min(1, fractionOf(seg.end, range)) * 100;
	const area = segmentArea(seg.kind);
	return (
		// 点选由行容器按坐标处理（拖选时指针被容器捕获）。
		<span
			data-segment={seg.kind}
			data-chain={node.chainInstanceId}
			data-node={node.nodeId}
			title={`${name} · ${attemptLabel(seg.attempt)} · ${SEGMENT_LABEL[seg.kind]} · ${formatDuration(seg.end - seg.start)}`}
			className={cn("absolute h-3 min-w-0.5 cursor-pointer", chainRow ? "top-2.25" : "top-1.75")}
			style={{ left: `${left}%`, width: `max(${Math.max(0.25, right - left)}%, 2px)` }}
		>
			<i
				aria-hidden
				className={cn(
					"absolute inset-x-0 rounded-[2px]",
					area.tall ? "inset-y-0" : "inset-y-0.75",
					area.box,
					selected && "outline-[1.5px] outline-offset-1 outline-selected",
				)}
			/>
			{seg.live && seg.kind === "run" && (
				<i
					aria-hidden
					data-pulse-head
					className={cn(
						"absolute -top-0.5 -right-0.75 h-4 w-1.5 rounded-[2px] bg-signal",
						STATUS.running.tone,
						pulse && "pulse-ring",
					)}
				/>
			)}
		</span>
	);
}

/** 子流程实例的起点：派发它的时刻画一条青色虚线（调度连线）。 */
function DispatchLine({ at, range, from }: { at: number; range: TimeRange; from: string | null }) {
	if (at < range.start || at > range.end) return null;
	return (
		<span
			data-dispatch-line
			title={`由 ${from} 派发`}
			className="absolute top-0.5 bottom-0.5 w-0 border-l border-dashed border-signal-line"
			style={{ left: `${fractionOf(at, range) * 100}%` }}
		/>
	);
}
