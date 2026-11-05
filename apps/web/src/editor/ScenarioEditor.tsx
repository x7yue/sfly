import {
	checkConnection,
	documentWarnings,
	LAYOUT_COLUMN,
	type OrchestrationWarning,
	SUBFLOW_TOP_GAP,
	tidyLayout,
} from "@sfly/orchestration";
import { agentsApi, packagesApi } from "@sfly/schema";
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
import { usePackageCatalog } from "#/canvas/catalog";
import {
	type DocMeta,
	type DocNode,
	type EdgeKind,
	fromFlow,
	type SfEdge,
	type SfNode,
	toFlow,
	toFlowEdge,
	uniqueNodeId,
} from "#/canvas/flow";
import { ToolButton } from "#/components/canvas/CanvasDock";
import type { CanvasInfo } from "#/components/canvas/context";
import { FlowCanvas } from "#/components/canvas/FlowCanvas";
import { NODE_HEIGHT, NODE_WIDTH } from "#/components/canvas/geometry";
import { notify } from "#/components/feedback/notify";
import { useShortcut } from "#/components/shortcuts";
import { apiQuery, type Orchestration, type OrchestrationHead } from "#/lib/api";
import { TriggerDialog } from "#/runs/TriggerDialog";
import { versionConflictOf } from "#/versions/api";
import { hasDraft } from "#/versions/draft";
import { type EditStart, startEditing, useVersionedDraft } from "#/versions/useVersionedDraft";
import { StaleDraftBanner } from "#/versions/VersionControls";
import { AddNodeMenu, type AddRequest } from "./AddNodeMenu";
import {
	type AddItem,
	appendTarget,
	idStem,
	isChainTail,
	newDocNode,
	packageGroups,
} from "./add-node";
import { EditorTopLeft, EditorTopRight, TOP_GROUP_SPACE } from "./EditorChrome";
import { useEditHistory } from "./edit-history";
import { FieldDraftsProvider, useFieldDraftStore } from "./field-drafts";
import { Inspector, type InspectorContext } from "./inspector/Inspector";
import { documentFieldErrors, type FieldError } from "./validation";

/** 打开着的弹窗或弹出层（有它们时 Tab 照常切换焦点）。 */
const OPEN_OVERLAY = '[role="dialog"][data-open], [role="alertdialog"][data-open]';

/** 检查器（宽 372 + 右边距 12）占住的宽度。 */
const INSPECTOR_SPACE = 384;

/**
 * 全屏编排画布（原型 #/editor/:id 的编辑模式）：画布铺满视口，控件悬浮——左上场景名 / 版本 / 检查状态 /
 * 模式切换，右上在线编辑者 / 未保存状态 / 版本历史 / 保存 / 运行，底部工具条，左下小地图，右侧检查器。
 * 本地草稿与显式保存版本沿用 useVersionedDraft（刷新不丢失；保存时以编辑起点为 base_version，冲突不自动合并）。
 */
