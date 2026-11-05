import { checkConnection, documentWarnings, type OrchestrationWarning } from "@sfly/orchestration";
import { agentsApi, packagesApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	Background,
	type Connection,
	Controls,
	type Edge,
	MiniMap,
	type OnConnectEnd,
	ReactFlow,
	ReactFlowProvider,
	useEdgesState,
	useNodesState,
	useReactFlow,
} from "@xyflow/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { apiQuery, type Orchestration, type OrchestrationHead } from "#/lib/api";
import { TriggerDialog } from "#/runs/TriggerDialog";
import { hasDraft } from "#/versions/draft";
import { type EditStart, startEditing, useVersionedDraft } from "#/versions/useVersionedDraft";
import { StaleDraftBanner, VersionControls } from "#/versions/VersionControls";
import { usePackageCatalog } from "./catalog";
import { edgeTypes } from "./edges";
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
} from "./flow";
import { AgentSelect, NodeInspector, Section, WarningList } from "./Inspector";
import { CanvasContext, type CanvasInfo, nodeTitle, nodeTypes } from "./NodeCard";
import {
	BUILTIN_MIME,
	type BuiltinKind,
	BuiltinPalette,
	NodePalette,
	PALETTE_MIME,
	type PaletteItem,
} from "./NodePalette";
import { PackageVersions } from "./PackageVersions";
import { PresenceIndicator } from "./PresenceIndicator";
import { SubflowRegions } from "./SubflowRegions";
import { isWaitKind, newWaitNode } from "./WaitNodes";

