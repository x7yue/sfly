import { describe, expect, it } from "vitest";
import {
	CHARTS_FIRST_VISIBLE,
	CHARTS_RESERVED_HEIGHT,
	chartsReservedHeight,
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

describe("图表工作区预留的高度（第一张图表露出 96% 以上，时间线和面板先让）", () => {
	/** 一张图表 156px 高（标题、绘图区 136px、内边距）。 */
	const chart = (top: number) => ({ top, height: 156 });

	it("没有图表、或第一张图表本来就露得出来：300px，和以前一样", () => {
		expect(chartsReservedHeight(null, available(800), false)).toBe(CHARTS_RESERVED_HEIGHT);
		// 没有选中节点：第一张图表的上沿在 144px，144 + 150 = 294 < 300。
		expect(chartsReservedHeight(chart(144), available(800), false)).toBe(300);
	});

	it("选中的节点摘要在图表上面把它推下去（上沿 190px）：预留到图表露出 96%（190 + 150 = 340）", () => {
		expect(Math.ceil(156 * CHARTS_FIRST_VISIBLE)).toBe(150);
		// 1440×900 带失败横幅、不带横幅都留得出来；1280×800 带横幅：时间线退到 135px、面板仍是 190px。
		expect(chartsReservedHeight(chart(190), available(900), false)).toBe(340);
		expect(chartsReservedHeight(chart(190), 900 - TOPBAR, false)).toBe(340);
		expect(chartsReservedHeight(chart(190), available(800), false)).toBe(340);
		const body = timelineBodyMax(available(800), 340);
		expect(body).toBe(135);
		expect(available(800) - TIMELINE_HEADER_HEIGHT - body - 340).toBe(PANEL_FLOOR);
	});

	it("窗口矮到时间线退到最矮、面板退到下限也放不下：不再往上加，留以前的 300px", () => {
		// 1280×720 带横幅：剩下的只有 625 − 40 − 120 − 190 = 275。
		expect(chartsReservedHeight(chart(190), available(720), false)).toBe(300);
		expect(chartsReservedHeight(chart(190), 0, false)).toBe(300);
	});

	it("放得下一部分：加到时间线和面板让得出来的那么多", () => {
		// 视口 760、带横幅：665 − 40 − 120 − 190 = 315，想要 340，只给 315。
		expect(chartsReservedHeight(chart(190), available(760), false)).toBe(315);
		const body = timelineBodyMax(available(760), 315);
		expect(body).toBe(TIMELINE_BODY_MIN);
		expect(available(760) - TIMELINE_HEADER_HEIGHT - body - 315).toBe(PANEL_FLOOR);
	});

	it("窄窗口：以前的规则（上沿 + 120px）仍是下限，也往上加到露出 96%", () => {
		// 1024×768：工具栏折成几行，第一张图表的上沿在 230px：下限 350，想要 380，让得出来 716 − 40 − 120 − 190 = 366。
		expect(chartsReservedHeight(chart(230), 768 - TOPBAR, true)).toBe(366);
		// 让不出来时仍是以前的下限（不比以前少）。
		expect(chartsReservedHeight(chart(230), 600 - TOPBAR, true)).toBe(350);
	});
});
