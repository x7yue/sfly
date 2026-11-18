import type { AnnotationMemberIds } from "./annotation-members.js";
import {
	ANNOTATION_NOTE,
	ANNOTATION_PADDING,
	type LayoutDocument,
	NODE_SIZE,
	type Position,
	REGION_PADDING,
} from "./layout.js";
import { chainMembers, subflowTree } from "./structure.js";

/**
 * 画布上画出来的范围：子流程区域和注释框（GLOSSARY「注释框」，ADR 0023）。两者都是框住的东西的外接框加四周留白。
 * 子流程区域按 REGION_PADDING 留白（上方留出框里的标题行）；注释框的标题写在框外上方，框里四周按 ANNOTATION_PADDING
 * 留白，有备注时最上方再留出备注卡片（ANNOTATION_NOTE）。注释框不存坐标，范围全由成员算出：
 * 节点成员取它的卡片，子流程成员取它和它下级子流程的区域。
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

/** 注释框的成员加上它的 ID（场景文档 `annotations` 里的一项，只读取画框要用的部分）。 */
export interface AnnotationMembers extends AnnotationMemberIds {
	/** 备注：有备注（去掉首尾空白后不为空）时框里最上方留出备注卡片的位置（ANNOTATION_NOTE）。 */
	readonly note?: string | undefined;
	readonly id: string;
}

/** 带注释框的文档。 */
export interface AnnotatedDocument<A extends AnnotationMembers = AnnotationMembers> {
	readonly annotations?: readonly A[] | undefined;
}

export interface AnnotationBox<A extends AnnotationMembers = AnnotationMembers> {
	annotation: A;
	/** 框住的节点：成员节点，和成员子流程及其下级子流程链上的全部节点，按节点在文档里的顺序。 */
	members: string[];
	box: Box;
}

function paddedBounds(
	rects: readonly Box[],
	padding: { left: number; top: number; right: number; bottom: number } = REGION_PADDING,
): Box {
	const x = Math.min(...rects.map((r) => r.x)) - padding.left;
	const y = Math.min(...rects.map((r) => r.y)) - padding.top;
	const x1 = Math.max(...rects.map((r) => r.x + r.w)) + padding.right;
	const y1 = Math.max(...rects.map((r) => r.y + r.h)) + padding.bottom;
	return { x, y, w: x1 - x, h: y1 - y };
}

const cardAt = (p: Position, height: number = NODE_SIZE.height): Box => ({
	x: p.x,
	y: p.y,
	w: NODE_SIZE.width,
	h: height,
});

/** 有位置的节点的卡片：宽度固定，高度取布局里量出来的，没有时是 NODE_SIZE 的高度。 */
const cardsOf = (doc: LayoutDocument) =>
	new Map(
		doc.nodes.flatMap((n) => (n.position ? [[n.id, cardAt(n.position, n.height)] as const] : [])),
	);

/** 每个子流程（子流程入口节点及它链上的节点）的区域，按子流程入口在文档里的顺序；没有位置的节点不算。 */
export function subflowRegions(doc: LayoutDocument): SubflowRegion[] {
	const cardOf = cardsOf(doc);
	const kindOf = new Map(doc.nodes.map((n) => [n.id, n.kind]));
	const regions: SubflowRegion[] = [];
	for (const [entry, members] of chainMembers(doc)) {
		if (kindOf.get(entry) !== "subflow_entry") continue;
		const cards = members.flatMap((id) => cardOf.get(id) ?? []);
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
	const cardOf = cardsOf(doc);
	const regions = new Map(subflowRegions(doc).map((r) => [r.entry, r]));
	const chains = chainMembers(doc);
	return (doc.annotations ?? []).flatMap((annotation) => {
		const nodes = annotation.nodes.flatMap((id) => {
			const card = cardOf.get(id);
			return card ? [{ id, card }] : [];
		});
		// 子流程成员连同它下级的子流程；同一个子流程只算一次（上级和下级都写了的时候）。
		const entries = new Set(annotation.subflows.flatMap((id) => subflowTree(doc, id, chains)));
		const subflows = [...entries].flatMap((id) => regions.get(id) ?? []);
		const rects = [...nodes.map((n) => n.card), ...subflows.map((r) => r.box)];
		if (rects.length === 0) return [];
		const noted = annotation.note?.trim() ? ANNOTATION_NOTE.height + ANNOTATION_NOTE.gap : 0;
		const framed = new Set([...nodes.map((n) => n.id), ...subflows.flatMap((r) => r.members)]);
		return [
			{
				annotation,
				members: doc.nodes.flatMap((n) => (framed.has(n.id) ? [n.id] : [])),
				box: paddedBounds(rects, { ...ANNOTATION_PADDING, top: ANNOTATION_PADDING.top + noted }),
			},
		];
	});
}

/**
 * 框里的非成员节点：卡片中心落在框内、又不是这个注释框的成员，按节点在文档里的顺序。
 * 成员不挨在一起时框里会夹着别的节点，选中或悬停注释框时把它们变淡，人才看得清框的到底是哪些。
 */
export function nonMembersInside(
	doc: LayoutDocument,
	{ members, box }: Pick<AnnotationBox, "members" | "box">,
): string[] {
	const framed = new Set(members);
	return doc.nodes.flatMap(({ id, position, height }) => {
		if (!position || framed.has(id)) return [];
		const card = cardAt(position, height);
		const cx = card.x + card.w / 2;
		const cy = card.y + card.h / 2;
		const inside = cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
		return inside ? [id] : [];
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
