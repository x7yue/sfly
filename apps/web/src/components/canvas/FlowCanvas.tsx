import type { EdgeEnds, Position } from "@sfly/orchestration";
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
	type ReactFlowProps,
	useReactFlow,
	useStore,
	useStoreApi,
} from "@xyflow/react";
import { cn } from "cn";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useShortcut } from "#/components/shortcuts";
import { dialogOpen, isEditable } from "#/lib/focus";
import { ContextMenu } from "@/components/ui/context-menu";
import { CanvasDock, type CanvasTool } from "./CanvasDock";
import { type CanvasMenuTarget, FitViewMenuItem, menuAnchor } from "./CanvasMenu";
import {
	type CanvasContextValue,
	type CanvasInfo,
	FlowCanvasContext,
	type NodeDecoration,
	type PortState,
} from "./context";
import { edgeTypes } from "./FlowEdge";
import { type DocEdge, docEdgeOf, edgeId, type SfEdge, type SfNode } from "./flow";
import {
	type CanvasInsets,
	FIT_MAX_ZOOM,
	FLOAT_GAP,
	LOD_THRESHOLD,
	MAX_ZOOM,
	MIN_ZOOM,
	MINIMAP_SIZE,
	NODE_HEIGHT,
	NODE_WIDTH,
	RECONNECT_RADIUS,
} from "./geometry";
import { VIEWPORT_MS, viewportDuration } from "./motion";
import { nodeTypes } from "./NodeCard";
import { isNavigationKey, navigateChain } from "./navigation";
import { SubflowRegions } from "./SubflowRegions";
import {
	type CanvasSelection,
	isNodeSelected,
	NO_SELECTION,
	selectNode,
	soleNode,
} from "./selection";

/**
 * 可配置的编排画布（#35；以 xyflow 官方 React Flow UI 组件为起点）：铺满容器，控件悬浮在上面。
 *
 * 画布本身负责：节点卡片、连线、子流程区域、语义缩放（--canvas-zoom / data-lod，见 zoom-text.ts）、
 * 打开时与窗口变化时自动适配视图（避开 `insets` 指出的悬浮控件）、底部工具条、左下小地图、
 * 键盘浏览（方向键沿链切换、↓/↑ 进出子流程、Enter 交给 onEnter、Esc 取消选中；不用方向键移动节点）。
 *
 * 使用方负责：节点与连线的状态（受控）、选中状态（受控，见 selection.ts）、右侧检查器和其他悬浮控件（children）。
 *
 * 扩展点（后续票据复用这一个组件，不再各写一套画布）：
 * - `editable={false}`：只读（不能拖动、连线、删除），用于运行状态（#41）与版本对比（#40）；
 * - `decorateNode` / `decorateEdge` / `regionMeta`：叠加运行状态、主指标槽、差异标记（见 context.ts）；
 * - `menu`：右键菜单的内容（CanvasMenu.tsx）；不给时空白处的菜单只有「适配视图」，节点没有菜单；
 *   连线菜单只在可编辑时打开（只读时右键连线等同于右键空白处）；
 * - `onInsertOnEdge`：悬停链上的连线时中点的「＋」；`reconnect`：拖动连线的端点改接（都只在可编辑时生效）；
 * - `onDeleteNode`：删除节点（Delete 键）交给使用方，由它决定连线怎么处理（删除并接上前后）；
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
	/** 选中了什么（只含画布上有的节点）。 */
	selection: CanvasSelection;
	onSelect(selection: CanvasSelection): void;
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
	/** 选中了东西时按 Enter（焦点在画布上）：通常把焦点移到检查器。 */
	onEnter?(): void;
	/** 检查器开关（工具条按钮与 I 键）；检查器本身由使用方渲染。 */
	inspector?: { open: boolean; onToggle(): void };
	/** 打开时是否显示小地图（默认显示；版本对比的窄画布默认收起）。 */
	initialMinimap?: boolean;
	/**
	 * 画布容器变大变小时重新适配视图，直到用户在画布上点击、滚轮或按键（默认只在打开时和窗口变化时适配）。
	 * 版本对比用：两个版本的数据先后到达，上方的差异摘要出现后画布变矮，先打开的那个要跟着重新居中。
	 */
	refitOnResize?: boolean;
	/**
	 * 右键菜单的内容（`ContextMenuItem` 等，见 ui/context-menu），按右键的对象给出；
	 * 不给时空白处的菜单只有「适配视图」（只读画布），节点上不弹菜单。
	 * 节点菜单用鼠标右键或焦点在节点上按 Shift+F10 / 菜单键打开。
	 */
	menu?: (target: CanvasMenuTarget) => ReactNode;
	/**
	 * 用 Delete / Backspace 删除选中的节点：给了就由使用方删除（画布自己不删），
	 * 不给时画布直接删掉节点和它的连线。只在 `editable` 时生效。
	 */
	onDeleteNode?(id: string): void;
	/** 点了链上连线中点的「＋」：在这条连线中间插入节点；`client` 是添加节点菜单出现的屏幕坐标。 */
	onInsertOnEdge?(edge: EdgeEnds, client: Position): void;
	/** 拖动连线的端点改接（React Flow 的重连手势）。 */
	reconnect?: Pick<
		ReactFlowProps<SfNode, SfEdge>,
		"onReconnect" | "onReconnectStart" | "onReconnectEnd"
	>;
	dockStart?: ReactNode;
	dockTools?: ReactNode;
	/** 悬浮在画布上、Tab 顺序排在画布与工具条之后的控件（检查器）；要先于画布获得焦点的（顶栏）放在 FlowCanvas 前面。 */
	children?: ReactNode;
}

