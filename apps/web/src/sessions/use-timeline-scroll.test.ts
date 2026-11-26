import { describe, expect, it } from "vitest";
import { followToEnd, releaseIfScrolledUp } from "./use-timeline-scroll";

// 会话时间线跟随的判断（#550）。滚动事件在下一帧才派发：人刚往上翻、事件还没到，`stuck` 仍是真，
// 这时内容变高要不要滚到底，只能从位置上判断：scrollTop 比上次定位时小，就是人往上翻了（复审 #762 第三轮：`follow` 少了这一道）。
const state = (over: { top: number; last: number; stuck?: boolean }) => ({
	el: { scrollTop: over.top, scrollHeight: 5000 },
	lastTop: { current: over.last },
	stuck: { current: over.stuck ?? true },
});

describe("人刚往上翻、滚动事件还没到：不再跟随", () => {
	it("scrollTop 比上次定位时小：释放跟随（stuck 变假）", () => {
		const s = state({ top: 100, last: 500 });
		releaseIfScrolledUp(s.el, s.lastTop, s.stuck);
		expect(s.stuck.current).toBe(false);
	});

	it("差一两个像素（小数取整、浏览器的抖动）不算往上翻；差到第三个像素才算", () => {
		const same = state({ top: 500, last: 500 });
		releaseIfScrolledUp(same.el, same.lastTop, same.stuck);
		expect(same.stuck.current).toBe(true);
		const two = state({ top: 498, last: 500 });
		releaseIfScrolledUp(two.el, two.lastTop, two.stuck);
		expect(two.stuck.current).toBe(true);
		const three = state({ top: 497, last: 500 });
		releaseIfScrolledUp(three.el, three.lastTop, three.stuck);
		expect(three.stuck.current).toBe(false);
	});

	it("往下滚（或没动）不释放；已经释放的不会被它重新置真", () => {
		const down = state({ top: 800, last: 500 });
		releaseIfScrolledUp(down.el, down.lastTop, down.stuck);
		expect(down.stuck.current).toBe(true);
		const released = state({ top: 800, last: 500, stuck: false });
		releaseIfScrolledUp(released.el, released.lastTop, released.stuck);
		expect(released.stuck.current).toBe(false);
	});
});

describe("followToEnd：内容在事件之外变高了（节流的那次渲染）", () => {
	it("在底部跟随着：滚到最底，记下新的位置", () => {
		const s = state({ top: 500, last: 500 });
		followToEnd(s.el, s.lastTop, s.stuck);
		expect(s.el.scrollTop).toBe(5000);
		expect(s.lastTop.current).toBe(5000);
		expect(s.stuck.current).toBe(true);
	});

	it("人刚往上翻、滚动事件还没到（stuck 还是真，位置比上次小）：不替他滚，也不再跟随", () => {
		const s = state({ top: 100, last: 500 });
		followToEnd(s.el, s.lastTop, s.stuck);
		expect(s.el.scrollTop).toBe(100);
		expect(s.lastTop.current).toBe(500);
		expect(s.stuck.current).toBe(false);
	});

	it("早就往上翻看着的（stuck 为假）：不动", () => {
		const s = state({ top: 100, last: 100, stuck: false });
		followToEnd(s.el, s.lastTop, s.stuck);
		expect(s.el.scrollTop).toBe(100);
		expect(s.stuck.current).toBe(false);
	});
});
