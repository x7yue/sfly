import { ensureLayout, type LayoutDocument, type Position } from "@sfly/orchestration";
import {
	isRemovedNodeKind,
	type RemovedNodeKind,
	type StoredNode,
	type StoredOrchestrationDocument,
} from "@sfly/schema";
import type { Edge, Node } from "@xyflow/react";

/**
 * 画布节点上携带的场景节点（不含布局，布局在 React Flow 节点的 position 上）。
 * 含已移除种类的节点（ADR 0028）：打开最新版本时历史版本里留着的节点也要画出来，删掉之后才能保存。
 */
export type DocNode = StoredNode extends infer N
	? N extends StoredNode
		? Omit<N, "position">
		: never
	: never;
/** 已移除种类的节点（ADR 0028）：画布上画出来，不能保存。 */
export type RemovedDocNode = Extract<DocNode, { kind: RemovedNodeKind }>;
export const isRemovedDocNode = (node: DocNode): node is RemovedDocNode =>
	isRemovedNodeKind(node.kind);
export type DocEdge = StoredOrchestrationDocument["edges"][number];
export type EdgeKind = DocEdge["kind"];

export type SfNode = Node<{ node: DocNode }, DocNode["kind"]>;
export type SfEdge = Edge<{ kind: EdgeKind }>;

/** 文档中场景级（非节点、非连线）的部分：默认 Agent、包版本锁定、注释框。 */
export type DocMeta = Pick<
	StoredOrchestrationDocument,
	"default_agent" | "packages" | "annotations"
>;

export const edgeId = (edge: DocEdge) => `${edge.kind}:${edge.from}->${edge.to}`;

/** 画布连线 → 场景文档里的连线。 */
export const docEdgeOf = (edge: SfEdge): DocEdge => ({
	from: edge.source,
	to: edge.target,
	kind: edge.data?.kind ?? "chain",
});

export function toFlowEdge(edge: DocEdge): SfEdge {
	return {
		id: edgeId(edge),
		source: edge.from,
		target: edge.to,
		sourceHandle: edge.kind,
		targetHandle: edge.kind,
		type: "sf",
		data: { kind: edge.kind },
		// 不给时 React Flow 用英文的「Edge from A to B」。
		ariaLabel: `${edge.kind === "dispatch" ? "调度连线" : "连线"}：从 ${edge.from} 到 ${edge.to}`,
	};
}

/**
 * 场景文档 → 画布。缺少布局的文档（例如通过 API 创建）用整理布局算法得到初始布局
 * （@sfly/orchestration 的 ensureLayout，与画布的「整理布局」、新建场景相同）。
 */
export function toFlow(doc: StoredOrchestrationDocument): { nodes: SfNode[]; edges: SfEdge[] } {
	const nodes = ensureLayout(doc).nodes.map((n): SfNode => {
		const { position, ...node } = n;
		return toFlowNode(node, position ?? { x: 0, y: 0 });
	});
	return { nodes, edges: doc.edges.map(toFlowEdge) };
}

/** 新放到画布上的节点。入口节点是主链的唯一起点，不能删除。 */
export const toFlowNode = (node: DocNode, position: Position): SfNode => ({
	id: node.id,
	type: node.kind,
	position,
	data: { node },
	deletable: node.kind !== "entry",
});

/**
 * 把文档操作（@sfly/orchestration 的 insertAfter、removeNode……）的结果写回画布：只看节点的增删、位置和连线，
 * 没变的节点和连线沿用原来的对象（React Flow 量好的尺寸等内部状态留着）。`doc` 由 fromFlow 的结果算出。
 */
export function applyDocument(
	nodes: SfNode[],
	edges: SfEdge[],
	doc: Pick<StoredOrchestrationDocument, "nodes" | "edges">,
): { nodes: SfNode[]; edges: SfEdge[] } {
	const shown = new Map(nodes.map((n) => [n.id, n]));
	const drawn = new Map(edges.map((e) => [e.id, e]));
	return {
		nodes: doc.nodes.map((n) => {
			const { position = { x: 0, y: 0 }, ...node } = n;
			const old = shown.get(n.id);
			if (!old) return toFlowNode(node, position);
			const moved =
				Math.round(old.position.x) !== position.x || Math.round(old.position.y) !== position.y;
			return moved ? { ...old, position } : old;
		}),
		edges: doc.edges.map((e) => drawn.get(edgeId(e)) ?? toFlowEdge(e)),
	};
}

/** 画布 → 场景文档。布局是版本内容的一部分；只保留仍被包节点使用的包版本锁定。 */
export function fromFlow(
	nodes: SfNode[],
	edges: SfEdge[],
	meta: DocMeta,
): StoredOrchestrationDocument {
	const docNodes = nodes.map(
		(n) =>
			({
				...n.data.node,
				position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
			}) as StoredNode,
	);
	const used = new Set(docNodes.flatMap((n) => (n.kind === "package" ? [n.package] : [])));
	const packages = Object.fromEntries(
		Object.entries(meta.packages).filter(([name]) => used.has(name)),
	);
	return {
		...(meta.default_agent ? { default_agent: meta.default_agent } : {}),
		nodes: docNodes,
		edges: edges.map(docEdgeOf),
		packages,
		annotations: meta.annotations,
	};
}

/**
 * 画布上的节点和连线，只留结构、位置和 React Flow 量出来的卡片高度（@sfly/orchestration 算子流程区域、注释框范围，
 * 跟随执行框镜头用）：运行状态下卡片按内容长高，区域和镜头都要把长出来的部分框进去。还没量到时按卡片的原高度算。
 */
export const layoutOf = (nodes: readonly SfNode[], edges: readonly SfEdge[]): LayoutDocument => ({
	nodes: nodes.map((n) => ({
		id: n.id,
		kind: n.data.node.kind,
		position: n.position,
		height: n.measured?.height,
	})),
	edges: edges.map(docEdgeOf),
});