export function OrchestrationEditor({
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
	const [notice, setNotice] = useState<string | null>(null);
	const [triggering, setTriggering] = useState(false);

	const packages = useQuery(apiQuery(packagesApi.list));
	const agents = useQuery({ ...apiQuery(agentsApi.list), refetchInterval: 10_000 });
	const agentList = agents.data?.agents ?? [];

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

	const titles = useMemo(() => {
		const map = new Map<string, string>();
		for (const pkg of packages.data?.packages ?? []) {
			for (const v of pkg.versions) {
				for (const n of v.nodes) {
					const key = `${pkg.name}/${n.name}`;
					if (!map.has(key)) map.set(key, n.title);
				}
			}
		}
		return map;
	}, [packages.data]);

	const canvasInfo: CanvasInfo = useMemo(
		() => ({
			defaultAgent: meta.default_agent,
			titleOf: (pkg, node) => titles.get(`${pkg}/${node}`),
			packages: meta.packages,
			warnings: warningsByNode,
		}),
		[meta, titles, warningsByNode],
	);

	// —— 连线：只允许单入单出，规则与控制面共用（@sfly/orchestration） ——
	const docRef = useRef(doc);
	docRef.current = doc;
	const connectionProblem = useCallback((c: Connection | Edge): string | null => {
		if ((c.sourceHandle ?? "chain") !== (c.targetHandle ?? "chain")) {
			return "链端口只能连链端口，调度端口只能连调度端口";
		}
		return checkConnection(docRef.current, {
			from: c.source,
			to: c.target,
			kind: edgeKindOf(c),
		});
	}, []);
	const isValidConnection = useCallback(
		(c: Connection | Edge) => connectionProblem(c) === null,
		[connectionProblem],
	);
	const onConnect = useCallback(
		(c: Connection) => {
			const problem = connectionProblem(c);
			if (problem) {
				setNotice(problem);
				return;
			}
			setNotice(null);
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
			if (problem) setNotice(problem);
		},
		[connectionProblem],
	);

	// —— 放置包节点 ——
	const addPackageNode = useCallback(
		(item: PaletteItem, position: { x: number; y: number }) => {
			const locked = meta.packages[item.package];
			if (locked && locked !== item.version) {
				setNotice(`编排已锁定 ${item.package}@${locked}，不能同时使用 ${item.version}`);
				return;
			}
			setMeta((m) => ({ ...m, packages: { ...m.packages, [item.package]: item.version } }));
			setNodes((ns) => {
				const id = uniqueNodeId(
					item.node,
					ns.map((n) => n.id),
				);
				const node: DocNode = {
					id,
					kind: "package",
					package: item.package,
					node: item.node,
					always: false,
					inputs: {},
				};
				return [
					...ns.map((n) => ({ ...n, selected: false })),
					{ id, type: "package", position, data: { node }, selected: true },
				];
			});
		},
		[meta.packages, setNodes],
	);

	// —— 放置内置节点（异步任务、子流程入口、定时、Sleep） ——
	const addBuiltinNode = useCallback(
		(kind: BuiltinKind, position: { x: number; y: number }) => {
			setNodes((ns) => {
				const id = uniqueNodeId(
					kind === "subflow_entry" ? "subflow" : kind,
					ns.map((n) => n.id),
				);
				const node: DocNode = isWaitKind(kind)
					? newWaitNode(kind, id)
					: kind === "async"
						? { id, kind, params: {} }
						: { id, kind, params: [] };
				return [
					...ns.map((n) => ({ ...n, selected: false })),
					{ id, type: kind, position, data: { node }, selected: true },
				];
			});
		},
		[setNodes],
	);

	/**
	 * 点击添加的位置：子流程入口放在所有节点下方（开一个新的子流程区域），
	 * 其余放在最右侧节点的右边（链自然延伸的方向）；并把视口移过去。
	 */
	const placeNext = (below: boolean, add: (position: { x: number; y: number }) => void) => {
		const pick = (better: (a: SfNode, b: SfNode) => boolean) =>
			nodes.reduce<SfNode | undefined>(
				(best, n) => (!best || better(n, best) ? n : best),
				undefined,
			);
		const lowest = pick((a, b) => a.position.y > b.position.y);
		const leftmost = pick((a, b) => a.position.x < b.position.x);
		const rightmost = pick((a, b) => a.position.x > b.position.x);
		const position = below
			? lowest
				? { x: leftmost?.position.x ?? 0, y: lowest.position.y + 240 }
				: { x: 0, y: 0 }
			: rightmost
				? { x: rightmost.position.x + 280, y: rightmost.position.y }
				: { x: 0, y: 0 };
		add(position);
		const zoom = flow.getZoom();
		flow.setCenter(position.x + 100, position.y + 40, { zoom, duration: 200 });
	};
	const addAfterRightmost = (item: PaletteItem) =>
		placeNext(false, (position) => addPackageNode(item, position));
	const addBuiltin = (kind: BuiltinKind) =>
		placeNext(kind === "subflow_entry", (position) => addBuiltinNode(kind, position));

	const onDrop = (event: React.DragEvent) => {
		const raw = event.dataTransfer.getData(PALETTE_MIME);
		const builtin = event.dataTransfer.getData(BUILTIN_MIME) as BuiltinKind | "";
		if (!raw && !builtin) return;
		event.preventDefault();
		const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
		const at = { x: position.x - 100, y: position.y - 20 };
		if (builtin) addBuiltinNode(builtin, at);
		else addPackageNode(JSON.parse(raw) as PaletteItem, at);
	};

	/** 把节点包锁定（升级）到某个版本；同一个包的所有节点一起切换。 */
	const lockPackage = (name: string, version: string) =>
		setMeta((m) => ({ ...m, packages: { ...m.packages, [name]: version } }));

	const updateNode = (id: string, node: DocNode) =>
		setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { node } } : n)));

	/** 选中并定位到某个节点（触发预检里的「前往」）。 */
	const locateNode = (id: string) => {
		const target = flow.getNode(id);
		setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
		if (target) {
			flow.setCenter(target.position.x + 104, target.position.y + 64, {
				zoom: Math.max(flow.getZoom(), 1),
				duration: 200,
			});
		}
	};

	const selected = nodes.filter((n) => n.selected);
	const only = selected.length === 1 ? selected[0] : undefined;

	return (
		<CanvasContext.Provider value={canvasInfo}>
			<div className="sf-editor flex h-[calc(100vh-var(--topbar-height))] flex-col">
				<header className="sf-topbar">
					<h1>{orchestration.name}</h1>
					<span className={`sf-tag ${warnings.length > 0 ? "sf-tag--warn" : ""}`}>
						<i />
						{warnings.length > 0 ? `${warnings.length} 条警告` : "检查通过"}
					</span>
					<div className="ml-auto flex items-center gap-3">
						<PresenceIndicator orchestrationId={orchestration.id} />
						<VersionControls
							orchestration={orchestration}
							doc={doc}
							versioning={versioning}
							onReload={onReload}
						/>
						<Link
							to="/orchestrations/$id/runs"
							params={{ id: orchestration.id }}
							className="sf-link text-xs"
						>
							运行记录
						</Link>
						<button
							type="button"
							className={`sf-btn ${versioning.dirty || versioning.base.version === 0 ? "sf-btn--ghost" : "sf-btn--primary"}`}
							onClick={() => setTriggering(true)}
						>
							触发运行
						</button>
					</div>
					{triggering && (
						<TriggerDialog
							orchestrationId={orchestration.id}
							dirty={versioning.dirty || hasDraft(orchestration.id)}
							baseVersion={versioning.base.version}
							onLocate={locateNode}
							onClose={() => setTriggering(false)}
						/>
					)}
				</header>
				<StaleDraftBanner
					orchestration={orchestration}
					doc={doc}
					versioning={versioning}
					onReload={onReload}
				/>
				<div className="flex min-h-0 flex-1">
					<aside className="sf-panel w-60 shrink-0 overflow-y-auto border-r">
						<h2 className="sf-panel-title">内置节点</h2>
						<BuiltinPalette onAdd={addBuiltin} />
						<h2 className="sf-panel-title">节点类型</h2>
						<NodePalette
							packages={packages.data?.packages}
							agents={agentList}
							locked={meta.packages}
							onAdd={addAfterRightmost}
						/>
					</aside>
					<div className="sf-canvas relative min-w-0 flex-1">
						<ReactFlow<SfNode, SfEdge>
							nodes={nodes}
							edges={edges}
							nodeTypes={nodeTypes}
							edgeTypes={edgeTypes}
							onNodesChange={onNodesChange}
							onEdgesChange={onEdgesChange}
							onConnect={onConnect}
							onConnectEnd={onConnectEnd}
							isValidConnection={isValidConnection}
							onDragOver={(e) => {
								if (
									e.dataTransfer.types.includes(PALETTE_MIME) ||
									e.dataTransfer.types.includes(BUILTIN_MIME)
								) {
									e.preventDefault();
									e.dataTransfer.dropEffect = "copy";
								}
							}}
							onDrop={onDrop}
							fitView
							fitViewOptions={{ maxZoom: 1 }}
							minZoom={0.1}
							deleteKeyCode={["Backspace", "Delete"]}
						>
							<SubflowRegions />
							<Background gap={22} size={1.3} />
							<Controls />
							<MiniMap pannable zoomable />
						</ReactFlow>
						{notice && (
							<output className="sf-toast" aria-live="polite">
								<i />
								{notice}
								<button type="button" className="sf-link text-xs" onClick={() => setNotice(null)}>
									知道了
								</button>
							</output>
						)}
					</div>
					<aside className="sf-panel w-[392px] shrink-0 overflow-y-auto border-l">
						{only ? (
							<NodeInspector
								key={only.id}
								id={only.id}
								node={only.data.node}
								title={nodeTitle(only.data.node, canvasInfo)}
								doc={doc}
								catalog={catalog}
								packages={packages.data?.packages}
								onLock={lockPackage}
								onLocate={locateNode}
								defaultAgent={meta.default_agent}
								agents={agentList}
								warnings={warningsByNode.get(only.id) ?? []}
								onChange={(node) => updateNode(only.id, node)}
								onDelete={
									only.deletable === false
										? undefined
										: () => flow.deleteElements({ nodes: [{ id: only.id }] })
								}
							/>
						) : (
							<>
								<Section title="编排">
									<div>
										<span className="sf-label mb-1 block">默认 Agent</span>
										<AgentSelect
											label="默认 Agent"
											value={meta.default_agent}
											agents={agentList}
											emptyLabel="（未设置）"
											onChange={(agent) => setMeta((m) => ({ ...m, default_agent: agent }))}
										/>
									</div>
									<p className="sf-hint">
										未单独选择 Agent 的包节点都派发到默认 Agent。选中节点可以为它另选 Agent。
									</p>
								</Section>
								<Section title="节点包版本">
									<PackageVersions
										doc={doc}
										packages={packages.data?.packages}
										agents={agentList}
										onLock={lockPackage}
									/>
								</Section>
								<Section title="检查" aside={`${warnings.length} 条警告`}>
									<WarningList warnings={warnings} />
									<p className="sf-hint">警告不阻止保存；触发运行时必须全部通过。</p>
								</Section>
							</>
						)}
					</aside>
				</div>
			</div>
		</CanvasContext.Provider>
	);
}
