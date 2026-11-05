import {
	Background,
	BackgroundVariant,
	type IsValidConnection,
	MiniMap,
	type NodeChange,
	type OnConnect,
	type OnConnectEnd,
	type OnEdgesChange,
	type OnNodesChange,
	ReactFlow,
	useReactFlow,
	useStore,
} from "@xyflow/react";
import { cn } from "cn";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShortcut } from "#/components/shortcuts";
import { CanvasDock, type CanvasTool } from "./CanvasDock";
import {
	type CanvasContextValue,
	type CanvasInfo,
	FlowCanvasContext,
	type NodeDecoration,
	type PortState,
} from "./context";
import { edgeTypes } from "./FlowEdge";
import type { SfEdge, SfNode } from "./flow";
import {
	type CanvasInsets,
	FIT_MAX_ZOOM,
	FLOAT_GAP,
	LOD_THRESHOLD,
	MAX_ZOOM,
	MIN_ZOOM,
	NODE_HEIGHT,
	NODE_WIDTH,
} from "./geometry";
import { nodeTypes } from "./NodeCard";
import { isNavigationKey, navigateChain } from "./navigation";
import { SubflowRegions } from "./SubflowRegions";

/**
 * 可配置的编排画布（#35；以 xyflow 官方 React Flow UI 组件为起点）：铺满容器，控件悬浮在上面。
 *
 * 画布本身负责：节点卡片、连线、子流程区域、语义缩放（--canvas-zoom / data-lod，见 zoom-text.ts）、
 * 打开时与窗口变化时自动适配视图（避开 `insets` 指出的悬浮控件）、底部工具条、左下小地图、
 * 键盘浏览（方向键沿链切换、↓/↑ 进出子流程、Enter 交给 onEnter、Esc 取消选中；不用方向键移动节点）。
 *
 * 使用方负责：节点与连线的状态（受控）、选中哪个节点、右侧检查器和其他悬浮控件（children）。
 *
 * 扩展点（后续票据复用这一个组件，不再各写一套画布）：
 * - `editable={false}`：只读（不能拖动、连线、删除），用于运行状态（#41）与版本对比（#40）；
 * - `decorateNode` / `decorateEdge` / `regionMeta`：叠加运行状态、主指标槽、差异标记（见 context.ts）；
 * - `dockStart` / `dockTools`：工具条上的「＋ 添加节点」与撤销 / 重做 / 整理布局（#39）；
 * - `onNodesChange` / `onEdgesChange` / `onConnect`：编辑操作，撤销栈（#39）可以包在外面。
 *
 * 必须放在 ReactFlowProvider 里（使用方也要用 useReactFlow 时把 provider 放在更外层）。
 */
export interface FlowCanvasProps {
	/** 画布区域的无障碍名称。 */
	label: string;
	nodes: SfNode[];
	edges: SfEdge[];
	info: CanvasInfo;
	selectedId: string | null;
	onSelect(id: string | null): void;
	/** 可以拖动节点、连线、删除（默认 false：只读）。 */
	editable?: boolean;
	onNodesChange?: OnNodesChange<SfNode>;
	onEdgesChange?: OnEdgesChange<SfEdge>;
	onConnect?: OnConnect;
	onConnectEnd?: OnConnectEnd;
	isValidConnection?: IsValidConnection<SfEdge>;
	/** 视口四周被悬浮控件占住的区域（不含工具条与小地图，画布自己会加上）。 */
	insets: CanvasInsets;
	decorateNode?: (id: string, node: SfNode["data"]["node"]) => NodeDecoration | undefined;
	decorateEdge?: CanvasContextValue["decorateEdge"];
	regionMeta?: CanvasContextValue["regionMeta"];
	/** 选中节点时按 Enter（焦点在画布上）：通常把焦点移到检查器。 */
	onEnter?(id: string): void;
	/** 检查器开关（工具条按钮与 I 键）；检查器本身由使用方渲染。 */
	inspector?: { open: boolean; onToggle(): void };
	/** 打开时是否显示小地图（默认显示；版本对比的窄画布默认收起）。 */
	initialMinimap?: boolean;
	dockStart?: ReactNode;
	dockTools?: ReactNode;
	/** 悬浮在画布上的控件（左上、右上的控件组、检查器……）。 */
	children?: ReactNode;
}

/** 工具条（底部居中，高 42 + 下边距 14）占住的高度。 */
const DOCK_SPACE = 72;
const OPEN_DIALOG = '[role="dialog"][data-open], [role="alertdialog"][data-open]';

