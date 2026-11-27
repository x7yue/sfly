import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { CONSTRUCTS } from "./assistant-markdown-samples";

// 结构的保证：渲染结果里的每一个文字节点都在 `UntrustedText` 里（控制台自己的文案除外）。
// 做法：把 `UntrustedText` 换成一个带标记的元素 `<ut-text>`，渲染之后把它连里面的字整个去掉、再去掉所有标签，剩下的就是「没经过
// `UntrustedText` 的文字」——只能是控制台自己的几个字（图片说明的「[图片：…]」的方括号和冒号、主机名两边的括号、空白）。有一个模型写的字漏了，这里就红。
// 和 `AssistantMarkdown.test.ts` 的区别：那边查「没有原样的有害字符」（行为），这边查「每个字都经过组件」（结构，包括普通的字）。
vi.mock("#/components/untrusted-text", () => ({
	UntrustedText: ({ text }: { text: string; mode?: string }): ReactNode =>
		createElement("ut-text", null, text),
}));

const render = (text: string) => renderToStaticMarkup(createElement(AssistantMarkdown, { text }));

/** 去掉 `<ut-text>…</ut-text>`（连里面的字）和所有标签之后剩下的文字。 */
const outside = (html: string) =>
	html
		.replace(/<ut-text>[\s\S]*?<\/ut-text>/g, "")
		.replace(/<[^>]*>/g, "")
		.replace(/&[#a-z0-9]+;/gi, "");

/** 控制台自己的文案：图片说明的方括号和冒号、主机名两边的括号，加空白。 */
const OWN = /^[\s[\]：图片()]*$/;

describe("助手的话：每一个文字节点都经过不可信文字组件（结构）", () => {
	for (const [name, text] of CONSTRUCTS) {
		it(`${name}：组件外面没有模型写的字`, () => {
			const html = render(text);
			expect(html).toContain("<ut-text>");
			expect(outside(html), html).toMatch(OWN);
		});
	}

	it("普通的字也一样（不只是有害字符）：块级 HTML、引用、列表、表格、脚注、链接里的每个字都在组件里", () => {
		const text = [
			"<div>块级 HTML 里的字</div>",
			"",
			"> 引用里的字",
			"",
			"> <div>引用里的 HTML</div>",
			"",
			"- 列表里的字\n  - 嵌套的字",
			"",
			"| 表头 |\n|---|\n| 单元格里的字 |",
			"",
			"[链接里的字](https://example.com/a) 和 https://example.com/b",
			"",
			"正文[^1]",
			"",
			"[^1]: 脚注里的字",
		].join("\n");
		const html = render(text);
		expect(outside(html), html).toMatch(OWN);
		for (const word of [
			"块级 HTML 里的字",
			"引用里的字",
			"引用里的 HTML",
			"嵌套的字",
			"单元格里的字",
			"链接里的字",
			"脚注里的字",
		]) {
			// 块级 HTML 整段当文字（连标签一起），所以词的两边可以有别的字。
			expect(html, word).toMatch(new RegExp(`<ut-text>[^<]*${word}[^<]*</ut-text>`));
		}
	});

	it("检查是有效的：把一段文字不经组件直接放进去，`outside` 会把它认出来（防止这条测试空转）", () => {
		expect(outside("<p>漏掉的字</p><ut-text>经过的字</ut-text>")).toBe("漏掉的字");
		expect(outside("<p>漏掉的字</p>")).not.toMatch(OWN);
	});
});
