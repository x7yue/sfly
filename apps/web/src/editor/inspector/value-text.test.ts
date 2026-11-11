// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { describe, expect, it } from "vitest";
import { formatJson, mappedText, mappedValue, parseJson, parseNumber } from "./value-text";

describe("参数输入框的文本与值", () => {
	it("JSON 字段：空白是不填，合法的 JSON 按值保存，整个文本恰好是一个引用时保存为整值引用", () => {
		expect(parseJson("  ")).toEqual({ value: undefined });
		expect(parseJson('{"a": [1, "x"]}')).toEqual({ value: { a: [1, "x"] } });
		expect(parseJson("${{ params.cfg }}")).toEqual({ value: "${{ params.cfg }}" });
		expect(parseJson(" ${{ params.cfg }}\n")).toEqual({ value: "${{ params.cfg }}" });
		expect(parseJson('{"a": ${{ params.cfg }}}')).toEqual({ error: "不是合法的 JSON" });
		expect(parseJson("{")).toEqual({ error: "不是合法的 JSON" });
	});

	it("JSON 字段显示为缩进两格的多行文本", () => {
		expect(formatJson(undefined)).toBe("");
		expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
		expect(formatJson("x")).toBe('"x"');
	});

	it("数字字段：空白是不填，整数字段拒绝小数", () => {
		expect(parseNumber(false)("")).toEqual({ value: undefined });
		expect(parseNumber(false)("1.5")).toEqual({ value: 1.5 });
		expect(parseNumber(true)("1.5")).toEqual({ error: "需要整数" });
		expect(parseNumber(false)("abc")).toEqual({ error: "需要数字" });
	});

	it("子流程参数映射：目标不是 string 时，不含引用的 JSON 字面量按常量保存，其余按文本", () => {
		expect(mappedValue("5", "number")).toBe(5);
		expect(mappedValue("true", "boolean")).toBe(true);
		expect(mappedValue('{"a":1}', "json")).toEqual({ a: 1 });
		expect(mappedValue("5", "string")).toBe("5");
		expect(mappedValue("${{ params.n }}", "number")).toBe("${{ params.n }}");
		expect(mappedValue("5 apples", "number")).toBe("5 apples");
		expect(mappedValue("", "number")).toBeUndefined();
		expect(mappedText(undefined)).toBe("");
		expect(mappedText("x")).toBe("x");
		expect(mappedText(5)).toBe("5");
		expect(mappedText({ a: 1 })).toBe('{"a":1}');
	});
});
