import { describe, expect, it } from "vitest";
import { indexAfterDrop, moveItem, renamedItem, sameFocusList } from "./focus-list-edit";

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
	const item = { node_id: "load", chart: "TPS", title: "撮合 TPS" };

	it("去掉首尾空白；清空、全是空白或者写成图表标题都回到没起名", () => {
		expect(renamedItem(item, "  母单量 ")).toEqual({
			node_id: "load",
			chart: "TPS",
			title: "母单量",
		});
		expect(renamedItem(item, "")).toEqual({ node_id: "load", chart: "TPS" });
		expect(renamedItem(item, "   ")).toEqual({ node_id: "load", chart: "TPS" });
		expect(renamedItem(item, "TPS")).toEqual({ node_id: "load", chart: "TPS" });
	});
});

describe("sameFocusList", () => {
	const a = { node_id: "load", chart: "TPS" };
	const b = { node_id: "load", chart: "延迟", title: "下单延迟" };

	it("项、名字和顺序都一样才算一样", () => {
		expect(sameFocusList([a, b], [a, { ...b }])).toBe(true);
		expect(sameFocusList([a, b], [b, a])).toBe(false);
		expect(sameFocusList([a, b], [a, { ...b, title: "延迟" }])).toBe(false);
		expect(sameFocusList([a, b], [a])).toBe(false);
	});
});
