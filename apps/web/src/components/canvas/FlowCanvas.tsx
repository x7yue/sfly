import {
	annotationBoxes,
	type EdgeEnds,
	nonMembersInside,
	type Position,
} from "@sfly/orchestration";
import type { Annotation } from "@sfly/schema";
import {
	Background,
	BackgroundVariant,
	type EdgeChange,
	getViewportForBounds,
	type IsValidConnection,
	MiniMap,
	type NodeChange,
	type OnConnect,
	type OnConnectEnd,
	type OnEdgesChange,
	type OnNodesChange,
	ReactFlow,
	type ReactFlowProps,
	type Rect,
	useReactFlow,
	useStore,
	useStoreApi,
} from "@xyflow/react";
import { cn } from "cn";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useShortcut } from "#/components/shortcuts";
import { ACTION } from "#/lib/copy";
import { dialogOpen, isEditable } from "#/lib/focus";
import { shortcutText } from "#/lib/shortcuts";
import { ContextMenu } from "@/components/ui/context-menu";
import { AnnotationBoxes } from "./AnnotationBoxes";
import { CanvasDock, type CanvasTool } from "./CanvasDock";
import { type CanvasMenuTarget, FitViewMenuItem, menuAnchor } from "./CanvasMenu";
import {
	type CanvasContextValue,
	type CanvasInfo,
	FlowCanvasContext,
	type NodeDecoration,
	type NodeRename,
	type PortState,
} from "./context";
import { edgeTypes } from "./FlowEdge";
import { type DocEdge, docEdgeOf, edgeId, layoutOf, type SfEdge, type SfNode } from "./flow";
import { createFrameScheduler, followViewport, framedInView, rectInView } from "./follow";
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
	latestNode,
	multipleNodes,
	NO_SELECTION,
	selectAnnotation,
	selectedAnnotation,
	selectNode,
	selectNodes,
	soleNode,
	toggleNode,
	withSelectChanges,
} from "./selection";

/**
 * 跟随执行（运行状态）：镜头框住 `running`（执行中的节点，含子流程区域，规则见 follow.ts）。打开时马上框，
 * 之后执行前沿（`running`）变化后停留 follow.ts 的 `FOLLOW_DWELL_MS` 才平移；只移动镜头，不改选中的节点。
 * 拖动画布、缩放（滚轮或工具条的按钮），或用方向键把选中移到视野外的节点（镜头平移过去）时关闭，并在读屏的实时区域播报。
 */
export interface FollowExecution {
	/** 跟随着；运行结束后是 false。 */
	active: boolean;
	/** 不能打开（运行结束）：按钮禁用，F 不生效。 */
	disabled: boolean;
	/** 执行中的节点（画布上的 ID）。 */
	running: readonly string[];
	/** 按钮和 F 切换：这是用户的选择，要记住。 */
	onChange(active: boolean): void;
	/**
	 * 画布自己在拖动、缩放和键盘选到视野外时停止跟随：只在当前页面有效，不是用户的选择，刷新后回到按钮或 F 上次选的状态。
	 * 之后按钮或 F 恢复。
	 */
	onPause(): void;
}