const isEditable = (el: Element | null) =>
	el instanceof HTMLElement &&
	(el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

export function FlowCanvas({
	label,
	nodes,
	edges,
	info,
	selectedId,
	onSelect,
	editable = false,
	onNodesChange,
	onEdgesChange,
	onConnect,
	onConnectEnd,
	isValidConnection,
	insets,
	decorateNode,
	decorateEdge,
	regionMeta,
	onEnter,
	inspector,
	initialMinimap = true,
	dockStart,
	dockTools,
	children,
}: FlowCanvasProps) {
	const flow = useReactFlow<SfNode, SfEdge>();
	const wrapper = useRef<HTMLDivElement>(null);
	const [tool, setTool] = useState<CanvasTool>("pointer");
	const [minimap, setMinimap] = useState(initialMinimap);

	const ports = useMemo(() => {
		const map = new Map<string, PortState>();
		const get = (id: string) => {
			let p = map.get(id);
			if (!p) {
				p = { in: false, out: false, dispatch: false };
				map.set(id, p);
			}
			return p;
		};
		for (const e of edges) {
			if (e.data?.kind === "dispatch") get(e.source).dispatch = true;
			else get(e.source).out = true;
			get(e.target).in = true;
		}
		return map;
	}, [edges]);

	const context = useMemo<CanvasContextValue>(
		() => ({ info, selectedId, ports, decorateNode, decorateEdge, regionMeta }),
		[info, selectedId, ports, decorateNode, decorateEdge, regionMeta],
	);

	// 选中由使用方控制（单选）；React Flow 自己的 select 变化不往外传。
	const shownNodes = useMemo(
		() =>
			nodes.map((n) =>
				n.selected === (n.id === selectedId) ? n : { ...n, selected: n.id === selectedId },
			),
		[nodes, selectedId],
	);
	const handleNodesChange = useCallback(
		(changes: NodeChange<SfNode>[]) => {
			const rest = changes.filter((c) => c.type !== "select");
			if (rest.length > 0) onNodesChange?.(rest);
		},
		[onNodesChange],
	);

	// —— 视图：适配时避开悬浮控件 ——
	const area = useMemo(
		() => ({
			top: insets.top + FLOAT_GAP,
			right: insets.right + FLOAT_GAP,
			bottom: insets.bottom + DOCK_SPACE,
			left: insets.left + FLOAT_GAP,
		}),
		[insets],
	);
	const fitOptions = useMemo(
		() => ({
			padding: {
				top: `${area.top + 24}px`,
				right: `${area.right + 24}px`,
				bottom: `${area.bottom + 16}px`,
				left: `${area.left + 24}px`,
			} as const,
			maxZoom: FIT_MAX_ZOOM,
			minZoom: MIN_ZOOM,
		}),
		[area],
	);
	const fit = useCallback(() => {
		void flow.fitView({ ...fitOptions, duration: 200 });
	}, [flow, fitOptions]);
	const fitRef = useRef(fitOptions);
	fitRef.current = fitOptions;
	useEffect(() => {
		const onResize = () => void flow.fitView(fitRef.current);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [flow]);

	/** 节点不在可见区域（扣掉悬浮控件）里时，把它移到可见区域中央。 */
	const reveal = useCallback(
		(id: string) => {
			const node = flow.getInternalNode(id);
			const el = wrapper.current;
			if (!node || !el) return;
			const { x, y, zoom } = flow.getViewport();
			const { x: nx, y: ny } = node.internals.positionAbsolute;
			const W = el.clientWidth;
			const H = el.clientHeight;
			const left = nx * zoom + x;
			const top = ny * zoom + y;
			const visible =
				left >= area.left &&
				top >= area.top &&
				left + NODE_WIDTH * zoom <= W - area.right &&
				top + NODE_HEIGHT * zoom <= H - area.bottom;
			if (visible) return;
			const cx = area.left + (W - area.left - area.right) / 2;
			const cy = area.top + (H - area.top - area.bottom) / 2;
			void flow.setViewport(
				{
					x: cx - (nx + NODE_WIDTH / 2) * zoom,
					y: cy - (ny + NODE_HEIGHT / 2) * zoom,
					zoom,
				},
				{ duration: 200 },
			);
		},
		[flow, area],
	);

	// —— 键盘：方向键沿链切换、Enter、Esc ——
	const latest = useRef({ nodes, edges, selectedId, onSelect, onEnter, reveal });
	latest.current = { nodes, edges, selectedId, onSelect, onEnter, reveal };
	useEffect(() => {
		const focusNode = (id: string) =>
			requestAnimationFrame(() => {
				const card = wrapper.current?.querySelector<HTMLElement>(
					`[data-node-id="${CSS.escape(id)}"]`,
				);
				card?.focus({ preventScroll: true });
			});
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
			const target = event.target instanceof Element ? event.target : null;
			const root = wrapper.current;
			if (!root || isEditable(target) || document.querySelector(OPEN_DIALOG)) return;
			// 焦点在画布本身（空白处、节点卡片）或页面上没有焦点时才处理，工具条按钮等保持原样。
			const onCanvas =
				target === document.body ||
				target === root ||
				target?.closest("[data-node-id]") !== null ||
				target?.classList.contains("react-flow__pane");
			if (!onCanvas || !(target === document.body || root.contains(target))) return;
			const { nodes, edges, selectedId, onSelect, onEnter, reveal } = latest.current;
			if (isNavigationKey(event.key)) {
				event.preventDefault();
				const next = navigateChain(
					{
						nodes: nodes.map((n) => ({ id: n.id, kind: n.data.node.kind })),
						edges: edges.map((e) => ({
							from: e.source,
							to: e.target,
							kind: e.data?.kind ?? "chain",
						})),
					},
					selectedId,
					event.key,
				);
				if (next) {
					onSelect(next);
					reveal(next);
					focusNode(next);
				}
			} else if (event.key === "Enter" && selectedId) {
				event.preventDefault();
				onEnter?.(selectedId);
			} else if (event.key === "Escape" && selectedId) {
				event.preventDefault();
				onSelect(null);
				root.focus({ preventScroll: true });
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	useShortcut("canvas-fit", fit);
	useShortcut("canvas-pointer", () => setTool("pointer"));
	useShortcut("canvas-hand", () => setTool("hand"));
	useShortcut("canvas-minimap", () => setMinimap((m) => !m));
	useShortcut("canvas-inspector", () => inspector?.onToggle(), inspector !== undefined);

	const canEdit = editable && tool === "pointer";
	return (
		<FlowCanvasContext.Provider value={context}>
			{/* biome-ignore lint/a11y/useSemanticElements: 画布容器需要可聚焦（Esc 后焦点回到这里），section 不合适 */}
			<div
				ref={wrapper}
				role="region"
				aria-label={label}
				tabIndex={-1}
				data-lod={false}
				data-tool={tool}
				style={{ "--canvas-zoom": 1 } as React.CSSProperties}
				className={cn(
					// 画布铺满视口：焦点环画在内侧（DESIGN-SYSTEM §7）。
					"absolute inset-0 overflow-hidden bg-canvas-bg -outline-offset-2",
					"[&_.react-flow__viewport-portal]:pointer-events-none",
					"data-[tool=hand]:[&_.react-flow__pane]:cursor-grab data-[tool=hand]:[&_.react-flow__node]:cursor-grab",
				)}
			>
				<ReactFlow<SfNode, SfEdge>
					nodes={shownNodes}
					edges={edges}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					onNodesChange={handleNodesChange}
					onEdgesChange={onEdgesChange}
					onConnect={onConnect}
					onConnectEnd={onConnectEnd}
					isValidConnection={isValidConnection}
					onNodeClick={(_e, node) => onSelect(node.id)}
					onPaneClick={() => onSelect(null)}
					nodesDraggable={canEdit}
					nodesConnectable={canEdit}
					edgesFocusable={false}
					elementsSelectable
					selectNodesOnDrag={false}
					deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
					multiSelectionKeyCode={null}
					selectionKeyCode={null}
					disableKeyboardA11y
					fitView
					fitViewOptions={fitOptions}
					minZoom={MIN_ZOOM}
					maxZoom={MAX_ZOOM}
					colorMode="dark"
					proOptions={{ hideAttribution: true }}
					ariaLabelConfig={{ "minimap.ariaLabel": "小地图" }}
				>
					<ZoomVariables target={wrapper} />
					<SubflowRegions nodes={shownNodes} edges={edges} />
					<Background
						variant={BackgroundVariant.Dots}
						gap={22}
						size={1}
						color="var(--canvas-grid)"
						bgColor="var(--canvas-bg)"
					/>
					{minimap && (
						<MiniMap<SfNode>
							position="bottom-left"
							pannable
							zoomable
							className="m-0! mb-3.5! ml-3! overflow-hidden rounded-xl border border-border-soft shadow-float"
							style={{ width: 188, height: 118 }}
							bgColor="var(--surface)"
							maskColor="var(--canvas-minimap-mask)"
							maskStrokeColor="var(--fg-3)"
							maskStrokeWidth={2}
							nodeBorderRadius={12}
							nodeColor={(n) => minimapColor(decorateNode?.(n.id, n.data.node)?.run)}
							nodeStrokeColor={(n) => (n.id === selectedId ? "var(--selected)" : "transparent")}
							nodeStrokeWidth={8}
						/>
					)}
				</ReactFlow>
				<CanvasDock
					tool={tool}
					onTool={setTool}
					onFit={fit}
					minimap={minimap}
					onToggleMinimap={() => setMinimap((m) => !m)}
					inspector={inspector}
					start={dockStart}
					tools={dockTools}
				/>
				{children}
			</div>
		</FlowCanvasContext.Provider>
	);
}

/** 小地图上节点的颜色：编辑模式统一灰色，运行状态（#41）按状态着色。 */
function minimapColor(run: NodeDecoration["run"]): string {
	switch (run) {
		case "running":
			return "var(--canvas-run-running)";
		case "failed":
			return "var(--canvas-run-failed)";
		case "done":
			return "var(--ok)";
		case "waiting":
			return "var(--warn)";
		default:
			return "var(--canvas-edge)";
	}
}

/** 把当前缩放比例写到画布容器上（--canvas-zoom、data-lod），供语义缩放的 CSS 使用。 */
function ZoomVariables({ target }: { target: React.RefObject<HTMLDivElement | null> }) {
	const zoom = useStore((s) => s.transform[2]);
	useEffect(() => {
		const el = target.current;
		if (!el) return;
		el.style.setProperty("--canvas-zoom", String(zoom));
		el.dataset.lod = String(zoom < LOD_THRESHOLD);
	}, [zoom, target]);
	return null;
}
