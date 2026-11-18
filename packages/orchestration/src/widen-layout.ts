import { LAYOUT_COLUMN, NODE_SIZE, type Position } from "./layout.js";

/**
 * 卡片从 208 宽改成 256 宽之前，整理布局的列宽（208 宽的卡片加 44 的空隙）。按它排过的旧场景，
 * 同一行相邻的卡片现在叠 4px，相邻两个节点各在一个注释框里时两个框叠 52px。
 */
export const LEGACY_LAYOUT_COLUMN = 252;

/** 有两张卡片叠在一起（只看有位置的节点，卡片都是 NODE_SIZE）：多半是按旧的卡片尺寸排的场景。 */
export function hasOverlappingCards(
	nodes: readonly { position?: Position | undefined }[],
): boolean {
	const placed = nodes.flatMap((n) => (n.position ? [n.position] : []));
	return placed.some((a, i) =>
		placed
			.slice(i + 1)
			.some((b) => Math.abs(a.x - b.x) < NODE_SIZE.width && Math.abs(a.y - b.y) < NODE_SIZE.height),
	);
}

/**
 * 把横坐标按新旧列宽的比例拉开、纵坐标不动：作者手排的相对位置都留着，按旧列宽排的同一行相邻卡片之间回到原来的
 * 44 空隙（252 → 300）。和整理布局不同，不重新排。
 */
export const widenedPosition = ({ x, y }: Position): Position => ({
	x: Math.round((x * LAYOUT_COLUMN) / LEGACY_LAYOUT_COLUMN),
	y,
});
