import { ensureLayout } from "@sfly/orchestration";
import type { OrchestrationDocument, OrchestrationNode } from "@sfly/schema";
import type { Edge, Node } from "@xyflow/react";

/** 画布节点上携带的编排节点（不含布局，布局在 React Flow 节点的 position 上）。 */
export type DocNode = OrchestrationNode extends infer N
	? N extends OrchestrationNode
		? Omit<N, "position">
		: never
	: never;
export type DocEdge = OrchestrationDocument["edges"][number];
export type EdgeKind = DocEdge["kind"];

export type SfNode = Node<{ node: DocNode }, DocNode["kind"]>;
export type SfEdge = Edge<{ kind: EdgeKind }>;

/** 文档中编排级（非节点、非连线）的部分。 */
export type DocMeta = Pick<OrchestrationDocument, "default_agent" | "packages">;

export const edgeId = (edge: DocEdge) => `${edge.kind}:${edge.from}->${edge.to}`;

export function toFlowEdge(edge: DocEdge): SfEdge {
	return {
		id: edgeId(edge),
		source: edge.from,
		target: edge.to,
		sourceHandle: edge.kind,
		targetHandle: edge.kind,
		type: "sf",
		data: { kind: edge.kind },
	};
}

/**
 * 编排文档 → 画布。缺少布局的文档（例如通过 API 创建）用整理布局算法得到初始布局
 * （@sfly/orchestration 的 ensureLayout，与画布的「整理布局」、新建场景相同）。
 */
export function toFlow(doc: OrchestrationDocument): { nodes: SfNode[]; edges: SfEdge[] } {
	const nodes = ensureLayout(doc).nodes.map((n): SfNode => {
		const { position, ...node } = n;
		return {
			id: n.id,
			type: n.kind,
			position: position ?? { x: 0, y: 0 },
			data: { node },
			// 入口节点是主链的唯一起点，不能删除。
			deletable: n.kind !== "entry",
		};
	});
	return { nodes, edges: doc.edges.map(toFlowEdge) };
}

/** 画布 → 编排文档。布局是版本内容的一部分；只保留仍被包节点使用的包版本锁定。 */
export function fromFlow(nodes: SfNode[], edges: SfEdge[], meta: DocMeta): OrchestrationDocument {
	const docNodes = nodes.map(
		(n) =>
			({
				...n.data.node,
				position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
			}) as OrchestrationNode,
	);
	const used = new Set(docNodes.flatMap((n) => (n.kind === "package" ? [n.package] : [])));
	const packages = Object.fromEntries(
		Object.entries(meta.packages).filter(([name]) => used.has(name)),
	);
	return {
		...(meta.default_agent ? { default_agent: meta.default_agent } : {}),
		nodes: docNodes,
		edges: edges.map((e) => ({ from: e.source, to: e.target, kind: e.data?.kind ?? "chain" })),
		packages,
	};
}

/** 在已有节点 ID 中为新节点生成一个不重复的 ID。 */
export function uniqueNodeId(base: string, existing: Iterable<string>): string {
	const taken = new Set(existing);
	const stem = base.replace(/[^A-Za-z0-9_]/g, "_") || "node";
	for (let i = 1; ; i++) {
		const id = `${stem}_${i}`;
		if (!taken.has(id)) return id;
	}
}
