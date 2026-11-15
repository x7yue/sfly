import type { RunFocusItem } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { topFocusItems } from "./top-items";

const warn: RunFocusItem["anomaly"] = {
	kind: "log",
	level: "warn",
	at: "2026-01-01T00:10:00.000Z",
	message: "超时",
};
const item = (name: string, anomaly = false) => ({ name, anomaly: anomaly ? warn : null });
const names = (items: readonly { name: string }[]) => items.map((i) => i.name);

describe("关注项只显示前几个", () => {
	it("不多于上限时全部显示，没有「还有」", () => {
		const result = topFocusItems([item("a"), item("b")]);
		expect(names(result.shown)).toEqual(["a", "b"]);
		expect(result.more).toBe(0);
		expect(topFocusItems([])).toEqual({ shown: [], more: 0 });
	});

	it("默认只取前两个，其余算在「还有」里，顺序不变", () => {
		const result = topFocusItems([item("a"), item("b"), item("c"), item("d")]);
		expect(names(result.shown)).toEqual(["a", "b"]);
		expect(result.more).toBe(2);
	});

	it("有异常的排前，其余保持原来的顺序", () => {
		const result = topFocusItems([item("a"), item("b"), item("c", true), item("d")]);
		expect(names(result.shown)).toEqual(["c", "a"]);
		expect(result.more).toBe(2);
	});

	it("异常比上限多时只显示前面的异常，其余（含异常的）算在「还有」里", () => {
		const result = topFocusItems([item("a", true), item("b", true), item("c", true), item("d")]);
		expect(names(result.shown)).toEqual(["a", "b"]);
		expect(result.more).toBe(2);
	});

	it("上限可以指定", () => {
		const result = topFocusItems([item("a"), item("b"), item("c")], 1);
		expect(names(result.shown)).toEqual(["a"]);
		expect(result.more).toBe(2);
	});
});
