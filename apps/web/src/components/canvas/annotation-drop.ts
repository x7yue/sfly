import {
	annotationBoxes,
	type Box,
	type LayoutDocument,
	NODE_SIZE,
	type Position,
} from "@sfly/orchestration";
import type { Annotation } from "@sfly/schema";

/**
 * 拖动节点时和注释框的关系（单测见 annotation-drop.test.ts）：
 * - 松手时抓着的那张卡片的中心落在哪个注释框里（几个框叠着时取最里面、面积最小的那个），拖动的节点里还不在这个框里的
 *   加入它。在节点本来就在的框里挪动不算加入；普通拖动只会加入，不会离开原来的框（框跟着成员走）。
 * - 按住 Alt 拖动是「拖出」：拖动的节点不再算原来那些注释框的直接成员（节点成员，或者子流程成员的入口），
 *   框不跟着走，松手时从这些框里移出；移出后没有成员的注释框一起删除，和移出最后一个成员一样。
 *   按住 Alt 拖回原来的框里就留在里面。
 */
export interface AnnotationDrop {
	/** 拖动的节点（React Flow 一起拖动的那组）。 */
	dragged: readonly string[];
	/** 松手时加入的注释框，和要加进去的节点（拖动的节点里还不在框里的那些）。 */
	join: { id: string; title: string; nodes: readonly string[] } | null;
	/** 按住 Alt 拖出的注释框；`emptied`：移出后它没有成员了，会一起删除。 */
	leave: readonly { id: string; title: string; emptied: boolean }[];
}

/** 拖动结束时没有什么要改。 */
export const hasDropEffect = (drop: AnnotationDrop): boolean =>
	drop.join !== null || drop.leave.length > 0;

const isMember = (annotation: Annotation, id: string) =>
	annotation.nodes.includes(id) || annotation.subflows.includes(id);

/** 按住 Alt 拖动时画框用的注释框：拖动的节点不再是它们的直接成员，框不跟着节点走（没有变化的原样返回）。 */
export function detachedAnnotations(
	annotations: readonly Annotation[],
	dragged: readonly string[],
): readonly Annotation[] {
	const gone = new Set(dragged);
	return annotations.map((a) =>
		a.nodes.some((id) => gone.has(id)) || a.subflows.some((id) => gone.has(id))
			? {
					...a,
					nodes: a.nodes.filter((id) => !gone.has(id)),
					subflows: a.subflows.filter((id) => !gone.has(id)),
				}
			: a,
	);
}

/** 点在矩形里（含边上）。 */
export const boxContains = (box: Box, p: Position) =>
	p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;

/** 卡片中心（画布坐标）。 */
export const cardCenter = (position: Position): Position => ({
	x: position.x + NODE_SIZE.width / 2,
	y: position.y + NODE_SIZE.height / 2,
});

/**
 * 这次拖动松手时会怎样。`layout` 是画布上现在的节点（拖动中的节点在新位置），`center` 是抓着的那张卡片的中心。
 *
 * 落在哪个框里按不含拖动节点的框算：拖动的节点会带着自己的框走，用画出来的框就总是落在自己的框里。
 * 只有一种框按画出来的样子算：普通拖动时节点原来所在、还有别的成员没被拖动的框，在它里面挪动不算拖进别的框。
 * 几个框都包含中心时取面积最小的，一样大取后添加的（画在上层的）。
 */
export function annotationDrop({
	annotations,
	layout,
	dragged,
	center,
	detach,
}: {
	annotations: readonly Annotation[];
	layout: LayoutDocument;
	dragged: readonly string[];
	center: Position;
	detach: boolean;
}): AnnotationDrop {
	const drawn = annotationBoxes({ ...layout, annotations });
	const stationary = new Map(
		annotationBoxes({ ...layout, annotations: detachedAnnotations(annotations, dragged) }).map(
			(b) => [b.annotation.id, b.box],
		),
	);
	const framed = new Map(drawn.map((b) => [b.annotation.id, new Set(b.members)]));
	const candidates = annotations.flatMap((a) => {
		const still = stationary.get(a.id);
		if (!still) return [];
		const own = !detach && dragged.some((id) => isMember(a, id));
		const box = own ? (drawn.find((b) => b.annotation.id === a.id)?.box ?? still) : still;
		return boxContains(box, center) ? [{ annotation: a, box }] : [];
	});
	const target = candidates.reduce<(typeof candidates)[number] | null>(
		(best, c) => (best && best.box.w * best.box.h < c.box.w * c.box.h ? best : c),
		null,
	);
	const inTarget = target ? framed.get(target.annotation.id) : undefined;
	const joining = target ? dragged.filter((id) => !inTarget?.has(id)) : [];
	const leave = detach
		? annotations.flatMap((a) => {
				if (a.id === target?.annotation.id || !dragged.some((id) => isMember(a, id))) return [];
				const left = [...a.nodes, ...a.subflows].filter((id) => !dragged.includes(id));
				return [{ id: a.id, title: a.title, emptied: left.length === 0 }];
			})
		: [];
	return {
		dragged,
		join:
			target && joining.length > 0
				? { id: target.annotation.id, title: target.annotation.title, nodes: joining }
				: null,
		leave,
	};
}

/** 拖动时卡片下面的提示：松手会加入、移出哪个注释框；没有影响时为 null。 */
export function dropHint(drop: AnnotationDrop): string | null {
	const quote = (title: string) => `「${title}」`;
	const leaving = drop.leave.map((l) => quote(l.title)).join("");
	const emptied = drop.leave.filter((l) => l.emptied).map((l) => quote(l.title));
	const parts = [
		...(leaving ? [`移出${leaving}`] : []),
		...(drop.join ? [`加入${quote(drop.join.title)}`] : []),
	];
	if (parts.length === 0) return null;
	const tail = emptied.length > 0 ? `；${emptied.join("")}没有别的成员，会一起删除` : "";
	return `松手${parts.join("，")}${tail}`;
}
