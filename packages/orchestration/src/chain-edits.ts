import { LAYOUT_COLUMN, type LayoutDocument, NODE_SIZE, type Position } from "./layout.js";
import { checkConnection } from "./structure.js";

/**
 * 画布上改动链的文档操作：插入到连线上、在节点后面添加、删除并接上前后、断开入线 / 出线、改接与断开连线。
 * 都是纯函数：输入文档和操作，输出新文档或拒绝原因，不改动传入的文档；连线规则沿用 checkConnection。
 * 画布只负责把手势变成操作，再把结果写回去（一次操作一步撤销）。
 */

type EditEdge = LayoutDocument["edges"][number];

/** 文档操作的结果：新文档，或拒绝原因。 */
export type DocumentEdit<D> = { ok: true; doc: D } | { ok: false; reason: string };

const rejected = (reason: string) => ({ ok: false, reason }) as const;
const isChain = (edge: EditEdge, from: string, to: string) =>
	edge.kind === "chain" && edge.from === from && edge.to === to;

/**
 * 在 afterId 后面插入节点时的位置：新节点放在它右侧一列。这个位置被同一行后面的节点压住时，
 * 同一行里排在 afterId 右边的节点整体后移，刚好让出一列（`moved`：节点 ID → 新位置）；空着时不挪动。
 * 「同一行」指与 afterId 上下有重叠的节点，别的行（折返的第二行、子流程）不动。
 */
export function insertPlacement(
	doc: LayoutDocument,
	afterId: string,
): { position: Position; moved: Map<string, Position> } {
	const origin = doc.nodes.find((n) => n.id === afterId)?.position ?? { x: 0, y: 0 };
	const position = { x: origin.x + LAYOUT_COLUMN, y: origin.y };
	const later = doc.nodes.flatMap((n) =>
		n.id !== afterId &&
		n.position &&
		Math.abs(n.position.y - origin.y) < NODE_SIZE.height &&
		n.position.x > origin.x
			? [{ id: n.id, position: n.position }]
			: [],
	);
	const first = Math.min(...later.map((n) => n.position.x));
	const shift = position.x + LAYOUT_COLUMN - first;
	// 最靠前的那个离新节点不到一列：全部后移同样的距离。
	const moved = new Map<string, Position>();
	if (later.length > 0 && shift > 0) {
		for (const n of later) moved.set(n.id, { x: n.position.x + shift, y: n.position.y });
	}
	return { position, moved };
}

/** 把新节点加进文档：没带位置时按 insertPlacement 放在 afterId 后面，`makeRoom` 时后面的节点让出位置。 */
function withNode<D extends LayoutDocument>(
	doc: D,
	afterId: string,
	node: D["nodes"][number],
	makeRoom: boolean,
): D["nodes"][number][] {
	if (node.position) return [...doc.nodes, node];
	const { position, moved } = insertPlacement(doc, afterId);
	const nodes = makeRoom
		? doc.nodes.map((n) => (moved.has(n.id) ? { ...n, position: moved.get(n.id) } : n))
		: [...doc.nodes];
	return [...nodes, { ...node, position }];
}

/**
 * 把新节点插到一条链上的连线中间：原来的连线换成「起点 → 新节点」「新节点 → 终点」两条。
 * 新节点带位置时就用它；没带时放在起点右侧一列，同一行后面的节点后移让出位置（insertPlacement）。
 * 连线不存在（或是调度连线）、节点 ID 重复、新节点不能接在链上（例如子流程入口）时拒绝。
 */
export function insertOnEdge<D extends LayoutDocument>(
	doc: D,
	edge: { from: string; to: string },
	node: D["nodes"][number],
): DocumentEdit<D> {
	const index = doc.edges.findIndex((e) => isChain(e, edge.from, edge.to));
	if (index < 0) return rejected(`连线 ${edge.from} → ${edge.to} 不存在`);
	if (doc.nodes.some((n) => n.id === node.id)) return rejected(`节点 ID ${node.id} 已存在`);
	const nodes = withNode(doc, edge.from, node, true);
	const head: EditEdge = { from: edge.from, to: node.id, kind: "chain" };
	const tail: EditEdge = { from: node.id, to: edge.to, kind: "chain" };
	const rest = doc.edges.filter((_, i) => i !== index);
	const problem =
		checkConnection({ ...doc, nodes, edges: rest }, head) ??
		checkConnection({ ...doc, nodes, edges: [...rest, head] }, tail);
	if (problem) return rejected(problem);
	const edges = [...doc.edges.slice(0, index), head, tail, ...doc.edges.slice(index + 1)];
	return { ok: true, doc: { ...doc, nodes, edges } };
}

/**
 * 在节点后面添加：它没有链上的出线（链尾、游离节点）时追加，新节点没带位置就放在右侧一列；
 * 有出线时插在它和下一个节点之间（insertOnEdge）。
 */
