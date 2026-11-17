import {
	ANNOTATION_TITLE_SPACE,
	type ArrangeMode,
	annotationBoxes,
	annotationMembersOfSelection,
	arrangeNodes,
	checkConnection,
	declaredOutputs,
	documentWarnings,
	ensureLayout,
	insertAfter,
	insertOnEdge,
	nodeCardText,
	nodeConnections,
	nodeDisplayName,
	type OrchestrationWarning,
	outgoingProblem,
	type Position,
	removeNodes,
	stickyNoteRow,
	stickyNoteSize,
	subflowLabels,
	subflowRegions,
	tidyLayout,
	uniqueNodeId,
	withStickyNotePositions,
} from "@sfly/orchestration";
import {
	type Annotation,
	agentsApi,
	feishuBotsApi,
	type OrchestrationHeadView,
	type OrchestrationNode,
	type OrchestrationView,
	packagesApi,
	STICKY_NOTE_SIZE,
	type StickyNote,
} from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import {
	type Connection,
	type Edge,
	type OnConnectEnd,
	ReactFlowProvider,
	useEdgesState,
	useNodesState,
	useReactFlow,
} from "@xyflow/react";
import { Redo2Icon, Undo2Icon, Wand2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ToolButton } from "#/components/canvas/CanvasDock";
import type {
	AnnotationEdit,
	CanvasInfo,
	NodeRename,
	StickyEdit,
} from "#/components/canvas/context";
import { FlowCanvas, isPointerFocusedCanvas } from "#/components/canvas/FlowCanvas";
import {
	applyDocument,
	type DocMeta,
	type DocNode,
	type EdgeKind,
	fromFlow,
	layoutOf,
	type SfEdge,
	type SfNode,
	toFlow,
	toFlowEdge,
	toFlowNode,
} from "#/components/canvas/flow";
import {
	DOCK_SPACE,
	FLOAT_GAP,
	INSPECTOR_MARGIN,
	MIN_ZOOM,
	NODE_HEIGHT,
	NODE_WIDTH,
} from "#/components/canvas/geometry";
import { VIEWPORT_MS, viewportDuration } from "#/components/canvas/motion";
import { usePackageTitles } from "#/components/canvas/package-titles";
import {
	type CanvasSelection,
	keepAnnotation,
	keepNodes,
	keepSticky,
	latestNode,
	NO_SELECTION,
	selectAnnotation,
	selectedAnnotation,
	selectedSticky,
	selectNode,
	selectSticky,
	soleNode,
} from "#/components/canvas/selection";
import { notify } from "#/components/feedback/notify";
import { useShortcut } from "#/components/shortcuts";
import { apiQuery } from "#/lib/api";
import { TERM } from "#/lib/copy";
import { dialogOpen } from "#/lib/focus";
import { BACKGROUND_POLL_MS } from "#/lib/polling";
import { useOtherEditors } from "#/lib/presence";
import { useNow } from "#/lib/use-now";
import { notifyInvalidatedPresets, splitPresetWarnings } from "#/presets/invalidated-toast";
import { RunDrawer } from "#/run-drawer/RunDrawer";
import { DraftBanner } from "#/versions/DraftBanner";
import { hasDraft } from "#/versions/draft";
import { versionConflictOf } from "#/versions/queries";
import { type EditStart, startEditing, useVersionedDraft } from "#/versions/useVersionedDraft";
import { AddNodeMenu, type AddRequest } from "./AddNodeMenu";
import { type AddItem, idStem, newDocNode, newSubflowNameProblem, packageGroups } from "./add-node";
import { companionSubflow } from "./add-subflow";
import {
	applyAnnotationDrop,
	leaveAnnotation,
	newAnnotation,
	updateAnnotation,
	withColor,
	withNode,
	withStickyColor,
} from "./annotations";
import { usePackageCatalog, useRegisteredAgents, useRegisteredBots } from "./catalog";
import { type EditorMode, EditorTopLeft, EditorTopRight, TOP_GROUP_SPACE } from "./EditorChrome";
import { EditorMenu } from "./EditorMenu";
import { useEditHistory } from "./edit-history";
import {
	annotationFieldKey,
	FieldDraftsProvider,
	fieldErrorKey,
	stickyFieldKey,
	useFieldDraftStore,
} from "./field-drafts";
import { freeCardSpot } from "./free-spot";
import { isNamedNode } from "./inspector/DisplayNameField";
import { focusField } from "./inspector/fields";
import { type FocusRequest, Inspector, type InspectorContext } from "./inspector/Inspector";
import { useInspectorWidth } from "./inspector/inspector-width";
import { useNodeClipboard } from "./node-clipboard";
import { OUTLINE_WIDTH, OutlinePanel } from "./OutlinePanel";
import { canvasOutline } from "./outline";
import { useReconnect } from "./reconnect";
import {
	RunStateBadge,
	RunStateInspector,
	RunTopRight,
	useRunDecorations,
} from "./run-state/RunState";
import { useCanvasRun, useRunFlow } from "./run-state/use-canvas-run";
import {
	documentFieldErrors,
	type FieldError,
	undeclaredInputNotes,
	warningsSummary,
} from "./validation";

/** 检查器右边距。 */

/** 定位注释框时框四周至少留出的空白（屏幕像素）。 */
const LOCATE_MARGIN = 48;

/**
 * 全屏编排画布（原型 #/editor/:id 的编辑模式）：画布铺满视口，控件悬浮——左上场景名 / 版本 / 检查状态 /
 * 模式切换，右上在线编辑者 / 未保存状态 / 版本历史 / 保存 / 运行，底部工具条，左下小地图，右侧检查器。
 * 本地草稿与显式保存版本沿用 useVersionedDraft（刷新不丢失；保存时以编辑起点为 base_version，冲突不自动合并）。
 * 「运行状态」模式（#41，`initialRun` 来自 `?run=`，否则取最近一次运行）：画布只读，显示运行绑定的版本并叠加
 * 节点状态，检查器换成运行摘要；编辑中的草稿保留不动，切回编辑模式即恢复。
 */
export function ScenarioEditor({
	orchestration,
	head,
	initialRun,
	initialNode,
}: {
	orchestration: OrchestrationView;
	head: OrchestrationHeadView;
	initialRun?: string;
	/** 打开时选中的节点（运行抽屉里预检问题的「前往」）。 */
	initialNode?: string;
}) {
	// 编辑起点：本地草稿（刷新不丢失）或最新版本；放弃本地修改后用最新版本重建画布。
	const [start, setStart] = useState(() => startEditing(orchestration.id, head));
	return (
		<ReactFlowProvider key={start.nonce}>
			<Editor
				orchestration={orchestration}
				start={start}
				initialRun={initialRun}
				initialNode={initialNode}
				onReload={(latest) => setStart(startEditing(orchestration.id, latest, start.nonce + 1))}
			/>
		</ReactFlowProvider>
	);
}

