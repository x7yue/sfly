import { describe, expect, it } from "vitest";
import { matchesFilter } from "./action-details";
import { action, mark } from "./fake-task-actions";

describe("筛选条件", () => {
	it("按名称：动作和标记都按名称；只看失败：只有失败的动作", () => {
		expect(matchesFilter(action(1, 0, "success", "预热"), { name: "预热" })).toBe(true);
		expect(matchesFilter(mark(2, 0, "预热"), { name: "预热" })).toBe(true);
		expect(matchesFilter(action(3, 0, "success", "下单"), { name: "预热" })).toBe(false);
		expect(matchesFilter(action(4, 0, "failed"), { failed: true })).toBe(true);
		expect(matchesFilter(action(5, 0, null), { failed: true })).toBe(false);
		expect(matchesFilter(mark(6, 0), { failed: true })).toBe(false);
		expect(matchesFilter(mark(7, 0), {})).toBe(true);
	});
});
