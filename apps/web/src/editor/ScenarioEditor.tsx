import {
	checkConnection,
	declaredOutputs,
	documentWarnings,
	freeCardAt,
	insertAfter,
	insertOnEdge,
	nodeConnections,
	type OrchestrationWarning,
	outgoingProblem,
	removeNode,
	tidyLayout,
	uniqueNodeId,
} from "@sfly/orchestration";
import {
	agentsApi,
	feishuBotsApi,
	type OrchestrationHeadView,
	type OrchestrationNode,
	type OrchestrationView,
	packagesApi,
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
import type { CanvasInfo } from "#/components/canvas/context";
import { FlowCanvas, isPointerFocusedCanvas } from "#/components/canvas/FlowCanvas";
import {
	applyDocument,
	type DocMeta,
	type DocNode,
	type EdgeKind,
	fromFlow,
	type SfEdge,
	type SfNode,
	toFlow,
	toFlowEdge,
	toFlowNode,
} from "#/components/canvas/flow";
import { NODE_HEIGHT, NODE_WIDTH } from "#/components/canvas/geometry";
import { subflowLabels } from "#/components/canvas/node-display";
import { notify } from "#/components/feedback/notify";
import { useShortcut } from "#/components/shortcuts";
import { apiQuery } from "#/lib/api";
import { dialogOpen } from "#/lib/focus";
import { usePanelWidth } from "#/lib/panel-width";
import { BACKGROUND_POLL_MS } from "#/lib/polling";
import { useOtherEditors } from "#/lib/presence";
import { shortcutText } from "#/lib/shortcuts";
import { RunDrawer } from "#/run-drawer/RunDrawer";
import { DraftBanner } from "#/versions/DraftBanner";
import { hasDraft } from "#/versions/draft";
import { versionConflictOf } from "#/versions/queries";
import { type EditStart, startEditing, useVersionedDraft } from "#/versions/useVersionedDraft";
import { AddNodeMenu, type AddRequest } from "./AddNodeMenu";
import { type AddItem, idStem, newDocNode, newSubflowNameProblem, packageGroups } from "./add-node";
import { companionSubflow } from "./add-subflow";
import { usePackageCatalog, useRegisteredAgents, useRegisteredBots } from "./catalog";
import { type EditorMode, EditorTopLeft, EditorTopRight, TOP_GROUP_SPACE } from "./EditorChrome";
import { EditorMenu } from "./EditorMenu";
import { useEditHistory } from "./edit-history";
import { FieldDraftsProvider, useFieldDraftStore } from "./field-drafts";
import { Inspector, type InspectorContext } from "./inspector/Inspector";
import { useNodeClipboard } from "./node-clipboard";
import { useReconnect } from "./reconnect";
import {
	RunStateBadge,
	RunStateInspector,
	RunTopRight,
	useRunDecorations,
} from "./run-state/RunState";
import { useCanvasRun, useRunFlow } from "./run-state/use-canvas-run";
import { documentFieldErrors, type FieldError, undeclaredInputNotes } from "./validation";

/** 检查器右边距。 */
const INSPECTOR_MARGIN = 12;

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

function usePackageTitles(): (pkg: string, node: string) => string | undefined {
	const packages = useQuery(apiQuery(packagesApi.list));
	return useMemo(() => {
		const titles = new Map<string, string>();
		for (const pkg of packages.data?.packages ?? []) {
			for (const v of pkg.versions) {
				for (const n of v.nodes) {
					const key = `${pkg.name}/${n.name}`;
					if (!titles.has(key)) titles.set(key, n.title);
				}
			}
		}
		return (pkg, node) => titles.get(`${pkg}/${node}`);
	}, [packages.data]);
}

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
	});
	const [selectedId, setSelectedId] = useState<string | null>(initialNode ?? null);
	const [inspectorOpen, setInspectorOpen] = useState(true);
	const inspectorWidth = usePanelWidth();
	/** 检查器（实际宽度 + 右边距）占住的宽度：适配视图与定位节点时避开。 */
	const inspectorSpace = inspectorOpen ? inspectorWidth + INSPECTOR_MARGIN : 0;
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
		{ nodes, edges, meta },
		{ nodes: setNodes, edges: setEdges, meta: setMeta },
		{ nodes: onNodesChange, edges: onEdgesChange },
	);

	const doc = useMemo(() => fromFlow(nodes, edges, meta), [nodes, edges, meta]);
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
	const decorations = useRunDecorations(readyRun?.run, readyRun?.overlay, readyRun?.metrics);
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

	const select = useCallback((id: string | null) => setSelectedId(id), []);
	/** 选中并定位到某个节点（检查结果、调度关系、触发预检里的「前往」）。 */
	const locate = useCallback(
		(id: string) => {
			setSelectedId(id);
			const node = flow.getNode(id);
			if (node) {
				// 定位到没被检查器占住的那部分画布的中间。
				const zoom = Math.max(flow.getZoom(), 0.8);
				void flow.setCenter(
					node.position.x + NODE_WIDTH / 2 + inspectorSpace / 2 / zoom,
					node.position.y + NODE_HEIGHT / 2,
					{ zoom, duration: 200 },
				);
			}
		},
		[flow, inspectorSpace],
	);
	/** 视口里没被顶栏和检查器占住的那部分的中心（画布坐标）：没有位置的新节点、粘贴的节点放在这里。 */
	const viewportCenter = () =>
		flow.screenToFlowPosition({
			x: (window.innerWidth - inspectorSpace) / 2,
			y: (window.innerHeight + TOP_GROUP_SPACE) / 2,
		});
	/** 把文档操作（@sfly/orchestration 的 chain-edits）的结果写回画布，算一步撤销。 */
	const applyEdit = (next: Pick<typeof doc, "nodes" | "edges">) => {
		const applied = applyDocument(nodes, edges, next);
		history.checkpoint();
		setNodes(applied.nodes);
		setEdges(applied.edges);
	};
	/** 删除节点（Delete 键、节点菜单、检查器的删除按钮）：恰好一进一出时前后自动接上。 */
	const deleteNode = (id: string) => {
		const edit = removeNode(doc, id);
		if (!edit.ok) {
			notify.warning(edit.reason);
			return;
		}
		drafts.clear(`${id}/`);
		if (selectedId === id) setSelectedId(null);
		applyEdit(edit.doc);
	};
	const updateNode = (id: string, node: DocNode) => {
		// 同一个节点上连续的输入合并为一步撤销。
		history.checkpoint(`node:${id}`);
		setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { node } } : n)));
	};

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
			const position = freeCardAt(
				request.position ?? viewportCenter(),
				nodes.map((n) => n.position),
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
		setSelectedId(id);
		requestAnimationFrame(() => {
			// 接在来源节点右侧的新节点可能在视口外：移到中央。
			if (request.kind === "after" && !request.position) {
				void flow.setCenter(position.x + NODE_WIDTH / 2, position.y + NODE_HEIGHT / 2, {
					zoom: flow.getZoom(),
					duration: 200,
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

	// —— 整理布局：主链两行折返、子流程放在下方区域（@sfly/orchestration，与初始布局同一套算法） ——
	const tidy = () => {
		const layout = tidyLayout(doc);
		history.checkpoint();
		setNodes((ns) => ns.map((n) => ({ ...n, position: layout.get(n.id) ?? n.position })));
		notify.success("已整理布局", { description: `可以撤销（${shortcutText("canvas-undo")}）` });
	};
	useShortcut("canvas-tidy", tidy, !running);

	// —— 复制、粘贴、创建副本（node-clipboard）：新节点有新的 ID、不带连线，各是一步撤销 ——
	const clipboard = useNodeClipboard({
		enabled: !running,
		doc,
		nodes,
		selectedId,
		viewportCenter,
		toFlowPosition: (client) => flow.screenToFlowPosition(client),
		// 包版本锁定可能多了一项；选中并聚焦新节点。
		onPlace: (edit) => {
			applyEdit(edit.doc);
			if (edit.doc.packages !== doc.packages) {
				setMeta((m) => ({ ...m, packages: { ...m.packages, ...edit.doc.packages } }));
			}
			setSelectedId(edit.id);
			requestAnimationFrame(() => focusNewCard(edit.id));
		},
	});

	const save = () => {
		if (fieldErrors.length > 0) {
			notify.warning(`有 ${fieldErrors.length} 处字段错误，改正后才能保存`);
			return;
		}
		if (versioning.save.isPending || (!versioning.dirty && versioning.base.version > 0)) return;
		versioning.save.mutate(doc, {
			onSuccess: (saved) =>
				notify.success(
					`已保存为版本 ${saved.number}`,
					saved.warnings.length > 0
						? { description: `${saved.warnings.length} 条警告，触发运行前需要处理` }
						: undefined,
				),
			onError: (error) => {
				if (!versionConflictOf(error)) {
					notify.error("保存失败", { description: error.message });
				}
			},
		});
	};
	useShortcut("canvas-save", save, !running);

	const selectedNode = selectedId ? shownNodes.find((n) => n.id === selectedId) : undefined;
	const context: InspectorContext = {
		doc,
		catalog,
		info,
		packages: packages.data?.packages,
		agents: agentList,
		bots: botList,
		warnings,
		notes,
		fieldErrors,
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
		onDelete: deleteNode,
	};

	const focusInspector = () => {
		setInspectorOpen(true);
		requestAnimationFrame(() => {
			const aside = inspectorRef.current;
			const target = aside?.querySelector<HTMLElement>(
				'[role="tabpanel"] :is(input, select, textarea, button, [contenteditable="true"]):not([disabled])',
			);
			(target ?? aside)?.focus();
		});
	};
	const focusCanvasNode = () => {
		if (selectedId) cardOf(selectedId)?.focus();
	};

	return (
		<FieldDraftsProvider value={drafts.value}>
			<div className="fixed inset-0 bg-canvas-bg">
				<EditorTopLeft
					orchestration={orchestration}
					version={
						readyRun && running ? readyRun.run.orchestration_version : versioning.base.version
					}
					fieldErrors={fieldErrors.length}
					warnings={warnings.length}
					notes={notes.length}
					onShowChecks={() => {
						setSelectedId(null);
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
							fieldErrors={fieldErrors.length}
							onSave={save}
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
					nodes={shownNodes}
					edges={shownEdges}
					info={running ? runInfo : info}
					{...(running ? decorations : {})}
					selectedId={selectedNode ? selectedId : null}
					onSelect={select}
					onNodesChange={running ? runFlow?.onNodesChange : history.onNodesChange}
					onEdgesChange={running ? undefined : history.onEdgesChange}
					onConnect={running ? undefined : onConnect}
					onConnectEnd={running ? undefined : onConnectEnd}
					isValidConnection={isValidConnection}
					insets={{
						top: TOP_GROUP_SPACE,
						right: inspectorSpace,
						bottom: 0,
						left: 0,
					}}
					onEnter={focusInspector}
					inspector={{ open: inspectorOpen, onToggle: () => setInspectorOpen((o) => !o) }}
					onDeleteNode={running ? undefined : deleteNode}
					onInsertOnEdge={
						running
							? undefined
							: (edge, client) =>
									openAddMenu({ kind: "after", after: edge.from, before: edge.to, client })
					}
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
											deleteNode,
											clipboard,
											tidy,
											undo: history.undo,
											redo: history.redo,
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
					{inspectorOpen && running && (
						<RunStateInspector
							ref={inspectorRef}
							state={runState}
							selected={selectedNode ? { id: selectedNode.id, node: selectedNode.data.node } : null}
							info={runInfo}
							onCollapse={() => setInspectorOpen(false)}
							onEscape={focusCanvasNode}
						/>
					)}
					{inspectorOpen && !running && (
						<Inspector
							ref={inspectorRef}
							selected={selectedNode ? { id: selectedNode.id, node: selectedNode.data.node } : null}
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