const NO_PACKAGES: Record<string, string> = {};

const cardOf = (id: string) =>
	document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);

/**
 * 让刚放到画布上的节点卡片拿到焦点。React Flow 量好新节点的尺寸之前卡片是隐藏的，不能聚焦：
 * 还没显示出来时下一帧再试（最多约半秒）。
 */
function focusNewCard(id: string, frames = 30) {
	const card = cardOf(id);
	if (card && getComputedStyle(card).visibility === "visible") card.focus();
	else if (frames > 0) requestAnimationFrame(() => focusNewCard(id, frames - 1));
}

const edgeKindOf = (c: Connection | Edge): EdgeKind =>
	c.sourceHandle === "dispatch" ? "dispatch" : "chain";

function Editor({
	orchestration,
	start,
	initialRun,
	initialNode,
	onReload,
}: {
	orchestration: OrchestrationView;
	start: EditStart;
	initialRun?: string;
	initialNode?: string;
	onReload: (head: OrchestrationHeadView) => void;
}) {
	const flow = useReactFlow<SfNode, SfEdge>();
	const initial = useMemo(() => toFlow(start.document), [start.document]);
	const [nodes, setNodes, onNodesChange] = useNodesState<SfNode>(initial.nodes);
	const [edges, setEdges, onEdgesChange] = useEdgesState<SfEdge>(initial.edges);
	const [meta, setMeta] = useState<DocMeta>({
		default_agent: start.document.default_agent,
		packages: start.document.packages,
		// 加入注释框、便签之前存下的本地草稿里没有这两个字段。没写位置的便签放进内容上方的那一行（ADR 0026）。
		annotations: start.document.annotations ?? [],
		sticky_notes: withStickyNotePositions({
			...ensureLayout(start.document),
			sticky_notes: start.document.sticky_notes ?? [],
		}).sticky_notes,
	});
	const [selection, setSelection] = useState<CanvasSelection>(() =>
		initialNode ? selectNode(initialNode) : NO_SELECTION,
	);
	const [inspectorOpen, setInspectorOpen] = useState(true);
	const inspectorWidth = useInspectorWidth();
	/** 检查器（实际宽度 + 右边距）占住的宽度：适配视图与定位节点时避开。 */
	const inspectorSpace = inspectorOpen ? inspectorWidth + INSPECTOR_MARGIN : 0;
	const [outlineOpen, setOutlineOpen] = useState(false);
	const [outlineQuery, setOutlineQuery] = useState("");
	/** 大纲（宽度 + 左边距）占住的宽度：适配视图与定位节点时避开。 */
	const outlineSpace = outlineOpen ? OUTLINE_WIDTH + FLOAT_GAP : 0;
	const [triggering, setTriggering] = useState(false);
	const inspectorRef = useRef<HTMLElement>(null);
	const drafts = useFieldDraftStore();
	const [mode, setMode] = useState<EditorMode>(initialRun ? "run" : "edit");
	useShortcut("canvas-mode-edit", () => setMode("edit"));
	useShortcut("canvas-mode-run", () => setMode("run"));

	const packages = useQuery(apiQuery(packagesApi.list));
	const agents = useQuery({ ...apiQuery(agentsApi.list), refetchInterval: BACKGROUND_POLL_MS });
	const agentList = agents.data?.agents ?? [];
	const bots = useQuery({ ...apiQuery(feishuBotsApi.list), refetchInterval: BACKGROUND_POLL_MS });
	const botList = bots.data?.bots ?? [];
	const titleOf = usePackageTitles();

	// —— 撤销 / 重做：修改场景的操作都先记下修改前的状态（edit-history.ts） ——
	const history = useEditHistory(
		{ nodes, edges, meta, drafts: drafts.drafts },
		{ nodes: setNodes, edges: setEdges, meta: setMeta, drafts: drafts.replace },
		{ nodes: onNodesChange, edges: onEdgesChange },
	);

	const doc = useMemo(() => fromFlow(nodes, edges, meta), [nodes, edges, meta]);
	const regionBoxes = useMemo(() => subflowRegions(doc).map((r) => r.box), [doc]);
	// 结构、包版本锁定、引用的静态检查，与控制面保存时返回的警告是同一套规则。
	const catalog = usePackageCatalog(meta.packages, agentList);
	const registered = useRegisteredAgents(agents.data?.agents);
	const registeredBots = useRegisteredBots(bots.data?.bots);
	const warnings = useMemo(
		() => documentWarnings(doc, catalog, { agents: registered, feishuBots: registeredBots }),
		[doc, catalog, registered, registeredBots],
	);
	const notes = useMemo(() => undeclaredInputNotes(doc, catalog), [doc, catalog]);
	const versioning = useVersionedDraft(orchestration.id, start, doc);
	// 在线编辑者：整个画布页一份在线状态，编辑 / 运行状态切换时不中断。
	const editors = useOtherEditors(orchestration.id);
	const warningsByNode = useMemo(() => {
		const map = new Map<string, OrchestrationWarning[]>();
		for (const w of warnings) {
			if (w.node_id) map.set(w.node_id, [...(map.get(w.node_id) ?? []), w]);
		}
		return map;
	}, [warnings]);
	// 阻止保存的字段错误：文档本身不合法，或输入框里还有没生效的值。
	const fieldErrors = useMemo((): FieldError[] => {
		const pending = [...drafts.drafts].map(([key, d]): FieldError => {
			const [nodeId = "", ...field] = key.split("/");
			return { nodeId, field: field.join("/"), message: d.error, draft: true };
		});
		return [...documentFieldErrors(doc), ...pending];
	}, [doc, drafts.drafts]);
	const shownErrors = useMemo(
		() => fieldErrors.filter((e) => !(e.draft || e.typed) || drafts.touched.has(fieldErrorKey(e))),
		[fieldErrors, drafts.touched],
	);
	const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);

	const info: CanvasInfo = useMemo(
		() => ({
			defaultAgent: meta.default_agent,
			titleOf,
			packages: meta.packages,
			subflowLabelOf: subflowLabels(doc),
			warnings: warningsByNode,
		}),
		[meta, titleOf, warningsByNode, doc],
	);

	// —— 运行状态模式：只读显示运行绑定的版本，叠加节点状态 ——
	const runState = useCanvasRun(orchestration.id, initialRun, mode === "run");
	const readyRun = runState.status === "ready" ? runState : undefined;
	// 运行绑定的版本锁定的节点包（节点菜单「复制输出引用」按它列出输出）。
	const runCatalog = usePackageCatalog(readyRun?.doc?.packages ?? NO_PACKAGES, agentList);
	const runNow = useNow(readyRun?.run.status === "running");
	const decorations = useRunDecorations(
		readyRun?.run,
		readyRun?.overlay,
		readyRun?.metrics,
		runNow,
	);
	const runFlow = useRunFlow(readyRun?.doc);
	const runInfo: CanvasInfo = useMemo(
		() =>
			readyRun?.doc
				? {
						defaultAgent: readyRun.doc.default_agent,
						titleOf,
						packages: readyRun.doc.packages,
						subflowLabelOf: subflowLabels(readyRun.doc),
						warnings: new Map(),
					}
				: info,
		[readyRun?.doc, titleOf, info],
	);
	const running = mode === "run";
	const shownNodes = running && runFlow ? runFlow.nodes : nodes;
	const shownEdges = running && runFlow ? runFlow.edges : edges;
	const shownAnnotations =
		running && runFlow && readyRun?.doc ? readyRun.doc.annotations : meta.annotations;
	const shownStickies =
		running && runFlow && readyRun?.doc ? (readyRun.doc.sticky_notes ?? []) : meta.sticky_notes;
	// 选中的节点、注释框或便签可能不在画布上：撤销了添加、运行绑定的版本里没有它。
	const visibleSelection = keepSticky(
		keepAnnotation(
			keepNodes(selection, (id) => shownNodes.some((n) => n.id === id)),
			(id) => shownAnnotations.some((a) => a.id === id),
		),
		(id) => shownStickies.some((s) => s.id === id),
	);
	// 运行状态下画布只读、不能多选也不能选中注释框和便签：编辑时选中的一组节点只显示最近选中的那个，
	// 切回编辑模式还是原来那组。
	const shownSelection = useMemo(
		() =>
			running
				? visibleSelection.kind === "annotation" || visibleSelection.kind === "sticky"
					? NO_SELECTION
					: latestNode(visibleSelection)
				: visibleSelection,
		[running, visibleSelection],
	);
	const nodeOf = (id: string) => shownNodes.find((n) => n.id === id)?.data.node;

	// —— 连线：只允许单入单出，规则与控制面共用（@sfly/orchestration） ——
	const docRef = useRef(doc);
	docRef.current = doc;
	// 拖动连线的端点改接：改接过程中按改接的规则检查（原来那条连线不算）。
	const reconnect = useReconnect(docRef, (next) => applyEdit(next));
	const connectionProblem = useCallback(
		(c: Connection | Edge): string | null => {
			if ((c.sourceHandle ?? "chain") !== (c.targetHandle ?? "chain")) {
				return "链端口只能连链端口，调度端口只能连调度端口";
			}
			const edge = { from: c.source, to: c.target, kind: edgeKindOf(c) };
			const moving = reconnect.problem(edge);
			return moving === undefined ? checkConnection(docRef.current, edge) : moving;
		},
		[reconnect],
	);
	const isValidConnection = useCallback(
		(c: Connection | Edge) => connectionProblem(c) === null,
		[connectionProblem],
	);
	const onConnect = useCallback(
		(c: Connection) => {
			const problem = connectionProblem(c);
			if (problem) {
				notify.warning(problem);
				return;
			}
			history.checkpoint();
			setEdges((es) => [...es, toFlowEdge({ from: c.source, to: c.target, kind: edgeKindOf(c) })]);
		},
		[connectionProblem, setEdges, history.checkpoint],
	);
	const [adding, setAdding] = useState<AddRequest | null>(null);
	/**
	 * 从没有出线的链端口（链尾、游离节点）拖线到空白处：弹出可以接上的节点菜单；从还没有调度连线的调度端口拖出时，
	 * 弹出新建子流程的表单（#187）。拖到某个端口上但连线被拒绝时，提示原因。
	 */
	const onConnectEnd: OnConnectEnd = useCallback(
		(event, state) => {
			if (!state.fromNode) return;
			if (!state.toNode) {
				// 改接时松开在空白处：连线回到原处。
				if (reconnect.active.current) return;
				if (state.fromHandle?.type !== "source") return;
				const dispatch = state.fromHandle.id === "dispatch";
				const from = state.fromNode.id;
				const problem = outgoingProblem(docRef.current, from, dispatch ? "dispatch" : "chain");
				if (problem) {
					notify.warning(problem);
					return;
				}
				const point = "changedTouches" in event ? event.changedTouches[0] : event;
				if (!point) return;
				const client = { x: point.clientX, y: point.clientY };
				const at = flow.screenToFlowPosition(client);
				const position = { x: at.x, y: at.y - NODE_HEIGHT / 2 };
				setAdding(
					dispatch
						? { kind: "dispatch", from, client, position }
						: { kind: "after", after: from, client, position },
				);
				return;
			}
			if (state.isValid !== false) return;
			const fromSource = state.fromHandle?.type !== "target";
			const [source, target] = fromSource
				? [state.fromNode, state.toNode]
				: [state.toNode, state.fromNode];
			const [sourceHandle, targetHandle] = fromSource
				? [state.fromHandle?.id, state.toHandle?.id]
				: [state.toHandle?.id, state.fromHandle?.id];
			const problem = connectionProblem({
				source: source.id,
				target: target.id,
				sourceHandle: sourceHandle ?? null,
				targetHandle: targetHandle ?? null,
			});
			if (problem) notify.warning(problem);
		},
		[connectionProblem, flow, reconnect],
	);

	/** 选中并定位到某个节点（检查结果、调度关系、触发预检里的「前往」）。 */
	const locate = useCallback(
		(id: string) => {
			setSelection(selectNode(id));
			const node = flow.getNode(id);
			if (node) {
				// 定位到没被检查器和大纲占住的那部分画布的中间。
				const zoom = Math.max(flow.getZoom(), 0.8);
				void flow.setCenter(
					node.position.x + NODE_WIDTH / 2 + (inspectorSpace - outlineSpace) / 2 / zoom,
					node.position.y + NODE_HEIGHT / 2,
					{ zoom, duration: viewportDuration(VIEWPORT_MS) },
				);
			}
		},
		[flow, inspectorSpace, outlineSpace],
	);
	/** 视口里没被顶栏和检查器占住的那部分的中心（画布坐标）：没有位置的新节点、粘贴的节点放在这里。 */
	const viewportCenter = () =>
		flow.screenToFlowPosition({
			x: (window.innerWidth - inspectorSpace) / 2,
			y: (window.innerHeight + TOP_GROUP_SPACE) / 2,
		});
	/**
	 * 把文档操作（@sfly/orchestration 的 chain-edits、removeNodes）的结果写回画布，算一步撤销；
	 * 删除节点时同步更新过的注释框一起写回。
	 */
	const applyEdit = (
		next: Pick<typeof doc, "nodes" | "edges"> & { annotations?: readonly Annotation[] },
	) => {
		const applied = applyDocument(nodes, edges, next);
		history.checkpoint();
		setNodes(applied.nodes);
		setEdges(applied.edges);
		const { annotations } = next;
		if (annotations && annotations !== meta.annotations) {
			setMeta((m) => ({ ...m, annotations: [...annotations] }));
		}
	};
	/** 改注释框，算一步撤销；`key` 相同的连续修改（同一个注释框的标题输入）合成一步。 */
	const changeAnnotations = (
		update: (annotations: readonly Annotation[]) => Annotation[],
		key?: string,
	) => {
		history.checkpoint(key);
		setMeta((m) => ({ ...m, annotations: update(m.annotations) }));
	};
	/** 新建注释框，算一步撤销：选中它，标题输入框拿到焦点（默认标题整段选中）。 */
	const addAnnotation = (members: Pick<Annotation, "nodes" | "subflows">) => {
		const created = newAnnotation(meta.annotations, members);
		changeAnnotations((list) => [...list, created]);
		setSelection(selectAnnotation(created.id));
		setInspectorOpen(true);
		focusField(annotationFieldKey(created.id, "title"), { select: true });
	};
	/** 用选中的一组节点新建：节点全被选中的子流程记为子流程成员，其余记为节点成员。 */
	const addAnnotationAround = (ids: readonly string[]) =>
		addAnnotation(annotationMembersOfSelection(doc, ids));
	const deleteAnnotation = (id: string) => {
		changeAnnotations((list) => list.filter((a) => a.id !== id));
		setSelection(NO_SELECTION);
	};
	/** 选中注释框（检查结果里的「前往」）。 */
	const locateAnnotation = (id: string) => {
		setSelection(selectAnnotation(id));
		setInspectorOpen(true);
	};
	/**
	 * 删除节点（Delete 键、节点菜单、检查器的删除按钮；多选时是整组）：每个都是恰好一进一出时前后自动接上，
	 * 入口节点跳过；整组算一步撤销。
	 */
	const deleteNodes = (ids: readonly string[]) => {
		const edit = removeNodes(doc, ids);
		if (!edit.ok) {
			notify.warning(edit.reason);
			return;
		}
		for (const id of edit.removed) drafts.clear(`${id}/`);
		setSelection((s) => keepNodes(s, (n) => !edit.removed.includes(n)));
		applyEdit(edit.doc);
		const reasons = [...new Set(edit.skipped.map((s) => s.reason))];
		if (reasons.length > 0) notify.warning(`${reasons.join("；")}，已跳过`);
	};
	const updateNode = (id: string, node: DocNode) => {
		// 同一个节点上连续的输入合并为一步撤销。
		history.checkpoint(`node:${id}`);
		setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { node } } : n)));
	};

	// —— 原地改显示名称：双击卡片标题、F2、节点菜单的「重命名」；子流程入口节点没有显示名称 ——
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const startRename = (id: string) => {
		const node = nodes.find((n) => n.id === id)?.data.node;
		if (running || !node || !isNamedNode(node)) return;
		setRenamingId(id);
	};
	const commitRename = (id: string, text: string) => {
		setRenamingId(null);
		const node = nodes.find((n) => n.id === id)?.data.node;
		if (!node || !isNamedNode(node)) return;
		const name = text.trim() || undefined;
		if (name === nodeDisplayName(node)) return;
		// 不带 key：不和前后的输入合并，一次改名是一步撤销。
		history.checkpoint();
		setNodes((ns) =>
			ns.map((n) => (n.id === id ? { ...n, data: { node: { ...node, display_name: name } } } : n)),
		);
	};
	const renameHandlers = useRef({ startRename, commitRename });
	renameHandlers.current = { startRename, commitRename };
	// 卡片从 context 取它：只在正在编辑的节点变化时换一个新对象，其余渲染不会让每张卡片重画。
	const rename = useMemo<NodeRename>(
		() => ({
			active: renamingId,
			start: (id) => renameHandlers.current.startRename(id),
			commit: (id, text) => renameHandlers.current.commitRename(id, text),
			cancel: () => setRenamingId(null),
		}),
		[renamingId],
	);

	// —— 大纲（OutlinePanel）：按注释框分组列出画布上的节点，搜索，点一下定位 ——
	const shownInfo = running ? runInfo : info;
	const outline = useMemo(() => {
		const byId = new Map(shownNodes.map((n) => [n.id, n.data.node]));
		return canvasOutline(
			{
				...layoutOf(shownNodes, shownEdges),
				annotations: shownAnnotations,
				sticky_notes: shownStickies,
			},
			(id) => {
				const node = byId.get(id);
				return node ? nodeCardText(node, shownInfo).title : id;
			},
			outlineQuery,
		);
	}, [shownNodes, shownEdges, shownAnnotations, shownStickies, shownInfo, outlineQuery]);
	/** 定位到便签：放在没被检查器和大纲占住的那部分画布的中间；编辑模式下同时选中它。 */
	const locateSticky = (id: string) => {
		const note = shownStickies.find((s) => s.id === id);
		if (!note?.position) return;
		if (!running) setSelection(selectSticky(id));
		const size = stickyNoteSize(note);
		const zoom = Math.max(flow.getZoom(), 0.75);
		void flow.setCenter(
			note.position.x + size.width / 2 + (inspectorSpace - outlineSpace) / 2 / zoom,
			note.position.y + size.height / 2,
			{ zoom, duration: viewportDuration(VIEWPORT_MS) },
		);
	};
	/**
	 * 定位到注释框：框放在没被检查器和大纲占住的那部分画布的中间，放不下时缩小到放得下；编辑模式下同时选中它
	 * （运行状态下不能选中注释框）。
	 */
	const locateAnnotationBox = (id: string) => {
		if (!running) setSelection(selectAnnotation(id));
		const found = annotationBoxes({
			...layoutOf(shownNodes, shownEdges),
			annotations: shownAnnotations,
		}).find((b) => b.annotation.id === id);
		if (!found) return;
		const { box } = found;
		const room = {
			w: window.innerWidth - inspectorSpace - outlineSpace - 2 * LOCATE_MARGIN,
			h: window.innerHeight - TOP_GROUP_SPACE - DOCK_SPACE - 2 * LOCATE_MARGIN,
		};
		const fits = Math.min(room.w / box.w, room.h / (box.h + ANNOTATION_TITLE_SPACE));
		const zoom = Math.max(MIN_ZOOM, Math.min(Math.max(flow.getZoom(), 0.75), fits, 1));
		void flow.setCenter(
			box.x + box.w / 2 + (inspectorSpace - outlineSpace) / 2 / zoom,
			box.y + box.h / 2 - ANNOTATION_TITLE_SPACE / 2,
			{ zoom, duration: viewportDuration(VIEWPORT_MS) },
		);
	};

	// —— 便签（ADR 0026）：空白处菜单新建，拖动、改大小、颜色、删除（FlowCanvas 的 stickyEdit），文字在检查器里改 ——
	/** 改便签，算一步撤销；`key` 相同的连续修改（同一张便签的正文输入）合成一步。 */
	const changeStickies = (update: (notes: readonly StickyNote[]) => StickyNote[], key?: string) => {
		history.checkpoint(key);
		setMeta((m) => ({ ...m, sticky_notes: update(m.sticky_notes) }));
	};
	/** 新建便签（默认在视口中间），选中它，正文输入框拿到焦点（默认文字整段选中）。 */
	const addSticky = (at?: Position) => {
		const id = uniqueNodeId(
			"sticky",
			meta.sticky_notes.map((s) => s.id),
		);
		const center = viewportCenter();
		const position = at ?? {
			x: center.x - STICKY_NOTE_SIZE.width / 2,
			y: center.y - STICKY_NOTE_SIZE.height / 2,
		};
		const created: StickyNote = {
			id,
			text: `${TERM.stickyNote} ${id.slice("sticky_".length)}`,
			position,
		};
		changeStickies((list) => [...list, created]);
		setSelection(selectSticky(id));
		setInspectorOpen(true);
		focusField(stickyFieldKey(id, "text"), { select: true });
	};
	// 拖动、改大小：第一次（dragging 为 true）记下修改前的状态，之后的移动和松手都算这一步。
	const stickyGesture = useRef(false);
	const placeSticky = (id: string, patch: Partial<StickyNote>, dragging: boolean) => {
		if (dragging && !stickyGesture.current) {
			stickyGesture.current = true;
			history.checkpoint();
		}
		if (!dragging) stickyGesture.current = false;
		setMeta((m) => ({
			...m,
			sticky_notes: m.sticky_notes.map((s) => (s.id === id ? { ...s, ...patch } : s)),
		}));
	};
	const stickyActions: StickyEdit = {
		select: (id) => setSelection(selectSticky(id)),
		move: (id, position, dragging) => placeSticky(id, { position }, dragging),
		resize: (id, size, dragging) => placeSticky(id, { size }, dragging),
		open: (id) => {
			setSelection(selectSticky(id));
			setInspectorOpen(true);
			focusField(stickyFieldKey(id, "text"));
		},
		setColor: (id, color) =>
			changeStickies((list) => list.map((s) => (s.id === id ? withStickyColor(s, color) : s))),
		remove: (id) => {
			changeStickies((list) => list.filter((s) => s.id !== id));
			setSelection(NO_SELECTION);
		},
	};
	const stickyHandlers = useRef(stickyActions);
	stickyHandlers.current = stickyActions;
	const stickyEdit = useMemo<StickyEdit>(
		() => ({
			select: (id) => stickyHandlers.current.select(id),
			move: (id, position, dragging) => stickyHandlers.current.move(id, position, dragging),
			resize: (id, size, dragging) => stickyHandlers.current.resize(id, size, dragging),
			open: (id) => stickyHandlers.current.open(id),
			setColor: (id, color) => stickyHandlers.current.setColor(id, color),
			remove: (id) => stickyHandlers.current.remove(id),
		}),
		[],
	);

	// —— 注释框：原地改标题（双击标题、F2）、浮动工具条、把节点拖进拖出（FlowCanvas 的 annotationEdit）——
	const [renamingAnnotation, setRenamingAnnotation] = useState<string | null>(null);
	/** 排列一组节点（宫格 / 横向 / 纵向，@sfly/orchestration 的 arrangeNodes），一步撤销。 */
	const arrange = (ids: readonly string[], mode: ArrangeMode) => {
		const picked = new Set(ids);
		const next = arrangeNodes(
			nodes.flatMap((n) => (picked.has(n.id) ? [{ id: n.id, position: n.position }] : [])),
			mode,
		);
		if (next.size < 2) return;
		history.checkpoint();
		setNodes((ns) => ns.map((n) => ({ ...n, position: next.get(n.id) ?? n.position })));
	};
	const annotationActions: Omit<AnnotationEdit, "renaming" | "cancelRename"> = {
		startRename: (id) => {
			if (!running) setRenamingAnnotation(id);
		},
		commitRename: (id, text) => {
			setRenamingAnnotation(null);
			const title = text.trim();
			const current = meta.annotations.find((a) => a.id === id);
			// 标题必填：清空等于不改。不带 key：一次改名是一步撤销。
			if (!current || !title || title === current.title) return;
			changeAnnotations((list) => updateAnnotation(list, id, (a) => ({ ...a, title })));
		},
		setColor: (id, color) =>
			changeAnnotations((list) => updateAnnotation(list, id, (a) => withColor(a, color))),
		remove: deleteAnnotation,
		create: addAnnotationAround,
		arrange,
		// 不另记一步撤销：拖动开始时已经记下了，松手时改的注释框和这次拖动合成一步。
		drop: (drop) =>
			setMeta((m) => ({
				...m,
				annotations: [
					...applyAnnotationDrop(
						m.annotations,
						drop,
						drop.join
							? annotationMembersOfSelection(docRef.current, drop.join.nodes)
							: { nodes: [], subflows: [] },
					),
				],
			})),
	};
	const annotationHandlers = useRef(annotationActions);
	annotationHandlers.current = annotationActions;
	// 画布从这里取：只在正在改标题的注释框变化时换一个新对象。
	const annotationEdit = useMemo<AnnotationEdit>(
		() => ({
			renaming: renamingAnnotation,
			startRename: (id) => annotationHandlers.current.startRename(id),
			commitRename: (id, text) => annotationHandlers.current.commitRename(id, text),
			cancelRename: () => setRenamingAnnotation(null),
			setColor: (id, color) => annotationHandlers.current.setColor(id, color),
			remove: (id) => annotationHandlers.current.remove(id),
			create: (ids) => annotationHandlers.current.create(ids),
			arrange: (ids, mode) => annotationHandlers.current.arrange(ids, mode),
			drop: (drop) => annotationHandlers.current.drop(drop),
		}),
		[renamingAnnotation],
	);

	// —— 添加节点：有来源节点的接在它后面，没有来源的不连线（AddRequest）——
	const groups = useMemo(
		() => packageGroups(packages.data?.packages, agentList, meta.packages),
		[packages.data, agentList, meta.packages],
	);
	const addNode = (item: AddItem) => {
		const request: AddRequest = adding ?? { kind: "free" };
		setAdding(null);
		const id = uniqueNodeId(
			idStem(item),
			nodes.map((n) => n.id),
		);
		let next: { nodes: SfNode[]; edges: SfEdge[] };
		if (request.kind === "after") {
			// 有来源：接在它后面；它不是链尾时插在它和下一个节点之间，后面的节点让出位置。
			const fresh = { ...newDocNode(item, id), position: request.position } as OrchestrationNode;
			const edit = request.before
				? insertOnEdge(doc, { from: request.after, to: request.before }, fresh)
				: insertAfter(doc, request.after, fresh);
			if (!edit.ok) {
				notify.warning(edit.reason);
				return;
			}
			next = applyDocument(nodes, edges, edit.doc);
		} else if (request.kind === "dispatch") {
			// 从调度端口拖出（#187）：子流程入口的调度端口就在松开鼠标的位置，连上调度连线。
			next = {
				nodes: [...nodes, toFlowNode(newDocNode(item, id), request.position)],
				edges: [...edges, toFlowEdge({ from: request.from, to: id, kind: "dispatch" })],
			};
		} else {
			// 没有来源：右键处，否则视口中心；压住已有节点时错开。
			const position = freeCardSpot(
				request.position ?? viewportCenter(),
				nodes.map((n) => n.position),
				regionBoxes,
			);
			next = { nodes: [...nodes, toFlowNode(newDocNode(item, id), position)], edges };
		}
		const position = next.nodes.find((n) => n.id === id)?.position ?? { x: 0, y: 0 };
		if (item.kind === "async" && item.subflow !== undefined) {
			// 勾选了「同时新建子流程」（#187）：子流程入口和调度连线一起加，同一步撤销。
			const others = next.nodes.filter((n) => n.id !== id);
			const subflow = companionSubflow({ id, position }, item.subflow, others);
			next = {
				nodes: [...next.nodes, subflow.node],
				edges: [...next.edges, toFlowEdge(subflow.edge)],
			};
		}
		history.checkpoint();
		if (item.kind === "package" && meta.packages[item.package] !== item.version) {
			setMeta((m) => ({ ...m, packages: { ...m.packages, [item.package]: item.version } }));
		}
		setNodes(next.nodes);
		setEdges(next.edges);
		setSelection(selectNode(id));
		requestAnimationFrame(() => {
			// 接在来源节点右侧的新节点可能在视口外：移到中央。
			if (request.kind === "after" && !request.position) {
				void flow.setCenter(position.x + NODE_WIDTH / 2, position.y + NODE_HEIGHT / 2, {
					zoom: flow.getZoom(),
					duration: viewportDuration(VIEWPORT_MS),
				});
			}
			focusNewCard(id);
		});
	};
	if (running && adding) setAdding(null);
	/**
	 * 打开添加节点菜单；`after` 是来源节点，它不是链尾时新节点插在它和下一个节点之间。
	 * 在连线上插入（连线菜单、连线中点的「＋」）时直接给出 `before`。
	 */
	const openAddMenu = (request: AddRequest) => {
		if (request.kind !== "after" || request.before !== undefined) {
			setAdding(request);
			return;
		}
		const next = nodeConnections(docRef.current, request.after).out[0]?.to;
		setAdding(next === undefined ? request : { ...request, before: next });
	};
	// 运行状态下画布只读：添加、撤销 / 重做、整理布局都不生效（工具条上也不显示）。
	useShortcut("canvas-add", () => openAddMenu({ kind: "free" }), !running);
	useShortcut("canvas-undo", history.undo, !running);
	useShortcut("canvas-redo", history.redo, !running);
	useShortcut(
		"canvas-rename",
		() => {
			const id = soleNode(shownSelection);
			const annotation = selectedAnnotation(shownSelection);
			if (id) startRename(id);
			else if (annotation) setRenamingAnnotation(annotation);
		},
		!running,
	);
	useShortcut(
		"canvas-annotate",
		() => {
			if (shownSelection.kind === "nodes") addAnnotationAround(shownSelection.ids);
		},
		!running,
	);
	useShortcut(
		"canvas-annotation-delete",
		() => {
			const id = selectedAnnotation(shownSelection);
			if (id) deleteAnnotation(id);
		},
		!running,
	);
	// Tab：焦点在节点卡片上（新节点接在它后面）、或用鼠标点过画布空白处时（不连线）打开添加节点菜单，其他时候照常切换焦点。
	// 页面上没有焦点、或用键盘把焦点放到画布区域上（Tab 进入、Esc 退回）时不拦截（见 FlowCanvas 的 isPointerFocusedCanvas）：
	// 键盘用户能用 Tab 进出画布，进入后用方向键浏览节点（components/canvas/navigation.ts）。
	const openRef = useRef<((request: AddRequest) => void) | null>(openAddMenu);
	openRef.current = running ? null : openAddMenu;
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
				return;
			const open = openRef.current;
			// 有弹窗或弹出层打开时 Tab 照常切换焦点。
			if (!open || event.defaultPrevented || dialogOpen()) return;
			const target = event.target instanceof HTMLElement ? event.target : null;
			const card = target?.closest<HTMLElement>("[data-node-id]");
			const onCanvas =
				card || target?.classList.contains("react-flow__pane") || isPointerFocusedCanvas(target);
			if (!onCanvas) return;
			event.preventDefault();
			const after = card?.dataset.nodeId;
			open(after ? { kind: "after", after } : { kind: "free" });
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	// —— 整理布局：主链按注释框分段折行，子流程排在触发它的那一行下面（@sfly/orchestration，与初始布局同一套算法） ——
	// 整理之后画布把视图摆到看得清的大小（FlowCanvas 的 tidied）。
	const [tidied, setTidied] = useState(0);
	// 整理之后问一句保留还是还原：「还原」撤销这次整理；之后有了别的修改（或撤销、重做）就收起这条通知，
	// 免得「还原」撤掉的是别的修改。
	const tidyNotice = useRef<{ id: string | number; version: number | null } | null>(null);
	const tidy = () => {
		const layout = tidyLayout(doc);
		// 便签排在整理后的内容上方那一行（ADR 0026），和节点一起算一步撤销。
		const stickies = stickyNoteRow({
			...doc,
			nodes: doc.nodes.map((n) => ({ ...n, position: layout.get(n.id) ?? n.position })),
		});
		history.checkpoint();
		setNodes((ns) => ns.map((n) => ({ ...n, position: layout.get(n.id) ?? n.position })));
		if (stickies.size > 0) {
			setMeta((m) => ({
				...m,
				sticky_notes: m.sticky_notes.map((s) => ({
					...s,
					position: stickies.get(s.id) ?? s.position,
				})),
			}));
		}
		setTidied((n) => n + 1);
		if (tidyNotice.current) notify.dismiss(tidyNotice.current.id);
		const id = notify.success("已整理布局", {
			description: "保留整理后的布局，还是还原到整理之前？",
			action: { label: "还原", onClick: history.undo },
			cancel: { label: "保留", onClick: () => {} },
		});
		tidyNotice.current = { id, version: null };
	};
	useEffect(() => {
		const notice = tidyNotice.current;
		if (!notice) return;
		if (notice.version === null) notice.version = history.version;
		else if (notice.version !== history.version) {
			notify.dismiss(notice.id);
			tidyNotice.current = null;
		}
	}, [history.version]);
	useShortcut("canvas-tidy", tidy, !running);

	// —— 复制、粘贴、创建副本（node-clipboard）：新节点有新的 ID、不带连线，各是一步撤销 ——
	const clipboard = useNodeClipboard({
		enabled: !running,
		doc,
		nodes,
		regions: regionBoxes,
		selection: shownSelection,
		viewportCenter,
		toFlowPosition: (client) => flow.screenToFlowPosition(client),
		// 包版本锁定可能多了一项；选中并聚焦新节点。
		onPlace: (edit) => {
			applyEdit(edit.doc);
			if (edit.doc.packages !== doc.packages) {
				setMeta((m) => ({ ...m, packages: { ...m.packages, ...edit.doc.packages } }));
			}
			setSelection(selectNode(edit.id));
			requestAnimationFrame(() => focusNewCard(edit.id));
		},
	});

	const save = () => {
		const first = fieldErrors[0];
		if (first) {
			drafts.touch(fieldErrors.map(fieldErrorKey));
			setInspectorOpen(true);
			if (first.annotationId !== undefined) {
				setSelection(selectAnnotation(first.annotationId));
				focusField(fieldErrorKey(first));
				return;
			}
			if (first.stickyId !== undefined) {
				setSelection(selectSticky(first.stickyId));
				focusField(fieldErrorKey(first));
				return;
			}
			if (first.nodeId === undefined) setSelection(NO_SELECTION);
			else if (first.nodeId !== soleNode(selection)) locate(first.nodeId);
			setFocusRequest({ key: fieldErrorKey(first), nonce: Date.now() });
			return;
		}
		if (versioning.save.isPending) return;
		if (!versioning.dirty && versioning.base.version > 0) {
			notify.info("没有未保存的修改");
			return;
		}
		versioning.save.mutate(doc, {
			onSuccess: (saved) => {
				const { presets, rest } = splitPresetWarnings(saved.warnings);
				notify.success(
					`已保存为版本 ${saved.number}`,
					rest.length > 0 ? { description: warningsSummary(rest) } : undefined,
				);
				notifyInvalidatedPresets(presets);
			},
			onError: (error) => {
				if (!versionConflictOf(error)) {
					notify.error("保存失败", { description: error.message });
				}
			},
		});
	};
	// 正在原地改名时保存（Ctrl+S 或点保存按钮）：输入框里没确认的名称要先进文档。卡片拿到焦点，输入框失焦就是确认
	// （NodeTitleEditor，和 Enter 同一步撤销）；确认落进文档的那次渲染之后才保存，用的是带新名称的文档。
	// 点按钮时鼠标按下那一刻输入框就失焦确认了，按钮点下去时已经没在改名，直接保存。
	const [savePending, setSavePending] = useState(false);
	const saveShortcut = () => {
		const card = renamingId === null ? null : cardOf(renamingId);
		if (!card) {
			save();
			return;
		}
		card.focus({ preventScroll: true });
		setSavePending(true);
	};
	useEffect(() => {
		if (!savePending || renamingId !== null) return;
		setSavePending(false);
		save();
	});
	useShortcut("canvas-save", saveShortcut, !running);
	useShortcut("canvas-run", () => setTriggering(true), !running);

	const context: InspectorContext = {
		doc,
		catalog,
		info,
		packages: packages.data?.packages,
		agents: agentList,
		bots: botList,
		warnings,
		notes,
		shownFieldErrors: shownErrors,
		focusRequest,
		onChangeNode: updateNode,
		onDefaultAgent: (agent) => {
			history.checkpoint();
			setMeta((m) => ({ ...m, default_agent: agent }));
		},
		onLock: (name, version) => {
			history.checkpoint();
			setMeta((m) => ({ ...m, packages: { ...m.packages, [name]: version } }));
		},
		onLocate: locate,
		onDelete: deleteNodes,
		onAddAnnotation: addAnnotationAround,
		onChangeAnnotation: (next, field) =>
			changeAnnotations(
				(list) => updateAnnotation(list, next.id, () => next),
				field && `annotation:${next.id}:${field}`,
			),
		onDeleteAnnotation: deleteAnnotation,
		onLocateAnnotation: locateAnnotation,
		onChangeSticky: (next, field) =>
			changeStickies(
				(list) => list.map((s) => (s.id === next.id ? next : s)),
				field && `sticky:${next.id}:${field}`,
			),
		onDeleteSticky: (id) => stickyActions.remove(id),
	};

	/**
	 * 焦点移到检查器里第一个可操作的控件：当前页签里的；没有页签的检查器（多选、注释框）里标了 `data-focus-start`
	 * 的区域里的（多选是「添加注释框」，注释框是标题输入框），标题区的收起、删除按钮不算。
	 */
	const focusInspector = () => {
		setInspectorOpen(true);
		requestAnimationFrame(() => {
			const aside = inspectorRef.current;
			const target = aside?.querySelector<HTMLElement>(
				':is([role="tabpanel"], [data-focus-start]) :is(input, select, textarea, button, [contenteditable="true"]):not([disabled])',
			);
			(target ?? aside)?.focus();
		});
	};
	/** 检查器里按 Esc：焦点回到选中的节点上；选中的是注释框时回到画布区域（再用方向键浏览节点）。 */
	const focusCanvasNode = () => {
		const id = soleNode(shownSelection);
		if (id) cardOf(id)?.focus();
		else if (shownSelection.kind === "annotation") {
			document.querySelector<HTMLElement>("[data-canvas-region]")?.focus();
		}
	};

	return (
		<FieldDraftsProvider value={drafts.value}>
			<div className="fixed inset-0 bg-canvas-bg">
				<EditorTopLeft
					orchestration={orchestration}
					version={
						readyRun && running ? readyRun.run.orchestration_version : versioning.base.version
					}
					fieldErrors={shownErrors.length}
					warnings={warnings.length}
					notes={notes.length}
					onShowChecks={() => {
						setSelection(NO_SELECTION);
						setInspectorOpen(true);
					}}
					mode={mode}
					onMode={setMode}
					runState={<RunStateBadge state={runState} />}
				/>
				{running ? (
					<RunTopRight run={readyRun?.run} editors={editors} />
				) : (
					<>
						<EditorTopRight
							orchestration={orchestration}
							editors={editors}
							doc={doc}
							versioning={versioning}
							renaming={renamingId !== null}
							onSave={saveShortcut}
							onRun={() => setTriggering(true)}
							onReload={onReload}
						/>
						<div className="absolute top-15.5 left-3 z-10 max-w-[560px]">
							<DraftBanner
								orchestration={orchestration}
								doc={doc}
								versioning={versioning}
								onReload={onReload}
							/>
						</div>
					</>
				)}
				<FlowCanvas
					label={`编排画布：${orchestration.name}`}
					editable={!running}
					tidied={tidied}
					nodes={shownNodes}
					edges={shownEdges}
					annotations={shownAnnotations}
					stickyNotes={shownStickies}
					info={running ? runInfo : info}
					{...(running ? decorations : {})}
					selection={shownSelection}
					onSelect={setSelection}
					onNodesChange={running ? runFlow?.onNodesChange : history.onNodesChange}
					onEdgesChange={running ? undefined : history.onEdgesChange}
					onConnect={running ? undefined : onConnect}
					onConnectEnd={running ? undefined : onConnectEnd}
					isValidConnection={isValidConnection}
					insets={{
						top: TOP_GROUP_SPACE,
						right: inspectorSpace,
						bottom: 0,
						left: outlineSpace,
					}}
					onEnter={focusInspector}
					inspector={{ open: inspectorOpen, onToggle: () => setInspectorOpen((o) => !o) }}
					outline={{ open: outlineOpen, onToggle: () => setOutlineOpen((o) => !o) }}
					onDeleteNodes={running ? undefined : deleteNodes}
					onInsertOnEdge={
						running
							? undefined
							: (edge, client) =>
									openAddMenu({ kind: "after", after: edge.from, before: edge.to, client })
					}
					rename={running ? undefined : rename}
					annotationEdit={running ? undefined : annotationEdit}
					stickyEdit={running ? undefined : stickyEdit}
					reconnect={running ? undefined : reconnect.handlers}
					menu={(target) => (
						<EditorMenu
							target={target}
							outputsOf={(node) =>
								running && readyRun?.doc
									? declaredOutputs(readyRun.doc, node as OrchestrationNode, runCatalog)
									: declaredOutputs(doc, node as OrchestrationNode, catalog)
							}
							edit={
								running
									? undefined
									: {
											doc,
											canUndo: history.canUndo,
											canRedo: history.canRedo,
											openAddMenu,
											applyEdit,
											deleteNodes,
											startRename,
											clipboard,
											tidy,
											undo: history.undo,
											redo: history.redo,
											addAnnotationAround,
											arrange,
											addSticky,
											annotations: (nodeId) => ({
												annotations: meta.annotations,
												onAdd: () => addAnnotationAround([nodeId]),
												onJoin: (id) =>
													changeAnnotations((list) =>
														updateAnnotation(list, id, (a) => withNode(a, nodeId)),
													),
												onLeave: (id) =>
													changeAnnotations((list) => leaveAnnotation(list, id, nodeId)),
											}),
										}
							}
						/>
					)}
					dockStart={
						running ? undefined : (
							<AddNodeMenu
								request={adding}
								groups={groups}
								subflowNameProblem={(name) => newSubflowNameProblem(name, doc)}
								onOpenChange={(open) => setAdding(open ? { kind: "free" } : null)}
								onPick={addNode}
							/>
						)
					}
					dockTools={
						running ? undefined : (
							<>
								<ToolButton
									label="撤销"
									shortcut="canvas-undo"
									disabled={!history.canUndo}
									onClick={history.undo}
								>
									<Undo2Icon />
								</ToolButton>
								<ToolButton
									label="重做"
									shortcut="canvas-redo"
									disabled={!history.canRedo}
									onClick={history.redo}
								>
									<Redo2Icon />
								</ToolButton>
								<ToolButton label="整理布局" shortcut="canvas-tidy" onClick={tidy}>
									<Wand2Icon />
								</ToolButton>
							</>
						)
					}
				>
					{outlineOpen && (
						<OutlinePanel
							outline={outline}
							query={outlineQuery}
							onQuery={setOutlineQuery}
							selected={{
								nodes: shownSelection.kind === "nodes" ? shownSelection.ids : [],
								annotation: selectedAnnotation(shownSelection),
								sticky: selectedSticky(shownSelection),
							}}
							onLocateNode={locate}
							onLocateAnnotation={locateAnnotationBox}
							onLocateSticky={locateSticky}
							onCollapse={() => setOutlineOpen(false)}
						/>
					)}
					{inspectorOpen && running && (
						<RunStateInspector
							ref={inspectorRef}
							state={runState}
							selection={shownSelection}
							nodeOf={nodeOf}
							info={runInfo}
							onCollapse={() => setInspectorOpen(false)}
							onEscape={focusCanvasNode}
						/>
					)}
					{inspectorOpen && !running && (
						<Inspector
							ref={inspectorRef}
							selection={shownSelection}
							nodeOf={nodeOf}
							context={context}
							onCollapse={() => setInspectorOpen(false)}
							onEscape={focusCanvasNode}
						/>
					)}
				</FlowCanvas>
				<RunDrawer
					open={triggering}
					onOpenChange={setTriggering}
					orchestrationId={orchestration.id}
					name={orchestration.name}
					description={orchestration.description}
					dirty={versioning.dirty || hasDraft(orchestration.id)}
					baseVersion={versioning.base.version}
					onLocate={locate}
				/>
			</div>
		</FieldDraftsProvider>
	);
}
