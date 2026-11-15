import { describe, expect, it } from "vitest";
import { indexAfterDrop, moveItem, renamedItem } from "./focus-list-edit";

describe("moveItem", () => {
	it("把一项挪到另一个位置，其余的顺序不变", () => {
		expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
		expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
		expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
	});
});

describe("indexAfterDrop", () => {
	it("落点是两项之间的空位：落在自己前面或后面都不动，往后放要扣掉自己", () => {
		expect(indexAfterDrop(2, 0)).toBe(0);
		expect(indexAfterDrop(2, 2)).toBe(2);
		expect(indexAfterDrop(2, 3)).toBe(2);
		expect(indexAfterDrop(2, 5)).toBe(4);
	});
});

describe("renamedItem", () => {
	const base = { node_id: "load", chart: "TPS", status: "ok", chart_type: "area" } as const;
	const item = { ...base, title: "撮合 TPS" };

	it("去掉首尾空白；清空、全是空白或者写成图表标题都回到没起名；状态和图表类型不变", () => {
		expect(renamedItem(item, "  母单量 ")).toEqual({ ...base, title: "母单量" });
		expect(renamedItem(item, "")).toEqual(base);
		expect(renamedItem(item, "   ")).toEqual(base);
		expect(renamedItem(item, "TPS")).toEqual(base);
	});
});
