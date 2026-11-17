import { describe, expect, it } from "vitest";
import { READABLE_ZOOM } from "./geometry";
import { readableViewport } from "./viewport";

// 画布 1440 × 900；四周被悬浮控件占住：上 60、右 12、下 72、左 12；再留 24（下 16）的边距。
// 能放内容的区域：x 36 → 1404（宽 1368），y 84 → 812（高 728）。
const view = { width: 1440, height: 900 };
const area = { top: 60, right: 12, bottom: 72, left: 12 };

describe("整理布局后的视图", () => {
	it("整张图在看得清的大小放得下：整张放进视口居中，最多放大到 100%", () => {
		// 1000 × 400 的图在 100% 就放得下。
		expect(readableViewport({ x: 0, y: 0, width: 1000, height: 400 }, view, area)).toEqual({
			x: 36 + (1368 - 1000) / 2,
			y: 84 + (728 - 400) / 2,
			zoom: 1,
		});
		// 1600 × 600 要缩到 0.855 才放得下，仍比看得清的大小 0.65 大：照样整张放进视口。
		const fit = readableViewport({ x: 100, y: 50, width: 1600, height: 600 }, view, area);
		expect(fit.zoom).toBeCloseTo(1368 / 1600);
		expect(fit.x).toBeCloseTo(36 - 100 * fit.zoom);
	});

	it("整张放不下：缩到看得清的大小，从左上角（主链开头）开始显示", () => {
		// 2400 × 1800 在 0.65 下是 1560 × 1170，两个方向都放不下。
		const vp = readableViewport({ x: -24, y: -44, width: 2400, height: 1800 }, view, area);
		expect(READABLE_ZOOM).toBe(0.65);
		expect(vp.zoom).toBe(0.65);
		expect(vp.x).toBeCloseTo(36 + 24 * 0.65);
		expect(vp.y).toBeCloseTo(84 + 44 * 0.65);
	});

	it("只有一个方向放不下：放得下的方向居中", () => {
		// 宽 1600 在 0.65 下是 1040，放得下；高 1800 放不下。
		const vp = readableViewport({ x: 0, y: 0, width: 1600, height: 1800 }, view, area);
		expect(vp.zoom).toBe(0.65);
		expect(vp.x).toBeCloseTo(36 + (1368 - 1040) / 2);
		expect(vp.y).toBe(84);
	});
});
