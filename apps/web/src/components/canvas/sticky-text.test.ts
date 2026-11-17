import { describe, expect, it } from "vitest";
import { stickyBlocks, stickyHeadline } from "./sticky-text";

// 便签正文：`- ` 开头的行是列表，其余是段落，空行分段；缩小视图只显示一行。

describe("stickyBlocks", () => {
	it("连续的「- 」行是一个列表；其余行是段落，相邻的行合成一段，空行分段", () => {
		expect(stickyBlocks("先确认：\n- Agent 都在线\n-  升级包已放好\n\n收盘后\n看报告")).toEqual([
			{ kind: "paragraph", text: "先确认：" },
			{ kind: "list", items: ["Agent 都在线", "升级包已放好"] },
			{ kind: "paragraph", text: "收盘后\n看报告" },
		]);
	});

	it("空行把两个列表分开；只有「-」没有空格、写成「* 」的不是列表", () => {
		expect(stickyBlocks("- 一\n\n- 二\n-三\n* 四")).toEqual([
			{ kind: "list", items: ["一"] },
			{ kind: "list", items: ["二"] },
			{ kind: "paragraph", text: "-三\n* 四" },
		]);
	});
});

describe("stickyHeadline", () => {
	it("有标题时是标题，没有时是正文的第一行（去掉列表的「- 」）", () => {
		expect(stickyHeadline({ title: " 跑之前确认 ", text: "- 一" })).toBe("跑之前确认");
		expect(stickyHeadline({ text: "\n- Agent 都在线\n- 二" })).toBe("Agent 都在线");
		expect(stickyHeadline({ title: "  ", text: "已知问题\n第二行" })).toBe("已知问题");
	});
});
