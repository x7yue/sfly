import { describe, expect, it } from "vitest";
import {
	hasOverlappingCards,
	LAYOUT_COLUMN,
	LEGACY_LAYOUT_COLUMN,
	NODE_SIZE,
	widenedPosition,
} from "../src/index.js";

describe("按旧卡片尺寸排的场景", () => {
	it("同一行按旧列宽 252 排的相邻卡片叠在一起；按新列宽排的、上下错开的不算", () => {
		const legacy = [{ position: { x: 0, y: 0 } }, { position: { x: LEGACY_LAYOUT_COLUMN, y: 0 } }];
		expect(hasOverlappingCards(legacy)).toBe(true);
		expect(
			hasOverlappingCards([{ position: { x: 0, y: 0 } }, { position: { x: LAYOUT_COLUMN, y: 0 } }]),
		).toBe(false);
		expect(
			hasOverlappingCards([
				{ position: { x: 0, y: 0 } },
				{ position: { x: 100, y: NODE_SIZE.height } },
				{},
			]),
		).toBe(false);
	});

	it("拉开横坐标：旧的列落到新的列上，纵坐标不动，拉开后不再叠", () => {
		expect(widenedPosition({ x: LEGACY_LAYOUT_COLUMN * 3, y: 230 })).toEqual({
			x: LAYOUT_COLUMN * 3,
			y: 230,
		});
		expect(widenedPosition({ x: 660, y: 230 })).toEqual({ x: 786, y: 230 });
		const legacy = [0, 1, 2].map((i) => ({ position: { x: i * LEGACY_LAYOUT_COLUMN, y: 0 } }));
		expect(
			hasOverlappingCards(legacy.map((n) => ({ position: widenedPosition(n.position) }))),
		).toBe(false);
	});
});
