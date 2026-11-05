import { checkConnection, documentWarnings, type OrchestrationWarning } from "@sfly/orchestration";
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
import { useCallback, useMemo, useRef, useState } from "react";
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
} from "#/canvas/flow";
import type { CanvasInfo } from "#/components/canvas/context";
import { FlowCanvas } from "#/components/canvas/FlowCanvas";
import { notify } from "#/components/feedback/notify";
import { useShortcut } from "#/components/shortcuts";
import { apiQuery, type Orchestration, type OrchestrationHead } from "#/lib/api";
import { TriggerDialog } from "#/runs/TriggerDialog";
import { versionConflictOf } from "#/versions/api";
import { hasDraft } from "#/versions/draft";
import { type EditStart, startEditing, useVersionedDraft } from "#/versions/useVersionedDraft";
import { StaleDraftBanner } from "#/versions/VersionControls";
import { EditorTopLeft, EditorTopRight, TOP_GROUP_SPACE } from "./EditorChrome";
import { FieldDraftsProvider, useFieldDraftStore } from "./field-drafts";
import { Inspector, type InspectorContext } from "./inspector/Inspector";
import { documentFieldErrors, type FieldError } from "./validation";

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

	const doc = useMemo(() => fromFlow(nodes, edges, meta), [nodes, edges, meta]);
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
			setEdges((es) => [...es, toFlowEdge({ from: c.source, to: c.target, kind: edgeKindOf(c) })]);
		},
		[connectionProblem, setEdges],
	);
	/** 拖到某个端口上但连线被拒绝时，提示原因。 */
	const onConnectEnd: OnConnectEnd = useCallback(
		(_event, state) => {
			if (state.isValid !== false || !state.fromNode || !state.toNode) return;
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
		[connectionProblem],
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
	const updateNode = (id: string, node: DocNode) =>
		setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { node } } : n)));

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

	const selectedNode = selectedId ? nodes.find((n) => n.id === selectedId) : undefined;
	const context: InspectorContext = {
		doc,
		catalog,
		info,
		packages: packages.data?.packages,
		agents: agentList,
		warnings,
		fieldErrors,
		onChangeNode: updateNode,
		onDefaultAgent: (agent) => setMeta((m) => ({ ...m, default_agent: agent })),
		onLock: (name, version) =>
			setMeta((m) => ({ ...m, packages: { ...m.packages, [name]: version } })),
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
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
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