/** 工具条（底部居中，高 42 + 下边距 14）占住的高度。 */
const DOCK_SPACE = 72;

export function FlowCanvas({
	label,
	nodes,
	edges,
	info,
	selection,
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
	refitOnResize = false,
	menu,
	onDeleteNode,
	onInsertOnEdge,
	reconnect,
	dockStart,
	dockTools,
	children,
}: FlowCanvasProps) {
	const flow = useReactFlow<SfNode, SfEdge>();
	const store = useStoreApi<SfNode, SfEdge>();
	const wrapper = useRef<HTMLDivElement>(null);
	const hintId = useId();
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

	// 选中由使用方控制（单选）；React Flow 自己的 select 变化不往外传。
	const shownNodes = useMemo(
		() =>
			nodes.map((n) => {
				const selected = isNodeSelected(selection, n.id);
				return n.selected === selected ? n : { ...n, selected };
			}),
		[nodes, selection],
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
		void flow.fitView({ ...fitOptions, duration: viewportDuration(VIEWPORT_MS) });
	}, [flow, fitOptions]);
	const canEdit = editable && tool === "pointer";

	// —— 右键菜单：关闭时保留对象，退场动画期间内容不变 ——
	const [menuState, setMenuState] = useState<{ target: CanvasMenuTarget; open: boolean } | null>(
		null,
	);
	/** 画布区域拿到焦点，并标记是鼠标放过来的（见 isPointerFocusedCanvas）。 */
	const focusRegion = useCallback(() => {
		const root = wrapper.current;
		if (!root) return;
		root.dataset.pointerFocus = "";
		root.focus({ preventScroll: true });
	}, []);
	/** 空白处的菜单：菜单关闭后焦点回到画布区域（ui/context-menu 交还给打开前的焦点）。 */
	const openPaneMenu = useCallback(
		(client: Position) => {
			focusRegion();
			setMenuState({
				target: { kind: "pane", client, position: flow.screenToFlowPosition(client) },
				open: true,
			});
		},
		[flow, focusRegion],
	);
	/**
	 * 连线菜单：右键的连线选中（高亮），节点取消选中；连线不能聚焦，菜单关闭后焦点回到画布区域。
	 * 只读时（运行状态、版本对比）连线没有菜单，右键连线等同于右键空白处。
	 */
	const openEdgeMenu = useCallback(
		(edge: DocEdge, client: Position) => {
			if (!editable || !menu) {
				openPaneMenu(client);
				return;
			}
			onSelect(NO_SELECTION);
			store.getState().addSelectedEdges([edgeId(edge)]);
			focusRegion();
			setMenuState({ target: { kind: "edge", edge, client }, open: true });
		},
		[editable, menu, onSelect, store, focusRegion, openPaneMenu],
	);
	const context = useMemo<CanvasContextValue>(
		() => ({
			info,
			selection,
			ports,
			decorateNode,
			decorateEdge,
			regionMeta,
			fit,
			...(canEdit && onInsertOnEdge ? { insertOnEdge: onInsertOnEdge, openEdgeMenu } : {}),
		}),
		[
			info,
			selection,
			ports,
			decorateNode,
			decorateEdge,
			regionMeta,
			fit,
			canEdit,
			onInsertOnEdge,
			openEdgeMenu,
		],
	);
	const fitRef = useRef(fitOptions);
	fitRef.current = fitOptions;
	useEffect(() => {
		const onResize = () => void flow.fitView(fitRef.current);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [flow]);
	const touched = useRef(false);
	const touch = () => {
		touched.current = true;
	};
	useEffect(() => {
		const el = wrapper.current;
		if (!refitOnResize || !el) return;
		let initial = true;
		const observer = new ResizeObserver(() => {
			if (initial) {
				initial = false;
				return;
			}
			if (!touched.current) void flow.fitView(fitRef.current);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [flow, refitOnResize]);

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
				{ duration: viewportDuration(VIEWPORT_MS) },
			);
		},
		[flow, area],
	);

	/** 打开节点菜单：先让节点卡片拿到焦点（菜单关闭后焦点回到它）并选中它。 */
	const openNodeMenu = (id: string, at?: Position) => {
		const node = nodes.find((n) => n.id === id);
		const card = wrapper.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
		if (!menu || !node || !card) return;
		card.focus({ preventScroll: true });
		onSelect(selectNode(id));
		setMenuState({
			target: { kind: "node", id, node: node.data.node, anchor: at ?? card },
			open: true,
		});
	};

	// —— 键盘：方向键沿链切换、Enter、Esc、Shift+F10 / 菜单键 ——
	const latest = useRef({ nodes, edges, selection, onSelect, onEnter, reveal, openNodeMenu });
	latest.current = { nodes, edges, selection, onSelect, onEnter, reveal, openNodeMenu };
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
			if (!root || isEditable(target) || dialogOpen()) return;
			// 焦点在画布本身（空白处、节点卡片）或页面上没有焦点时才处理，工具条按钮等保持原样。
			const onCanvas =
				target === document.body ||
				target === root ||
				target?.closest("[data-node-id]") !== null ||
				target?.classList.contains("react-flow__pane");
			if (!onCanvas || !(target === document.body || root.contains(target))) return;
			const { nodes, edges, selection, onSelect, onEnter, reveal, openNodeMenu } = latest.current;
			const cardId = target?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
			if (cardId && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
				// 拦下默认行为：浏览器自己的右键菜单不再弹出。
				event.preventDefault();
				openNodeMenu(cardId);
			} else if (isNavigationKey(event.key)) {
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
					soleNode(selection),
					event.key,
				);
				if (next) {
					onSelect(selectNode(next));
					reveal(next);
					focusNode(next);
				}
			} else if (event.key === "Enter" && selection.kind !== "none") {
				event.preventDefault();
				onEnter?.();
			} else if (event.key === "Escape" && selection.kind !== "none") {
				event.preventDefault();
				onSelect(NO_SELECTION);
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

	return (
		<FlowCanvasContext.Provider value={context}>
			{/* biome-ignore lint/a11y/useSemanticElements: 画布容器需要可聚焦（Esc 后焦点回到这里），section 不合适 */}
			<div
				ref={wrapper}
				role="region"
				aria-label={label}
				data-canvas-region=""
				aria-describedby={hintId}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: 画布区域是键盘入口：Tab 进入后用方向键浏览节点，Esc 退回这里后 Tab 继续往后走
				tabIndex={0}
				onBlur={(e) => {
					if (e.target === e.currentTarget) delete e.currentTarget.dataset.pointerFocus;
				}}
				onPointerDownCapture={touch}
				onWheelCapture={touch}
				onKeyDownCapture={touch}
				data-lod={false}
				data-tool={tool}
				style={{ "--canvas-zoom": 1 } as React.CSSProperties}
				className={cn(
					// 画布铺满视口，焦点环画在内侧（DESIGN-SYSTEM §7）。React Flow、工具条和检查器会盖住画布区域自己的轮廓，
					// 所以焦点环再画在最上层的 ::after 上。
					"absolute inset-0 overflow-hidden bg-canvas-bg -outline-offset-2",
					"after:pointer-events-none after:absolute after:inset-0 after:z-20 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring",
					"[&_.react-flow__viewport-portal]:pointer-events-none",
					"data-[tool=hand]:[&_.react-flow__pane]:cursor-grab data-[tool=hand]:[&_.react-flow__node]:cursor-grab",
				)}
			>
				<p id={hintId} hidden>
					方向键沿链浏览节点，↓ ↑ 进出子流程，Esc 取消选中
				</p>
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
					onNodeClick={(_e, node) => onSelect(selectNode(node.id))}
					onPaneClick={() => {
						onSelect(NO_SELECTION);
						// 拖动画布的手势拦掉了 mousedown 的默认行为，点空白处时焦点不会自己移过来：
						// 手动聚焦画布区域，并标记是鼠标放过来的（失焦时清掉）：编辑器据此决定 Tab 是添加节点
						// 还是照常切换焦点（editor/ScenarioEditor.tsx）。
						focusRegion();
					}}
					onPaneContextMenu={(event) => {
						event.preventDefault();
						openPaneMenu({ x: event.clientX, y: event.clientY });
					}}
					// 点选连线时节点取消选中：之后按 Delete 只删这条连线。
					onEdgeClick={() => onSelect(NO_SELECTION)}
					onEdgeContextMenu={(event, edge) => {
						event.preventDefault();
						openEdgeMenu(docEdgeOf(edge), { x: event.clientX, y: event.clientY });
					}}
					onNodeContextMenu={(event, node) => {
						if (!menu) return;
						event.preventDefault();
						// 键盘触发的 contextmenu 事件（没有按右键）贴着节点卡片打开。
						openNodeMenu(
							node.id,
							event.button === 2 ? { x: event.clientX, y: event.clientY } : undefined,
						);
					}}
					onBeforeDelete={async ({ nodes: removed }) => {
						const [first] = removed;
						if (!first || !onDeleteNode) return true;
						onDeleteNode(first.id);
						return false;
					}}
					nodesDraggable={canEdit}
					nodesConnectable={canEdit}
					edgesReconnectable={canEdit}
					reconnectRadius={RECONNECT_RADIUS}
					{...(canEdit ? (reconnect ?? {}) : {})}
					// 键盘焦点只有一种走法：Tab 停在画布区域，方向键选中节点并把焦点移到节点卡片上。
					nodesFocusable={false}
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
							style={{ ...MINIMAP_SIZE }}
							bgColor="var(--surface)"
							maskColor="var(--canvas-minimap-mask)"
							maskStrokeColor="var(--fg-3)"
							maskStrokeWidth={2}
							nodeBorderRadius={12}
							nodeColor={(n) => minimapLook(decorateNode?.(n.id, n.data.node)?.run).fill}
							nodeStrokeColor={(n) =>
								isNodeSelected(selection, n.id)
									? "var(--selected)"
									: minimapLook(decorateNode?.(n.id, n.data.node)?.run).stroke
							}
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
					clearRight={area.right}
				/>
				<ContextMenu
					label={menuState ? MENU_LABEL[menuState.target.kind] : "画布菜单"}
					open={menuState?.open ?? false}
					anchor={menuState ? menuAnchor(menuState.target) : null}
					onOpenChange={(open) => setMenuState((m) => m && { ...m, open })}
				>
					{menuState &&
						(menu?.(menuState.target) ??
							(menuState.target.kind === "pane" ? <FitViewMenuItem /> : null))}
				</ContextMenu>
				{children}
			</div>
		</FlowCanvasContext.Provider>
	);
}

