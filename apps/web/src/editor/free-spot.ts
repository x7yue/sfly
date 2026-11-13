import { freePosition, NODE_SIZE, type Position } from "@sfly/orchestration";

/** 画布坐标里的一块矩形（子流程区域的外框，含标题栏与留白）。 */
export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** 往右下错开的步长。 */
const NUDGE = 32;

const overlaps = (at: Position, box: Box) =>
	at.x < box.x + box.w &&
	at.x + NODE_SIZE.width > box.x &&
	at.y < box.y + box.h &&
	at.y + NODE_SIZE.height > box.y;

/**
 * 没有来源的新节点放在哪（卡片左上角）：想要的位置不压住任何节点，也不压住子流程区域（`regions`，
 * 来自 `subflowRegions`）。压住区域的外框就会盖住它的标题，也像是被放进了这个子流程里，所以继续往右下错开。
 */
export function freeSpot(
	wanted: Position,
	taken: readonly Position[],
	regions: readonly Box[],
): Position {
	let at = freePosition(wanted, taken);
	while (regions.some((r) => overlaps(at, r))) {
		at = freePosition({ x: at.x + NUDGE, y: at.y + NUDGE }, taken);
	}
	return at;
}

/** 卡片中心落在 `center`（右键处、视口中心）时的 `freeSpot`。 */
export const freeCardSpot = (
	center: Position,
	taken: readonly Position[],
	regions: readonly Box[],
): Position =>
	freeSpot(
		{
			x: Math.round(center.x - NODE_SIZE.width / 2),
			y: Math.round(center.y - NODE_SIZE.height / 2),
		},
		taken,
		regions,
	);
