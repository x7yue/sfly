// 按来源限频（`SourceLogLimit`，握手之前超限的日志用它，#674）。
import { describe, expect, it } from "vitest";
import { SourceLogLimit } from "../src/gateway/source-log-limit.js";

describe("SourceLogLimit", () => {
	it("同一个来源在一个窗口里只写第一行，窗口过了的第一行带上省掉的次数", () => {
		const limit = new SourceLogLimit(10_000, 100);
		expect(limit.admit("a", 0)).toEqual({ suppressed: 0 });
		expect(limit.admit("a", 1)).toBeUndefined();
		expect(limit.admit("a", 9_999)).toBeUndefined();
		expect(limit.admit("a", 10_000)).toEqual({ suppressed: 2 });
		// 新的窗口从 10_000 算起，省掉的次数清零
		expect(limit.admit("a", 19_999)).toBeUndefined();
		expect(limit.admit("a", 20_000)).toEqual({ suppressed: 1 });
		expect(limit.admit("a", 30_000)).toEqual({ suppressed: 0 });
	});

	it("不同的来源各算各的", () => {
		const limit = new SourceLogLimit(10_000, 100);
		expect(limit.admit("a", 0)).toEqual({ suppressed: 0 });
		expect(limit.admit("b", 1)).toEqual({ suppressed: 0 });
		expect(limit.admit("a", 2)).toBeUndefined();
		expect(limit.admit("b", 3)).toBeUndefined();
		expect(limit.admit("b", 4)).toBeUndefined();
		expect(limit.admit("a", 10_000)).toEqual({ suppressed: 1 });
		expect(limit.admit("b", 10_001)).toEqual({ suppressed: 2 });
	});

	it("记着的来源有上限：超过时丢掉最久没写过的，它下次来当作第一次", () => {
		const limit = new SourceLogLimit(10_000, 2);
		expect(limit.admit("a", 0)).toEqual({ suppressed: 0 });
		expect(limit.admit("b", 1)).toEqual({ suppressed: 0 });
		expect(limit.admit("c", 2)).toEqual({ suppressed: 0 });
		// a 已经被挤掉：窗口还没过也写，省掉的次数也丢了
		expect(limit.admit("a", 3)).toEqual({ suppressed: 0 });
		// c 还记着
		expect(limit.admit("c", 4)).toBeUndefined();
	});
});