export function insertAfter<D extends LayoutDocument>(
	doc: D,
	afterId: string,
	node: D["nodes"][number],
): DocumentEdit<D> {
	if (!doc.nodes.some((n) => n.id === afterId)) return rejected(`节点 ${afterId} 不存在`);
	const next = doc.edges.filter((e) => e.kind === "chain" && e.from === afterId);
	if (next.length > 1) return rejected(`节点 ${afterId} 有多条出线，链不能分叉`);
	const [following] = next;
	if (following) return insertOnEdge(doc, following, node);
	if (doc.nodes.some((n) => n.id === node.id)) return rejected(`节点 ID ${node.id} 已存在`);
	const nodes = withNode(doc, afterId, node, false);
	const edge: EditEdge = { from: afterId, to: node.id, kind: "chain" };
	const problem = checkConnection({ ...doc, nodes }, edge);
	if (problem) return rejected(problem);
	return { ok: true, doc: { ...doc, nodes, edges: [...doc.edges, edge] } };
}

/**
 * 删除节点，连同它的全部连线（链上的和调度连线）。它恰好有一条链上入线和一条链上出线时，
 * 前后两个节点自动接上（连线规则不允许时不接）。入口节点不能删除。
 */
export function removeNode<D extends LayoutDocument>(doc: D, id: string): DocumentEdit<D> {
	const node = doc.nodes.find((n) => n.id === id);
	if (!node) return rejected(`节点 ${id} 不存在`);
	if (node.kind === "entry") return rejected("入口节点不能删除");
	const before = doc.edges.filter((e) => e.kind === "chain" && e.to === id);
	const after = doc.edges.filter((e) => e.kind === "chain" && e.from === id);
	const nodes = doc.nodes.filter((n) => n.id !== id);
	const kept = doc.edges.filter((e) => e.from !== id && e.to !== id);
	const [incoming] = before;
	const [outgoing] = after;
	let edges: EditEdge[] = kept;
	if (incoming && outgoing && before.length === 1 && after.length === 1) {
		const bridge: EditEdge = { from: incoming.from, to: outgoing.to, kind: "chain" };
		if (checkConnection({ ...doc, nodes, edges: kept }, bridge) === null) {
			// 接上的连线放在原来入线的位置，文档里连线的顺序不乱。
			edges = doc.edges.flatMap((e) =>
				e === incoming ? [bridge] : e.from === id || e.to === id ? [] : [e],
			);
		}
	}
	return { ok: true, doc: { ...doc, nodes, edges } };
}

/**
 * 节点的入线和出线（「断开入线」「断开出线」作用的连线）：入线是连到它的连线——链上的入线，
 * 子流程入口节点是触发它的调度连线；出线是从它连出的链上连线（异步任务节点的调度连线不算）。
 */
export function nodeConnections<D extends LayoutDocument>(
	doc: D,
	id: string,
): { in: D["edges"][number][]; out: D["edges"][number][] } {
	return {
		in: doc.edges.filter((e) => e.to === id),
		out: doc.edges.filter((e) => e.kind === "chain" && e.from === id),
	};
}

const sameEdge = (a: EditEdge, b: EditEdge) =>
	a.kind === b.kind && a.from === b.from && a.to === b.to;

/**
 * 改接连线（拖动连线的端点）：把一条连线（链上的或调度连线）的两端换成 `next`，连线种类不变。
 * 校验沿用 checkConnection，把原来的连线去掉之后再查：违反规则（分叉、汇合、成环……）时拒绝。
 * 新连线留在原来的位置，文档里连线的顺序不乱；两端都没变时原样返回。
 */
export function reconnectEdge<D extends LayoutDocument>(
	doc: D,
	edge: EditEdge,
	next: { from: string; to: string },
): DocumentEdit<D> {
	const index = doc.edges.findIndex((e) => sameEdge(e, edge));
	if (index < 0) return rejected(`连线 ${edge.from} → ${edge.to} 不存在`);
	if (next.from === edge.from && next.to === edge.to) return { ok: true, doc };
	const moved: EditEdge = { ...next, kind: edge.kind };
	const rest = doc.edges.filter((_, i) => i !== index);
	const problem = checkConnection({ ...doc, edges: rest }, moved);
	if (problem) return rejected(problem);
	return { ok: true, doc: { ...doc, edges: doc.edges.map((e, i) => (i === index ? moved : e)) } };
}

/** 断开一条连线（连线菜单「断开连线」）；没有这条连线时原样返回。 */
export function disconnectEdge<D extends LayoutDocument>(doc: D, edge: EditEdge): D {
	if (!doc.edges.some((e) => sameEdge(e, edge))) return doc;
	return { ...doc, edges: doc.edges.filter((e) => !sameEdge(e, edge)) };
}

/** 断开节点的入线或出线（nodeConnections）；没有对应连线时原样返回。 */
export function disconnectNode<D extends LayoutDocument>(
	doc: D,
	id: string,
	side: "in" | "out",
): D {
	const cut = new Set<EditEdge>(nodeConnections(doc, id)[side]);
	if (cut.size === 0) return doc;
	return { ...doc, edges: doc.edges.filter((e) => !cut.has(e)) };
}