/**
 * 可配置的编排画布（#35；以 xyflow 官方 React Flow UI 组件为起点）：铺满容器，控件悬浮在上面。
 *
 * 画布本身负责：节点卡片、连线、子流程区域、注释框、语义缩放（--canvas-zoom / data-lod，见 zoom-text.ts）、
 * 打开时与窗口变化时自动适配视图（避开 `insets` 指出的悬浮控件）、底部工具条、左下小地图、
 * 键盘浏览（方向键沿链切换、↓/↑ 进出子流程、Enter 交给 onEnter、Esc 取消选中；不用方向键移动节点）、
 * 可编辑时的多选（指针工具下 Shift 拖动框选、Ctrl/⌘ 点击加选减选、点子流程区域标题选中整个子流程）、
 * 点注释框的标题带选中注释框，拖动标题带整组移动成员；选中或悬停注释框（标题带上，只读也一样）时
 * 成员高亮、框里的非成员节点变淡（NodeCard 按节点外层的 `annotation-member` / `annotation-dim` 类名画）。
 *
 * 使用方负责：节点与连线的状态（受控）、选中状态（受控，见 selection.ts）、右侧检查器和其他悬浮控件（children）。
 *
 * 扩展点（后续票据复用这一个组件，不再各写一套画布）：
 * - `editable={false}`：只读（不能拖动、连线、删除、多选），用于运行状态（#41）与版本对比（#40）；
 * - `decorateNode` / `decorateEdge` / `enteringEdges` / `regionMeta`：叠加运行状态、主指标槽、差异标记（见 context.ts）；
 * - `follow`：运行状态的「跟随执行」，镜头框住执行中的节点（见 FollowExecution）；
 * - `menu`：右键菜单的内容（CanvasMenu.tsx）；不给时空白处的菜单只有「适配视图」，节点没有菜单；
 *   连线菜单只在可编辑时打开（只读时右键连线等同于右键空白处）；
 * - `onInsertOnEdge`：悬停链上的连线时中点的「＋」；`reconnect`：拖动连线的端点改接（都只在可编辑时生效）；
 * - `rename`：双击卡片标题原地改显示名称（只在 `editable` 时生效；状态在使用方，F2 和菜单也从那里进入）；
 * - `onDeleteNodes`：删除选中的节点（Delete 键）交给使用方，由它决定连线怎么处理（删除并接上前后）；
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
	/** 场景文档里的注释框（范围由成员算出）。 */
	annotations?: readonly Annotation[];
	info: CanvasInfo;
	/** 选中了什么（只含画布上有的节点）。 */
	selection: CanvasSelection;
	onSelect(selection: CanvasSelection): void;
	/** 可以拖动节点、连线、删除、多选（默认 false：只读）。 */
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
	enteringEdges?: CanvasContextValue["enteringEdges"];
	regionMeta?: CanvasContextValue["regionMeta"];
	follow?: FollowExecution;
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
	 * 用 Delete / Backspace 删除选中的节点（多选时是整组，入口节点也在内）：给了就由使用方删除（画布自己不删），
	 * 不给时画布直接删掉节点和它的连线。只在 `editable` 时生效。
	 */
	onDeleteNodes?(ids: readonly string[]): void;
	/** 点了链上连线中点的「＋」：在这条连线中间插入节点；`client` 是添加节点菜单出现的屏幕坐标。 */
	onInsertOnEdge?(edge: EdgeEnds, client: Position): void;
	/** 原地改显示名称（双击卡片标题）；不给时标题不响应双击。 */
	rename?: NodeRename;
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

const NO_ANNOTATIONS: readonly Annotation[] = [];

/** 一组矩形的外接矩形。 */
function unionOf(rects: readonly Rect[]): Rect {
	const x = Math.min(...rects.map((r) => r.x));
	const y = Math.min(...rects.map((r) => r.y));
	return {
		x,
		y,
		width: Math.max(...rects.map((r) => r.x + r.width)) - x,
		height: Math.max(...rects.map((r) => r.y + r.height)) - y,
	};
}

/** 工具条（底部居中，高 42 + 下边距 14）占住的高度。 */
const DOCK_SPACE = 72;