export function ScenarioEditor({
	orchestration,
	head,
}: {
	orchestration: Orchestration;
	head: OrchestrationHead;
}) {
	// 编辑起点：本地草稿（刷新不丢失）或最新版本；放弃本地修改后用最新版本重建画布。
	const [start, setStart] = useState(() => startEditing(orchestration.id, head));
	return (
		<ReactFlowProvider key={start.nonce}>
			<Editor
				orchestration={orchestration}
				start={start}
				onReload={(latest) => setStart(startEditing(orchestration.id, latest, start.nonce + 1))}
			/>
		</ReactFlowProvider>
	);
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
	onReload,
}: {
	orchestration: Orchestration;
	start: EditStart;
	onReload: (head: OrchestrationHead) => void;
}) {
	const flow = useReactFlow<SfNode, SfEdge>();
	const initial = useMemo(() => toFlow(start.document), [start.document]);
	const [nodes, setNodes, onNodesChange] = useNodesState<SfNode>(initial.nodes);
	const [edges, setEdges, onEdgesChange] = useEdgesState<SfEdge>(initial.edges);
	const [meta, setMeta] = useState<DocMeta>({
		default_agent: start.document.default_agent,
		packages: start.document.packages,
	});
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [inspectorOpen, setInspectorOpen] = useState(true);
	const [triggering, setTriggering] = useState(false);
	const inspectorRef = useRef<HTMLElement>(null);
	const drafts = useFieldDraftStore();

	const packages = useQuery(apiQuery(packagesApi.list));
	const agents = useQuery({ ...apiQuery(agentsApi.list), refetchInterval: 10_000 });
	const agentList = agents.data?.agents ?? [];
	const titleOf = usePackageTitles();

	// —— 撤销 / 重做：修改编排的操作都先记下修改前的状态（edit-history.ts） ——
	const history = useEditHistory(
		{ nodes, edges, meta },
		{ nodes: setNodes, edges: setEdges, meta: setMeta },
		{ nodes: onNodesChange, edges: onEdgesChange },
	);
	useShortcut("canvas-undo", history.undo);
	useShortcut("canvas-redo", history.redo);

	const doc = useMemo(() => fromFlow(nodes, edges, meta), [nodes, edges, meta]);
	const selectedNode = selectedId ? nodes.find((n) => n.id === selectedId) : undefined;
	// 结构、包版本锁定、引用的静态检查，与控制面保存时返回的警告是同一套规则。
	const catalog = usePackageCatalog(meta.packages, agentList);
	const warnings = useMemo(() => documentWarnings(doc, catalog), [doc, catalog]);
	const versioning = useVersionedDraft(orchestration.id, start, doc);
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
			warnings: warningsByNode,
		}),
		[meta, titleOf, warningsByNode],
	);

	// —— 连线：只允许单入单出，规则与控制面共用（@sfly/orchestration） ——
	const docRef = useRef(doc);
	docRef.current = doc;
	const connectionProblem = useCallback((c: Connection | Edge): string | null => {
		if ((c.sourceHandle ?? "chain") !== (c.targetHandle ?? "chain")) {
			return "链端口只能连链端口，调度端口只能连调度端口";
		}
		return checkConnection(docRef.current, { from: c.source, to: c.target, kind: edgeKindOf(c) });
	}, []);
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
	 * 从链尾端口拖线到空白处：弹出可以接上的节点菜单；拖到某个端口上但连线被拒绝时，提示原因。
	 */
	const onConnectEnd: OnConnectEnd = useCallback(
		(event, state) => {
			if (!state.fromNode) return;
			if (!state.toNode) {
				if (state.fromHandle?.type !== "source" || state.fromHandle.id === "dispatch") return;
				if (!isChainTail(docRef.current, state.fromNode.id)) {
					notify.warning("只能在主链或子流程的链尾追加节点");
					return;
				}
				const point = "changedTouches" in event ? event.changedTouches[0] : event;
				if (!point) return;
				const at = flow.screenToFlowPosition({ x: point.clientX, y: point.clientY });
				setAdding({
					via: "drop",
					tail: state.fromNode.id,
					client: { x: point.clientX, y: point.clientY },
					position: { x: at.x, y: at.y - NODE_HEIGHT / 2 },
				});
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
		[connectionProblem, flow],
	);

	const select = useCallback((id: string | null) => setSelectedId(id), []);
	/** 选中并定位到某个节点（检查结果、调度关系、触发预检里的「前往」）。 */
	const locate = useCallback(
		(id: string) => {
			setSelectedId(id);
			const node = flow.getNode(id);
			if (node) {
				void flow.setCenter(node.position.x + 104, node.position.y + 56, {
					zoom: Math.max(flow.getZoom(), 0.8),
					duration: 200,
				});
			}
		},
		[flow],
	);
	const deleteNode = (id: string) => {
		drafts.clear(`${id}/`);
		setSelectedId(null);
		void flow.deleteElements({ nodes: [{ id }] });
	};
	const updateNode = (id: string, node: DocNode) => {
		// 同一个节点上连续的输入合并为一步撤销。
		history.checkpoint(`node:${id}`);
		setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { node } } : n)));
	};

	// —— 添加节点：只能接在主链或子流程的链尾；子流程入口在所有节点下方开一个新的子流程区域 ——
	const groups = useMemo(
		() => packageGroups(packages.data?.packages, agentList, meta.packages),
		[packages.data, agentList, meta.packages],
	);
	const menuTail =
		adding?.via === "drop" ? adding.tail : appendTarget(doc, selectedNode ? selectedId : null);
	const addNode = (item: AddItem) => {
		const request = adding;
		setAdding(null);
		const tail = request?.via === "drop" ? request.tail : menuTail;
		const id = uniqueNodeId(
			idStem(item),
			nodes.map((n) => n.id),
		);
		const chained = item.kind !== "subflow_entry" && tail !== undefined;
		const tailNode = tail ? nodes.find((n) => n.id === tail) : undefined;
		const bottom = Math.max(0, ...nodes.map((n) => n.position.y + NODE_HEIGHT));
		const right = Math.max(0, ...nodes.map((n) => n.position.x + LAYOUT_COLUMN));
		const position =
			request?.via === "drop"
				? request.position
				: item.kind === "subflow_entry"
					? { x: 0, y: bottom + SUBFLOW_TOP_GAP }
					: tailNode
						? { x: tailNode.position.x + LAYOUT_COLUMN, y: tailNode.position.y }
						: { x: right, y: 0 };
		history.checkpoint();
		if (item.kind === "package" && meta.packages[item.package] !== item.version) {
			setMeta((m) => ({ ...m, packages: { ...m.packages, [item.package]: item.version } }));
		}
		setNodes((ns) => [
			...ns,
			{ id, type: item.kind, position, data: { node: newDocNode(item, id) }, deletable: true },
		]);
		if (chained) setEdges((es) => [...es, toFlowEdge({ from: tail, to: id, kind: "chain" })]);
		setSelectedId(id);
		requestAnimationFrame(() => {
			if (request?.via !== "drop") {
				void flow.setCenter(position.x + NODE_WIDTH / 2, position.y + NODE_HEIGHT / 2, {
					zoom: flow.getZoom(),
					duration: 200,
				});
			}
			document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`)?.focus();
		});
	};
	const openAddMenu = () => setAdding({ via: "menu" });
	useShortcut("canvas-add", openAddMenu);
	// Tab：焦点在画布上（或页面上没有焦点）时打开添加节点菜单，其他时候照常切换焦点。
	const openRef = useRef(openAddMenu);
	openRef.current = openAddMenu;
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
				return;
			if (event.defaultPrevented || document.querySelector(OPEN_OVERLAY)) return;
			const target = event.target instanceof HTMLElement ? event.target : null;
			const onCanvas =
				target === document.body ||
				target?.closest("[data-node-id]") ||
				target?.classList.contains("react-flow__pane") ||
				target?.matches('[role="region"][aria-label^="编排画布"]');
			if (!onCanvas) return;
			event.preventDefault();
			openRef.current();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	// —— 整理布局：主链两行折返、子流程放在下方区域（@sfly/orchestration，与初始布局同一套算法） ——
	const tidy = () => {
		const layout = tidyLayout(doc);
		history.checkpoint();
		setNodes((ns) => ns.map((n) => ({ ...n, position: layout.get(n.id) ?? n.position })));
		notify.success("已整理布局", { description: "可以撤销（Ctrl Z）" });
	};
	useShortcut("canvas-tidy", tidy);

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
	useShortcut("canvas-save", save);

	const context: InspectorContext = {
		doc,
		catalog,
		info,
		packages: packages.data?.packages,
		agents: agentList,
		warnings,
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
				'[role="tabpanel"] :is(input, select, textarea, button):not([disabled])',
			);
			(target ?? aside)?.focus();
		});
	};
	const focusCanvasNode = () => {
		const card = selectedId
			? document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(selectedId)}"]`)
			: null;
		card?.focus();
	};

	return (
		<FieldDraftsProvider value={drafts.value}>
			<div className="fixed inset-0 bg-canvas-bg">
				<FlowCanvas
					label={`编排画布：${orchestration.name}`}
					editable
					nodes={nodes}
					edges={edges}
					info={info}
					selectedId={selectedNode ? selectedId : null}
					onSelect={select}
					onNodesChange={history.onNodesChange}
					onEdgesChange={history.onEdgesChange}
					onConnect={onConnect}
					onConnectEnd={onConnectEnd}
					isValidConnection={isValidConnection}
					insets={{
						top: TOP_GROUP_SPACE,
						right: inspectorOpen ? INSPECTOR_SPACE : 0,
						bottom: 0,
						left: 0,
					}}
					onEnter={focusInspector}
					inspector={{ open: inspectorOpen, onToggle: () => setInspectorOpen((o) => !o) }}
					dockStart={
						<AddNodeMenu
							request={adding}
							tail={menuTail}
							groups={groups}
							onOpenChange={(open) => setAdding(open ? { via: "menu" } : null)}
							onPick={addNode}
						/>
					}
					dockTools={
						<>
							<ToolButton
								label="撤销"
								keys="Ctrl Z"
								disabled={!history.canUndo}
								onClick={history.undo}
							>
								<Undo2Icon />
							</ToolButton>
							<ToolButton
								label="重做"
								keys="Ctrl Shift Z"
								disabled={!history.canRedo}
								onClick={history.redo}
							>
								<Redo2Icon />
							</ToolButton>
							<ToolButton label="整理布局" keys="Alt Shift F" onClick={tidy}>
								<Wand2Icon />
							</ToolButton>
						</>
					}
				>
					<EditorTopLeft
						orchestration={orchestration}
						version={versioning.base.version}
						warnings={warnings.length}
						onShowChecks={() => {
							setSelectedId(null);
							setInspectorOpen(true);
						}}
					/>
					<EditorTopRight
						orchestration={orchestration}
						doc={doc}
						versioning={versioning}
						fieldErrors={fieldErrors.length}
						onSave={save}
						onRun={() => setTriggering(true)}
						onReload={onReload}
					/>
					<div className="absolute top-15.5 left-3 z-10 max-w-[560px]">
						<StaleDraftBanner
							orchestration={orchestration}
							doc={doc}
							versioning={versioning}
							onReload={onReload}
						/>
					</div>
					{inspectorOpen && (
						<Inspector
							ref={inspectorRef}
							selected={selectedNode ? { id: selectedNode.id, node: selectedNode.data.node } : null}
							context={context}
							onCollapse={() => setInspectorOpen(false)}
							onEscape={focusCanvasNode}
						/>
					)}
				</FlowCanvas>
				{triggering && (
					<TriggerDialog
						orchestrationId={orchestration.id}
						dirty={versioning.dirty || hasDraft(orchestration.id)}
						baseVersion={versioning.base.version}
						onLocate={locate}
						onClose={() => setTriggering(false)}
					/>
				)}
			</div>
		</FieldDraftsProvider>
	);
}
