import { describe, expect, it } from "vitest";
import { TITLE_CHARS, titleOf } from "../src/sessions/session-service.js";

// 会话的标题（#654）：第一句话的前 60 个字；截短了就加省略号，不切开网址。

describe("会话的标题", () => {
	it("不超过 60 个字：原样（空白压成一个空格、去掉首尾），没有省略号", () => {
		expect(titleOf("  给 http_check\n加一个   超时参数 ")).toBe("给 http_check 加一个 超时参数");
		const exact = "字".repeat(TITLE_CHARS);
		expect(titleOf(exact)).toBe(exact);
	});

	it("超过 60 个字：取前 60 个字，末尾加「…」", () => {
		const title = titleOf("字".repeat(TITLE_CHARS + 1));
		expect(title).toBe(`${"字".repeat(TITLE_CHARS)}…`);
	});

	it("按字（码点）数，不按 UTF-16 单元：表情和生僻字算一个", () => {
		expect(titleOf("😀".repeat(TITLE_CHARS))).toBe("😀".repeat(TITLE_CHARS));
		expect(titleOf("😀".repeat(TITLE_CHARS + 1))).toBe(`${"😀".repeat(TITLE_CHARS)}…`);
	});

	it("第 60 个字落在网址里：截在网址之前，不留半截网址", () => {
		const text = `${"先看看这个现象".repeat(6)}然后探测 https://staging.example.test/api/v2/health?verbose=1 再说`;
		const title = titleOf(text);
		expect(title.endsWith("然后探测…")).toBe(true);
		expect(title).not.toContain("https");
		expect([...title].length).toBeLessThanOrEqual(TITLE_CHARS + 1);
	});

	it("网址整段在 60 个字以内：保留，后面截短", () => {
		const text = `探测 http://s.test/x ${"字".repeat(80)}`;
		const title = titleOf(text);
		expect(title.startsWith("探测 http://s.test/x ")).toBe(true);
		expect(title.endsWith("…")).toBe(true);
		expect([...title].length).toBe(TITLE_CHARS + 1);
	});

	it("网址从第一个字开始、前面没有内容：只好截在网址里（仍然加省略号）", () => {
		const url = `https://example.test/${"p".repeat(80)}`;
		expect(titleOf(`${url} 看一下`)).toBe(`${[...url].slice(0, TITLE_CHARS).join("")}…`);
	});

	it("截点正好在网址结束处或之后：不用躲", () => {
		const url = "https://a.test/x";
		const lead = "字".repeat(TITLE_CHARS - [...url].length);
		expect(titleOf(`${lead}${url} 后面还有字`)).toBe(`${lead}${url}…`);
	});
});
