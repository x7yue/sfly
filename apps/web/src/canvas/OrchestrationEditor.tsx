import { checkConnection, type StructureWarning, structureWarnings } from "@sfly/orchestration";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
	listAgents,
	listPackages,
	type Orchestration,
	type OrchestrationHead,
	type SavedVersion,
	saveVersion,
} from "#/lib/api";
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
import { NodePalette, PALETTE_MIME, type PaletteItem } from "./NodePalette";
import { PresenceIndicator } from "./PresenceIndicator";

export function OrchestrationEditor(props: {
	orchestration: Orchestration;
	head: OrchestrationHead;
}) {
	return (
		<ReactFlowProvider>
			<Editor {...props} />
		</ReactFlowProvider>
	);
}

const edgeKindOf = (c: Connection | Edge): EdgeKind =>
	c.sourceHandle === "dispatch" ? "dispatch" : "chain";

function Editor({
	orchestration,
	head,
}: {
	orchestration: Orchestration;
	head: OrchestrationHead;
}) {
	const queryClient = useQueryClient();
	const flow = useReactFlow<SfNode, SfEdge>();

	const initial = useMemo(() => toFlow(head.document), [head.document]);
	const [nodes, setNodes, onNodesChange] = useNodesState<SfNode>(initial.nodes);
	const [edges, setEdges, onEdgesChange] = useEdgesState<SfEdge>(initial.edges);
	const [meta, setMeta] = useState<DocMeta>({
		default_agent: head.document.default_agent,
		packages: head.document.packages,
	});
	const [version, setVersion] = useState({ number: head.number, author: head.author });
	const [notice, setNotice] = useState<string | null>(null);
	const [savedWarnings, setSavedWarnings] = useState<StructureWarning[] | null>(null);

	const packages = useQuery({ queryKey: ["packages"], queryFn: listPackages });
	const agents = useQuery({
		queryKey: ["agents"],
		queryFn: listAgents,
		refetchInterval: 10_000,
	});
	const agentList = agents.data?.agents ?? [];

	const doc = useMemo(() => fromFlow(nodes, edges, meta), [nodes, edges, meta]);
	const warnings = useMemo(() => structureWarnings(doc), [doc]);
	const warningsByNode = useMemo(() => {
		const map = new Map<string, StructureWarning[]>();
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

	/** 点击添加：放在最右侧节点的右边（链自然延伸的方向），并把视口移过去。 */
	const addAfterRightmost = (item: PaletteItem) => {
		const rightmost = nodes.reduce<SfNode | undefined>(
			(best, n) => (!best || n.position.x > best.position.x ? n : best),
			undefined,
		);
		const position = rightmost
			? { x: rightmost.position.x + 280, y: rightmost.position.y }
			: { x: 0, y: 0 };
		addPackageNode(item, position);
		const zoom = flow.getZoom();
		flow.setCenter(position.x + 100, position.y + 40, { zoom, duration: 200 });
	};

	const onDrop = (event: React.DragEvent) => {
		const raw = event.dataTransfer.getData(PALETTE_MIME);
		if (!raw) return;
		event.preventDefault();
		const item = JSON.parse(raw) as PaletteItem;
		const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
		addPackageNode(item, { x: position.x - 100, y: position.y - 20 });
	};

	const updateNode = (id: string, node: DocNode) =>
		setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { node } } : n)));

	// —— 保存：生成新的编排版本；结构警告不阻止保存 ——
	const save = useMutation({
		mutationFn: () => saveVersion(orchestration.id, doc),
		onSuccess: (saved: SavedVersion) => {
			setVersion({ number: saved.number, author: saved.author });
			setSavedWarnings(saved.warnings);
			setNotice(null);
			queryClient.invalidateQueries({ queryKey: ["orchestrations"] });
			queryClient.setQueryData(["orchestration", orchestration.id, "head"], {
				orchestration_id: orchestration.id,
				number: saved.number,
				author: saved.author,
				created_at: saved.created_at,
				document: saved.document,
			});
		},
	});

	const selected = nodes.filter((n) => n.selected);
	const only = selected.length === 1 ? selected[0] : undefined;

	return (
		<CanvasContext.Provider value={canvasInfo}>
			<div className="flex h-[calc(100vh-49px)] flex-col">
				<header className="flex items-center gap-3 border-b border-[var(--sf-border)] bg-white px-4 py-2">
					<h1 className="text-base font-semibold">{orchestration.name}</h1>
					<span className="text-sm text-[var(--sf-text-muted)]">
						{version.number === 0
							? "还没有保存过版本"
							: `版本 ${version.number}${version.author ? ` · ${version.author}` : ""}`}
					</span>
					<span
						className={`text-sm ${warnings.length > 0 ? "text-[var(--sf-warning)]" : "text-[var(--sf-success)]"}`}
					>
						{warnings.length > 0 ? `${warnings.length} 条结构警告` : "结构检查通过"}
					</span>
					<div className="ml-auto flex items-center gap-3">
						<PresenceIndicator orchestrationId={orchestration.id} />
						{save.isSuccess && savedWarnings && (
							<span className="text-sm text-[var(--sf-text-muted)]">
								已保存为版本 {version.number}
								{savedWarnings.length > 0 ? `（${savedWarnings.length} 条警告）` : ""}
							</span>
						)}
						{save.error && (
							<span className="text-sm text-[var(--sf-danger)]">
								保存失败：{save.error.message}
							</span>
						)}
						<button
							type="button"
							onClick={() => save.mutate()}
							disabled={save.isPending}
							className="rounded bg-[var(--sf-accent)] px-3 py-1 text-sm font-medium text-white disabled:opacity-60"
						>
							{save.isPending ? "保存中…" : "保存"}
						</button>
					</div>
				</header>
				<div className="flex min-h-0 flex-1">
					<aside className="w-60 shrink-0 overflow-y-auto border-r border-[var(--sf-border)] bg-[var(--sf-surface-muted)]">
						<h2 className="px-3 pt-3 text-xs font-semibold tracking-wide text-[var(--sf-text-muted)] uppercase">
							节点类型
						</h2>
						<NodePalette
							packages={packages.data?.packages}
							locked={meta.packages}
							onAdd={addAfterRightmost}
						/>
					</aside>
					<div className="sf-canvas relative min-w-0 flex-1">
						<ReactFlow<SfNode, SfEdge>
							nodes={nodes}
							edges={edges}
							nodeTypes={nodeTypes}
							onNodesChange={onNodesChange}
							onEdgesChange={onEdgesChange}
							onConnect={onConnect}
							onConnectEnd={onConnectEnd}
							isValidConnection={isValidConnection}
							onDragOver={(e) => {
								if (e.dataTransfer.types.includes(PALETTE_MIME)) {
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
							<Background gap={16} />
							<Controls />
							<MiniMap pannable zoomable />
						</ReactFlow>
						{notice && (
							<div className="absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded bg-[var(--sf-warning-soft)] px-3 py-1 text-sm text-[var(--sf-warning)] shadow">
								{notice}
								<button
									type="button"
									className="ml-2 text-xs underline"
									onClick={() => setNotice(null)}
								>
									知道了
								</button>
							</div>
						)}
					</div>
					<aside className="w-80 shrink-0 overflow-y-auto border-l border-[var(--sf-border)] bg-white">
						{only ? (
							<NodeInspector
								key={only.id}
								id={only.id}
								node={only.data.node}
								title={nodeTitle(only.data.node, canvasInfo)}
								version={
									only.data.node.kind === "package"
										? meta.packages[only.data.node.package]
										: undefined
								}
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
									<div className="text-sm">
										<span className="mb-1 block text-[var(--sf-text-muted)]">默认 Agent</span>
										<AgentSelect
											label="默认 Agent"
											value={meta.default_agent}
											agents={agentList}
											emptyLabel="（未设置）"
											onChange={(agent) => setMeta((m) => ({ ...m, default_agent: agent }))}
										/>
									</div>
									<p className="mt-2 text-xs text-[var(--sf-text-muted)]">
										未单独选择 Agent 的包节点都派发到默认 Agent。选中节点可以为它另选 Agent。
									</p>
								</Section>
								<Section title="结构检查">
									<WarningList warnings={warnings} />
									<p className="mt-2 text-xs text-[var(--sf-text-muted)]">
										警告不阻止保存；触发运行时必须全部通过。
									</p>
								</Section>
							</>
						)}
					</aside>
				</div>
			</div>
		</CanvasContext.Provider>
	);
}
