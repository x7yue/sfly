import { freePosition, NODE_SIZE } from "@sfly/orchestration";
import { describe, expect, it } from "vitest";
import { type Box, freeCardSpot, freeSpot } from "./free-spot";

const region: Box = { x: 600, y: 460, w: 450, h: 160 };
const touchesRegion = (at: { x: number; y: number }) =>
	at.x < region.x + region.w &&
	at.x + NODE_SIZE.width > region.x &&
	at.y < region.y + region.h &&
	at.y + NODE_SIZE.height > region.y;

describe("没有来源的新节点的落点", () => {
	it("想要的位置是空的就用它", () => {
		expect(freeSpot({ x: 10, y: 20 }, [], [region])).toEqual({ x: 10, y: 20 });
	});

	it("压住子流程区域的外框（含标题栏）时往右下错开，直到完全在区域外", () => {
		const at = freeSpot({ x: 700, y: 440 }, [], [region]);
		expect(touchesRegion(at)).toBe(false);
		expect(at.x).toBeGreaterThan(700);
		expect(at.y).toBeGreaterThan(440);
	});

	it("也不压住已有节点：避开区域之后落点又压住节点时继续错开", () => {
		const nodes = [{ x: region.x + region.w + 4, y: region.y + region.h + 4 }];
		const at = freeSpot({ x: 700, y: 440 }, nodes, [region]);
		expect(touchesRegion(at)).toBe(false);
		expect(
			Math.abs(at.x - (nodes[0]?.x ?? 0)) < NODE_SIZE.width &&
				Math.abs(at.y - (nodes[0]?.y ?? 0)) < NODE_SIZE.height,
		).toBe(false);
	});

	it("卡片中心落在 center：区域正中间的位置也会被挪出区域", () => {
		const center = { x: region.x + region.w / 2, y: region.y + region.h / 2 };
		expect(touchesRegion(freeCardSpot(center, [], [region]))).toBe(false);
	});

	it("没有区域时与 freePosition 一样", () => {
		const taken = [{ x: 0, y: 0 }];
		expect(freeSpot({ x: 0, y: 0 }, taken, [])).toEqual(freePosition({ x: 0, y: 0 }, taken));
	});
});
