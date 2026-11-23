import { describe, expect, it } from "vitest";
import {
	PANEL_FLOOR,
	TIMELINE_BODY_MIN,
	TIMELINE_HEADER_HEIGHT,
	timelineBodyMax,
} from "./detail-layout";

const TOPBAR = 52;
const BANNER = 43;
const CHARTS = 300;
/** 视口高度 → 失败的运行里详情的可用高度（窗口减顶栏、横幅）。 */
const available = (viewport: number) => viewport - TOPBAR - BANNER;

describe("时间线主体的上限（窗口矮时才受剩下的高度限制）", () => {
	it("窗口矮：剩下多少给多少，图表和底部面板的位置留得出来", () => {
		// 1280×800：800 − 52 − 43 − 40 − 300 − 190 = 175。
		expect(timelineBodyMax(available(800), CHARTS)).toBe(175);
		expect(timelineBodyMax(available(768), CHARTS)).toBe(143);
		for (const viewport of [768, 800]) {
			const body = timelineBodyMax(available(viewport), CHARTS);
			const left = available(viewport) - TIMELINE_HEADER_HEIGHT - body - CHARTS;
			expect(left).toBeGreaterThanOrEqual(PANEL_FLOOR);
		}
	});

	it("窗口很矮：不低于 120px，行多了在里面滚动", () => {
		expect(timelineBodyMax(available(600), CHARTS)).toBe(TIMELINE_BODY_MIN);
	});

	it("窗口高：剩下的比视口的 30% 大，这条限制不起作用（1440×900 是 275px，30% 是 270px）", () => {
		expect(timelineBodyMax(available(900), CHARTS)).toBe(275);
		expect(timelineBodyMax(available(900), CHARTS)).toBeGreaterThan(900 * 0.3);
		expect(timelineBodyMax(available(1080), CHARTS)).toBeGreaterThan(1080 * 0.3);
	});

	it("图表内容不够 300px 时只留内容的高度，时间线多得一些", () => {
		expect(timelineBodyMax(available(800), 200)).toBe(275);
	});
});
