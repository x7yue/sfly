import { describe, expect, it } from "vitest";
import { hasMoreBelow } from "./scroll-more";

describe("滚动容器下面还有没看到的内容", () => {
	it("没滚到底就是有，滚到底或放得下就没有", () => {
		expect(hasMoreBelow({ scrollTop: 0, clientHeight: 380, scrollHeight: 540 })).toBe(true);
		expect(hasMoreBelow({ scrollTop: 100, clientHeight: 380, scrollHeight: 540 })).toBe(true);
		expect(hasMoreBelow({ scrollTop: 160, clientHeight: 380, scrollHeight: 540 })).toBe(false);
		expect(hasMoreBelow({ scrollTop: 0, clientHeight: 380, scrollHeight: 380 })).toBe(false);
	});

	it("亚像素的误差不算还有内容：差不到 1px 视为到底", () => {
		expect(hasMoreBelow({ scrollTop: 159.6, clientHeight: 380, scrollHeight: 540 })).toBe(false);
		expect(hasMoreBelow({ scrollTop: 158, clientHeight: 380, scrollHeight: 540 })).toBe(true);
	});
});
