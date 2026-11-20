import { describe, expect, it } from "vitest";
import { readerKey } from "./reader";

describe("readerKey", () => {
	it("同样的读取条件得到同样的 key", () => {
		expect(readerKey("task-1", "warn,error", 3, false)).toBe(
			readerKey("task-1", "warn,error", 3, false),
		);
	});

	it("没给的条件和内容正好是 undefined、null 的字符串分得开", () => {
		expect(readerKey("task-1", undefined)).not.toBe(readerKey("task-1", "undefined"));
		expect(readerKey("task-1", null)).not.toBe(readerKey("task-1", "null"));
	});

	it("条件里带换行也不会和相邻的条件串在一起", () => {
		expect(readerKey("a\nb", "c")).not.toBe(readerKey("a", "b\nc"));
	});

	it("空字符串和没给不是同一个条件", () => {
		expect(readerKey("run-1", "")).not.toBe(readerKey("run-1", undefined));
	});
});