export function FlowCanvas({
	label,
	nodes,
	edges,
	annotations = NO_ANNOTATIONS,
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
	enteringEdges,
	regionMeta,
	follow,
	onEnter,
	inspector,
	initialMinimap = true,
	refitOnResize = false,
	menu,
	onDeleteNodes,
	onInsertOnEdge,
	rename,
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

	// 画布上的节点和连线（只留结构和位置）：子流程区域和注释框的范围由它算出，选中、悬停不会让它重算。
	const layout = useMemo(() => layoutOf(nodes, edges), [nodes, edges]);
	const boxes = useMemo(() => annotationBoxes({ ...layout, annotations }), [layout, annotations]);
	// 强调哪个注释框：鼠标停在标题带上的，没有就是选中的。
	const [hoveredAnnotation, setHoveredAnnotation] = useState<string | null>(null);
	const emphasized = hoveredAnnotation ?? selectedAnnotation(selection);
	const emphasis = useMemo(() => {
		const found = boxes.find((b) => b.annotation.id === emphasized);
		if (!found) return undefined;
		return {
			members: new Set(found.members),
			dimmed: new Set(nonMembersInside(layout, found)),
		};
	}, [boxes, emphasized, layout]);

	// 选中由使用方控制。React Flow 自己的 select 变化只在框选时采用（框到哪些节点由它算），
	// 点击的选中由 onNodeClick 决定，其他时候（拖动没选中的节点、点连线）的 select 变化不往外传。
	const shownNodes = useMemo(
		() =>
			nodes.map((n) => {
				const selected = isNodeSelected(selection, n.id);
				const className = emphasis?.members.has(n.id)
					? "annotation-member"
					: emphasis?.dimmed.has(n.id)
						? "annotation-dim"
						: undefined;
				return n.selected === selected && n.className === className
					? n
					: { ...n, selected, className };
			}),
		[nodes, selection, emphasis],
	);
	/** 正在框选：按下鼠标起到松开为止（React Flow 在这期间才有 userSelectionRect）。 */
	const boxSelecting = useCallback(() => store.getState().userSelectionRect !== null, [store]);
	const handleNodesChange = useCallback(
		(changes: NodeChange<SfNode>[]) => {
			const picked = changes.flatMap((c) => (c.type === "select" ? [c] : []));
			if (picked.length > 0 && boxSelecting()) onSelect(withSelectChanges(selection, picked));
			const rest = changes.filter((c) => c.type !== "select");
			if (rest.length > 0) onNodesChange?.(rest);
		},
		[onNodesChange, onSelect, selection, boxSelecting],
	);
	// 框选时 React Flow 把连到框里节点的连线也选中：不要，选中的连线只来自点击（之后按 Delete 断开它）。
	const handleEdgesChange = useCallback(
		(changes: EdgeChange<SfEdge>[]) => {
			const rest = boxSelecting()
				? changes.filter((c) => !(c.type === "select" && c.selected))
				: changes;
			if (rest.length > 0) onEdgesChange?.(rest);
		},
		[onEdgesChange, boxSelecting],
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
	// 适配视图把节点和注释框的范围一起放进视口：框的范围由成员算出，比节点的外接框大（子流程成员的框更大），
	// 只按节点算的话，节点贴着适配的边距时，框的外沿会伸到视口或检查器、工具条下面去。
	// 卡片按布局里量出来的高度算（运行状态下会长高）；打开画布时还没量，按原高度。
	const extent = useRef({ layout, boxes });
	extent.current = { layout, boxes };
	const fitTo = useCallback(
		(duration: number) => {
			const { layout: current, boxes: framed } = extent.current;
			const rects = [
				...current.nodes.flatMap(({ position: p, height }) =>
					p ? [{ x: p.x, y: p.y, width: NODE_WIDTH, height: height ?? NODE_HEIGHT }] : [],
				),
				...framed.map(({ box: b }) => ({ x: b.x, y: b.y, width: b.w, height: b.h })),
			];
			if (rects.length === 0) return;
			const { width, height } = store.getState();
			const { minZoom, maxZoom, padding } = fitOptions;
			void flow.setViewport(
				getViewportForBounds(unionOf(rects), width, height, minZoom, maxZoom, padding),
				{ duration },
			);
		},
		[flow, store, fitOptions],
	);
	const fit = useCallback(() => fitTo(viewportDuration(VIEWPORT_MS)), [fitTo]);
	const fitToRef = useRef(fitTo);
	fitToRef.current = fitTo;
	// 打开画布：视口（缩放平移）建好之后适配一次（没有动画）；这时节点还没量完尺寸，React Flow 把它们藏着，不会闪一下。
	const fitted = useRef(false);
	useLayoutEffect(() => {
		if (!flow.viewportInitialized || fitted.current) return;
		fitted.current = true;
		fitToRef.current(0);
	}, [flow.viewportInitialized]);

	// —— 跟随执行：镜头框住执行中的节点，只动镜头 ——
	const followRef = useRef(follow);
	followRef.current = follow;
	const areaRef = useRef(area);
	areaRef.current = area;
	/** 上一次框住的执行中节点：卡片长高后看它们还在不在可见区域里。 */
	const framedRef = useRef<readonly string[] | null>(null);
	const frameRunning = useCallback(
		(duration: number, running = followRef.current?.running) => {
			if (!running) return;
			const el = wrapper.current;
			if (!el) return;
			const viewport = followViewport({
				running,
				layout: extent.current.layout,
				size: { width: el.clientWidth, height: el.clientHeight },
				area: areaRef.current,
			});
			framedRef.current = running;
			if (viewport) void flow.setViewport(viewport, { duration });
		},
		[flow],
	);
	const [announcement, setAnnouncement] = useState("");
	/** 用户自己动镜头（拖动、缩放）或键盘选到视野外的节点：关闭跟随并告诉读屏用户怎么恢复。 */
	const stopFollowing = useCallback((cause: "manual" | "keyboard") => {
		const current = followRef.current;
		if (!current?.active) return;
		current.onPause();
		const stopped = `已停止${ACTION.followExecution}，按 ${shortcutText("canvas-follow")} 恢复`;
		setAnnouncement(cause === "manual" ? stopped : `镜头已移到选中的节点，${stopped}`);
	}, []);
	// 什么时候框见 createFrameScheduler；画布卸载时取消等待中的那一次。
	const followKey = flow.viewportInitialized && follow?.active ? follow.running.join("\n") : null;
	const [frames] = useState(createFrameScheduler);
	useEffect(
		() => frames.update(followKey, () => frameRunning(viewportDuration(VIEWPORT_MS))),
		[frames, followKey, frameRunning],
	);
	useEffect(() => frames.cancel, [frames]);
	const following = follow?.active ?? false;
	// 框好以后卡片才长高（关注项读到了、多了「正在做」一行）、长出来的部分落到可见区域外时，马上重新框上一次框的那些节点；
	// 执行前沿的变化照旧等停留时间（上面的 frames）。
	useEffect(() => {
		const framed = framedRef.current;
		const el = wrapper.current;
		if (!following || !framed || !el) return;
		const frame = {
			running: framed,
			layout,
			size: { width: el.clientWidth, height: el.clientHeight },
			area: areaRef.current,
		};
		if (!framedInView({ ...frame, viewport: flow.getViewport() })) {
			frameRunning(viewportDuration(VIEWPORT_MS), framed);
		}
	}, [following, layout, flow, frameRunning]);
	useEffect(() => {
		if (following) setAnnouncement("");
	}, [following]);

	const canEdit = editable && tool === "pointer";
	const selectSubflow = useCallback(
		(ids: readonly string[]) => onSelect(selectNodes(ids)),
		[onSelect],
	);
	const pickAnnotation = useCallback((id: string) => onSelect(selectAnnotation(id)), [onSelect]);

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
			enteringEdges,
			regionMeta,
			fit,
			...(canEdit && onInsertOnEdge ? { insertOnEdge: onInsertOnEdge, openEdgeMenu } : {}),
			...(editable && rename ? { rename } : {}),
		}),
		[
			info,
			selection,
			ports,
			decorateNode,
			decorateEdge,
			enteringEdges,
			regionMeta,
			fit,
			canEdit,
			onInsertOnEdge,
			openEdgeMenu,
			editable,
			rename,
		],
	);
	useEffect(() => {
		const onResize = () => (followRef.current?.active ? frameRunning(0) : fitToRef.current(0));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [frameRunning]);
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
			if (!touched.current) fitToRef.current(0);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [refitOnResize]);

	/** 节点不在可见区域（扣掉悬浮控件）里时，把它移到可见区域中央；返回镜头有没有移动。 */
	const reveal = useCallback(
		(id: string): boolean => {
			const node = flow.getInternalNode(id);
			const el = wrapper.current;
			if (!node || !el) return false;
			const viewport = flow.getViewport();
			const { zoom } = viewport;
			const { x: nx, y: ny } = node.internals.positionAbsolute;
			// 运行状态下卡片会长高：按量出来的高度判断。
			const height = node.measured.height ?? NODE_HEIGHT;
			const W = el.clientWidth;
			const H = el.clientHeight;
			const rect = { x: nx, y: ny, width: NODE_WIDTH, height };
			if (rectInView(rect, { viewport, size: { width: W, height: H }, area })) return false;
			const cx = area.left + (W - area.left - area.right) / 2;
			const cy = area.top + (H - area.top - area.bottom) / 2;
			void flow.setViewport(
				{
					x: cx - (nx + NODE_WIDTH / 2) * zoom,
					y: cy - (ny + height / 2) * zoom,
					zoom,
				},
				{ duration: viewportDuration(VIEWPORT_MS) },
			);
			return true;
		},
		[flow, area],
	);
	// F2 和菜单进入原地编辑时，节点可能在检查器下面或视口外：先移进可见区域。
	const renaming = editable ? rename?.active : null;
	useEffect(() => {
		if (renaming) reveal(renaming);
	}, [renaming, reveal]);

	/**
	 * 打开节点菜单：先让节点卡片拿到焦点（菜单关闭后焦点回到它）。节点不在选中的一组里时选中它；
	 * 在多选里时保持多选，菜单作用于整组（kind "nodes"）。
	 */
	const openNodeMenu = (id: string, at?: Position) => {
		const node = nodes.find((n) => n.id === id);
		const card = wrapper.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
		if (!menu || !node || !card) return;
		card.focus({ preventScroll: true });
		const group = multipleNodes(selection);
		const anchor = at ?? card;
		if (group?.includes(id)) {
			setMenuState({ target: { kind: "nodes", ids: group, anchor }, open: true });
			return;
		}
		onSelect(selectNode(id));
		setMenuState({ target: { kind: "node", id, node: node.data.node, anchor }, open: true });
	};

	// —— 键盘：方向键沿链切换、Enter、Esc、Shift+F10 / 菜单键 ——
	const latest = useRef({
		nodes,
		edges,
		selection,
		onSelect,
		onEnter,
		reveal,
		openNodeMenu,
		stopFollowing,
	});
	latest.current = {
		nodes,
		edges,
		selection,
		onSelect,
		onEnter,
		reveal,
		openNodeMenu,
		stopFollowing,
	};
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
			const { nodes, edges, selection, onSelect, onEnter, reveal, openNodeMenu, stopFollowing } =
				latest.current;
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
					// 多选时从最近选中的节点出发，收成单选。
					soleNode(latestNode(selection)),
					event.key,
				);
				if (next) {
					onSelect(selectNode(next));
					// 选中的节点在视野外：镜头平移过去，跟随执行不再拉回，所以暂停。
					if (reveal(next)) stopFollowing("keyboard");
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
	useShortcut(
		"canvas-follow",
		() => follow?.onChange(!follow.active),
		follow !== undefined && !follow.disabled,
	);
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
					// 框选的矩形用中性的选中色；框选结束后 React Flow 画在选中节点外面的可拖动矩形不要
					// （它盖住框里没选中的节点；整组拖动直接拖任意一个选中的节点）。
					// 类名里的下划线在 Tailwind 的任意值里会变成空格，要转义成 \_。
					"[--xy-selection-background-color:var(--selected-ring)] [--xy-selection-border:1px_dashed_var(--selected)]",
					String.raw`[&_.react-flow\_\_nodesselection]:hidden`,
				)}
			>
				<p id={hintId} hidden>
					方向键沿链浏览节点，↓ ↑ 进出子流程，Esc 取消选中
				</p>
				{/* 读屏的实时区域：跟随执行因为拖动画布或键盘选到视野外而关闭时在这里播报。 */}
				<output aria-live="polite" className="sr-only">
					{announcement}
				</output>
				<ReactFlow<SfNode, SfEdge>
					nodes={shownNodes}
					edges={edges}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					onNodesChange={handleNodesChange}
					onEdgesChange={handleEdgesChange}
					onConnect={onConnect}
					onConnectEnd={onConnectEnd}
					isValidConnection={isValidConnection}
					onNodeClick={(event, node) =>
						onSelect(
							editable && (event.metaKey || event.ctrlKey)
								? toggleNode(selection, node.id)
								: selectNode(node.id),
						)
					}
					onPaneClick={() => {
						onSelect(NO_SELECTION);
						// 拖动画布的手势拦掉了 mousedown 的默认行为，点空白处时焦点不会自己移过来：
						// 手动聚焦画布区域，并标记是鼠标放过来的（失焦时清掉）：编辑器据此决定 Tab 是添加节点
						// 还是照常切换焦点（editor/ScenarioEditor.tsx）。
						focusRegion();
					}}
					// 有事件的移动是用户在拖动或滚轮缩放画布；程序平移（跟随、适配视图、定位节点）的事件是 null。
					onMove={(event) => {
						if (event) stopFollowing("manual");
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
					// 选中的节点整组交给使用方，入口节点也在内（React Flow 不把它算进要删的节点）：由使用方跳过并说明。
					// 没有选中节点时（选中的是连线）由 React Flow 删掉连线。
					onBeforeDelete={async () => {
						if (selection.kind !== "nodes" || !onDeleteNodes) return true;
						onDeleteNodes(selection.ids);
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
					// 加选、减选由 onNodeClick 按点击时的 Ctrl/⌘ 处理：React Flow 的多选键只翻转它自己的 selected，
					// 这里的选中是受控的。Shift 框选是替换：React Flow 一开始框选就把原来选中的节点报告为取消选中
					// （withSelectChanges 照着改），只有 Ctrl/⌘ + 点击是加选。框选只在可编辑、指针工具下：抓手工具下按住 Shift 拖动仍是平移。
					multiSelectionKeyCode={null}
					selectionKeyCode={canEdit ? "Shift" : null}
					disableKeyboardA11y
					minZoom={MIN_ZOOM}
					maxZoom={MAX_ZOOM}
					colorMode="dark"
					proOptions={{ hideAttribution: true }}
					ariaLabelConfig={{ "minimap.ariaLabel": "小地图" }}
				>
					<ZoomVariables target={wrapper} />
					<AnnotationBoxes
						layout={layout}
						boxes={boxes}
						selected={selectedAnnotation(selection)}
						onSelect={editable ? pickAnnotation : undefined}
						onHover={setHoveredAnnotation}
						onMove={canEdit ? onNodesChange : undefined}
					/>
					<SubflowRegions
						layout={layout}
						nodes={shownNodes}
						edges={edges}
						onSelect={editable ? selectSubflow : undefined}
					/>
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
					onZoom={() => stopFollowing("manual")}
					inspector={inspector}
					follow={
						follow && {
							active: follow.active,
							disabled: follow.disabled,
							onToggle: () => follow.onChange(!follow.active),
						}
					}
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
	nodes: "节点菜单",
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
