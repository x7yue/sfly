import { describe, expect, it } from "vitest";
import { UndoStack } from "./history";

describe("撤销 / 重做的命令栈", () => {
	it("撤销回到修改前的状态，重做回到修改后的状态", () => {
		const stack = new UndoStack<string>();
		stack.record("a");
		stack.record("b");
		// 当前是 c
		expect(stack.undo("c")).toBe("b");
		expect(stack.undo("b")).toBe("a");
		expect(stack.undo("a")).toBeUndefined();
		expect(stack.redo("a")).toBe("b");
		expect(stack.redo("b")).toBe("c");
		expect(stack.redo("c")).toBeUndefined();
	});

	it("报告能否撤销、重做", () => {
		const stack = new UndoStack<string>();
		expect([stack.canUndo, stack.canRedo]).toEqual([false, false]);
		stack.record("a");
		expect([stack.canUndo, stack.canRedo]).toEqual([true, false]);
		stack.undo("b");
		expect([stack.canUndo, stack.canRedo]).toEqual([false, true]);
	});

	it("撤销之后做了新的修改，重做的记录作废", () => {
		const stack = new UndoStack<string>();
		stack.record("a");
		expect(stack.undo("b")).toBe("a");
		stack.record("a");
		expect(stack.canRedo).toBe(false);
		expect(stack.undo("x")).toBe("a");
	});

	it("同一个字段连续输入合并为一步（间隔不超过 1 秒）", () => {
		const stack = new UndoStack<string>();
		stack.record("", { key: "fetch/url", now: 0 });
		stack.record("h", { key: "fetch/url", now: 400 });
		stack.record("ht", { key: "fetch/url", now: 1300 });
		expect(stack.undo("htt")).toBe("");
		expect(stack.canUndo).toBe(false);
	});

	it("间隔超过 1 秒、换了字段、或中间有其他修改时不合并", () => {
		const stack = new UndoStack<string>();
		stack.record("0", { key: "a", now: 0 });
		stack.record("1", { key: "a", now: 1001 });
		stack.record("2", { key: "b", now: 1100 });
		stack.record("3", { now: 1200 });
		stack.record("4", { key: "b", now: 1300 });
		expect(["5", "4", "3", "2", "1"].map((s) => stack.undo(s))).toEqual(["4", "3", "2", "1", "0"]);
	});

	it("撤销之后再输入同一个字段，作为新的一步", () => {
		const stack = new UndoStack<string>();
		stack.record("a", { key: "f", now: 0 });
		expect(stack.undo("ab")).toBe("a");
		stack.record("a", { key: "f", now: 200 });
		stack.record("ax", { key: "f", now: 300 });
		expect(stack.undo("axy")).toBe("a");
		expect(stack.canUndo).toBe(false);
	});

	it("最多保留 limit 步，超出时丢掉最早的", () => {
		const stack = new UndoStack<number>({ limit: 2 });
		stack.record(1);
		stack.record(2);
		stack.record(3);
		expect(stack.undo(4)).toBe(3);
		expect(stack.undo(3)).toBe(2);
		expect(stack.undo(2)).toBeUndefined();
	});
});
