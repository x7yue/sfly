import { type LayoutDocument, NODE_SIZE, type Position, REGION_PADDING } from "./layout.js";
import { chainMembers } from "./structure.js";

/**
 * 画布上画出来的范围：子流程区域和注释框（GLOSSARY「注释框」，ADR 0023）。两者用同一套算法：
 * 框住的东西的外接框，四周按 REGION_PADDING 留白（上方留出标题行）。注释框不存坐标，范围全由成员算出：
 * 节点成员取它的卡片，子流程成员取它的区域（不含它下级的子流程）。
 */

/** 画布坐标里的矩形：左上角和宽高。 */
export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface SubflowRegion {
	/** 子流程入口的节点 ID。 */
	entry: string;
	/** 子流程链上的节点（子流程入口在最前，按链上顺序；不含它下级的子流程）。 */
	members: string[];
	box: Box;
}

/** 注释框的成员（场景文档 `annotations` 里的一项，只读取画框要用的部分）。 */
export interface AnnotationMembers {
	readonly id: string;
	/** 成员节点的节点 ID。 */
	readonly nodes: readonly string[];
	/** 成员子流程：子流程入口的节点 ID。 */
	readonly subflows: readonly string[];
}

/** 带注释框的文档。 */
export interface AnnotatedDocument<A extends AnnotationMembers = AnnotationMembers> {
	readonly annotations?: readonly A[] | undefined;
}

export interface AnnotationBox<A extends AnnotationMembers = AnnotationMembers> {
	annotation: A;
	/** 框住的节点：成员节点和成员子流程链上的全部节点，按节点在文档里的顺序。 */
	members: string[];
	box: Box;
}

const cardAt = (p: Position): Box => ({ x: p.x, y: p.y, w: NODE_SIZE.width, h: NODE_SIZE.height });

function paddedBounds(rects: readonly Box[]): Box {
	const x = Math.min(...rects.map((r) => r.x)) - REGION_PADDING.left;
	const y = Math.min(...rects.map((r) => r.y)) - REGION_PADDING.top;
	const x1 = Math.max(...rects.map((r) => r.x + r.w)) + REGION_PADDING.right;
	const y1 = Math.max(...rects.map((r) => r.y + r.h)) + REGION_PADDING.bottom;
	return { x, y, w: x1 - x, h: y1 - y };
}

const positionsOf = (doc: LayoutDocument) =>
	new Map(doc.nodes.flatMap((n) => (n.position ? [[n.id, n.position] as const] : [])));

/** 每个子流程（子流程入口节点及它链上的节点）的区域，按子流程入口在文档里的顺序；没有位置的节点不算。 */
export function subflowRegions(doc: LayoutDocument): SubflowRegion[] {
	const positions = positionsOf(doc);
	const kindOf = new Map(doc.nodes.map((n) => [n.id, n.kind]));
	const regions: SubflowRegion[] = [];
	for (const [entry, members] of chainMembers(doc)) {
		if (kindOf.get(entry) !== "subflow_entry") continue;
		const cards = members.flatMap((id) => {
			const p = positions.get(id);
			return p ? [cardAt(p)] : [];
		});
		if (cards.length > 0) regions.push({ entry, members, box: paddedBounds(cards) });
	}
	return regions;
}

/**
 * 注释框的范围，按 `annotations` 里的顺序（后面的画在上层）。成员里不存在的节点和子流程跳过，
 * 一个有效成员都没有的注释框不在结果里（不画）。
 */
export function annotationBoxes<A extends AnnotationMembers>(
	doc: LayoutDocument & AnnotatedDocument<A>,
): AnnotationBox<A>[] {
	const positions = positionsOf(doc);
	const regions = new Map(subflowRegions(doc).map((r) => [r.entry, r]));
	return (doc.annotations ?? []).flatMap((annotation) => {
		const nodes = annotation.nodes.flatMap((id) => {
			const p = positions.get(id);
			return p ? [{ id, card: cardAt(p) }] : [];
		});
		const subflows = annotation.subflows.flatMap((id) => regions.get(id) ?? []);
		const rects = [...nodes.map((n) => n.card), ...subflows.map((r) => r.box)];
		if (rects.length === 0) return [];
		const framed = new Set([...nodes.map((n) => n.id), ...subflows.flatMap((r) => r.members)]);
		return [
			{
				annotation,
				members: doc.nodes.flatMap((n) => (framed.has(n.id) ? [n.id] : [])),
				box: paddedBounds(rects),
			},
		];
	});
}

/**
 * 删掉节点之后的注释框：删掉的节点从所有注释框的 `nodes` 里去掉，删掉的子流程入口从 `subflows` 里去掉；
 * 因此变得没有成员的注释框一起删掉（本来就没有成员的不动）。没有变化时返回原来的数组。
 */
export function withoutRemovedMembers<A extends AnnotationMembers>(
	annotations: readonly A[],
	removed: readonly string[],
): readonly A[] {
	const gone = new Set(removed);
	let changed = false;
	const next = annotations.flatMap((a): A[] => {
		const nodes = a.nodes.filter((id) => !gone.has(id));
		const subflows = a.subflows.filter((id) => !gone.has(id));
		if (nodes.length === a.nodes.length && subflows.length === a.subflows.length) return [a];
		changed = true;
		return nodes.length + subflows.length === 0 ? [] : [{ ...a, nodes, subflows }];
	});
	return changed ? next : annotations;
}
