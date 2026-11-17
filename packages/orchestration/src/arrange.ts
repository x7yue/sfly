import { LAYOUT_COLUMN, NODE_SIZE, type Position } from "./layout.js";

/** 排列所选的方式：宫格、横向排成一行、纵向排成一列。 */
export type ArrangeMode = "grid" | "row" | "column";

/** 排列时相邻两张卡片左上角的距离：横向和整理布局一样一列宽，纵向在卡片之间留出一行连线的空。 */
export const ARRANGE_STEP = { x: LAYOUT_COLUMN, y: NODE_SIZE.height + 56 } as const;

/**
 * 按阅读顺序排列：先上后下，纵向错开不到半张卡片的算同一行，同一行从左到右。
 * 纵坐标相同时按横坐标，再按 ID，结果不受输入顺序影响。排列所选和画布的大纲都按它排。
 */
export function readingOrder<T extends { id: string; position: Position }>(
	nodes: readonly T[],
): T[] {
	const byY = [...nodes].sort(
		(a, b) => a.position.y - b.position.y || a.position.x - b.position.x || (a.id < b.id ? -1 : 1),
	);
	const rows: T[][] = [];
	for (const node of byY) {
		const row = rows.at(-1);
		const top = row?.[0];
		if (row && top && node.position.y - top.position.y < NODE_SIZE.height / 2) row.push(node);
		else rows.push([node]);
	}
	return rows.flatMap((row) => row.sort((a, b) => a.position.x - b.position.x));
}

/**
 * 排列所选（画布工具条上的宫格 / 横向 / 纵向排列）：按阅读顺序重新摆放这些节点，左上角留在原来那组的左上角。
 * 宫格的列数是节点数的平方根向上取整。结果按排好的顺序列出每个节点的新位置；只排给出的节点，不避让别的节点。
 */
export function arrangeNodes(
	nodes: readonly { id: string; position: Position }[],
	mode: ArrangeMode,
): Map<string, Position> {
	if (nodes.length === 0) return new Map();
	const x0 = Math.min(...nodes.map((n) => n.position.x));
	const y0 = Math.min(...nodes.map((n) => n.position.y));
	const columns =
		mode === "row" ? nodes.length : mode === "column" ? 1 : Math.ceil(Math.sqrt(nodes.length));
	return new Map(
		readingOrder(nodes).map((n, i) => [
			n.id,
			{ x: x0 + (i % columns) * ARRANGE_STEP.x, y: y0 + Math.floor(i / columns) * ARRANGE_STEP.y },
		]),
	);
}
