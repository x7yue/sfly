import { describe, expect, it } from "vitest";
import { descriptionParagraphs, firstParagraph } from "./node-description";

describe("descriptionParagraphs", () => {
	it("空行分段，段内的折行并成一个空格", () => {
		expect(
			descriptionParagraphs("请求一个地址。\n折行只是写代码时换了一行。\n\n失败时重试 3 次。"),
		).toEqual(["请求一个地址。 折行只是写代码时换了一行。", "失败时重试 3 次。"]);
	});

	it("连续的空行、只有空白的行都只算一个分隔，首尾和折行处的空白去掉", () => {
		expect(descriptionParagraphs("  第一段  \n   续行\n \t \n\n\n第二段\n")).toEqual([
			"第一段 续行",
			"第二段",
		]);
	});

	it("Windows 换行也一样", () => {
		expect(descriptionParagraphs("第一段\r\n续行\r\n\r\n第二段")).toEqual([
			"第一段 续行",
			"第二段",
		]);
	});

	it("没有说明、空串、只有空白时没有段落", () => {
		expect(descriptionParagraphs(undefined)).toEqual([]);
		expect(descriptionParagraphs("")).toEqual([]);
		expect(descriptionParagraphs(" \n\n \n")).toEqual([]);
	});
});

describe("firstParagraph", () => {
	it("取第一段，和 descriptionParagraphs 的分法一致", () => {
		expect(firstParagraph("请求一个地址。\n折行。\n\n第二段")).toBe("请求一个地址。 折行。");
	});

	it("没有说明时是 undefined", () => {
		expect(firstParagraph(undefined)).toBeUndefined();
		expect(firstParagraph("  \n ")).toBeUndefined();
	});
});