const MENU_LABEL: Record<CanvasMenuTarget["kind"], string> = {
	pane: "画布菜单",
	node: "节点菜单",
	edge: "连线菜单",
};

/** 小地图上节点的颜色：编辑模式统一灰色，运行状态（#41）按状态着色。 */
function minimapLook(run: NodeDecoration["run"]): { fill: string; stroke: string } {
	switch (run) {
		case "running":
			return { fill: "var(--signal-fill)", stroke: "var(--signal-line)" };
		case "failed":
			return { fill: "var(--danger-fill)", stroke: "transparent" };
		case "done":
			return { fill: "var(--ok-fill)", stroke: "transparent" };
		case "waiting":
			return { fill: "var(--warn-fill)", stroke: "var(--warn-line)" };
		case "stopped":
			return { fill: "var(--stopped-fill)", stroke: "var(--stopped)" };
		default:
			return { fill: "var(--canvas-edge)", stroke: "transparent" };
	}
}

/**
 * 焦点是不是用鼠标点画布空白处放到画布区域上的（点空白处时由 onPaneClick 标记，失焦时清掉）。
 * 编辑器据此决定 Tab 是打开添加节点菜单，还是照常切换焦点（键盘用户 Tab 进入、Esc 退回画布区域时）。
 */
export function isPointerFocusedCanvas(target: Element | null): boolean {
	return (
		target instanceof HTMLElement &&
		target.dataset.canvasRegion !== undefined &&
		target.dataset.pointerFocus !== undefined
	);
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
