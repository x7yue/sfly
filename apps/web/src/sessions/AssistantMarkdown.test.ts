import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hasHidden } from "#/lib/untrusted-text";
import {
	AssistantMarkdown,
	linkHost,
	MAX_NESTING_LEVELS,
	nestingLevels,
	rehypeWrapText,
	tooDeeplyNested,
} from "./AssistantMarkdown";
import { CONSTRUCTS, ESC, RLO, ZWSP } from "./assistant-markdown-samples";

const render = (text: string) => renderToStaticMarkup(createElement(AssistantMarkdown, { text }));

describe("助手的话里的链接：只认 http(s) 的绝对地址", () => {
	it("http、https 返回主机名（带端口）", () => {
		expect(linkHost("https://example.com/docs")).toBe("example.com");
		expect(linkHost("http://10.0.0.5:8080/a?b=1")).toBe("10.0.0.5:8080");
	});

	it("别的协议（javascript:、data:、mailto:、file:）和相对地址、空的都不是：只显示文字，不可点", () => {
		for (const href of [
			"javascript:alert(1)",
			"JaVaScRiPt:alert(1)",
			"data:text/html,<script>1</script>",
			"mailto:a@b.c",
			"file:///etc/passwd",
			"/runs/abc",
			"./x.md",
			"//evil.example/x",
			"",
		]) {
			expect(linkHost(href), href).toBeNull();
		}
		expect(linkHost(undefined)).toBeNull();
	});
});

describe("每个文字节点都经不可信文字组件（方向控制字符、零宽字符、转义字符写成占位，不原样进页面）", () => {
	for (const [name, text] of CONSTRUCTS) {
		it(`${name}：HTML 里没有原样的方向控制字符、零宽字符和转义字符，有写出来的占位`, () => {
			const html = render(text);
			// 整个渲染结果当作一段「可以多行的正文」扫一遍：和不可信文字组件用的是同一份字符表，有一个原样的就是有。
			expect(hasHidden(html, "text"), html).toBe(false);
			expect(html).not.toContain(RLO);
			expect(html).not.toContain(ZWSP);
			expect(html).not.toContain(ESC);
			expect(html).toContain('data-slot="hidden-character"');
		});
	}

	it("脚注不画英文的标题：标题写中文，回到正文的链接的说明也是中文", () => {
		const html = render("正文[^1]\n\n[^1]: 脚注的话");
		expect(html).not.toContain("Footnotes");
		expect(html).not.toContain("Back to reference");
		expect(html).toContain("脚注");
	});

	it("没有有害字符的普通 Markdown 照常渲染（列表、行内代码、代码块、表格、链接）", () => {
		const html = render(
			"- 一\n- `两`\n\n```bash\nsfly run\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[文档](https://example.com/docs)",
		);
		expect(html).toContain("<ul");
		expect(html).toContain("<code");
		expect(html).toContain('data-testid="assistant-code"');
		expect(html).toContain("<table");
		expect(html).toContain('href="https://example.com/docs"');
		expect(html).not.toContain('data-slot="hidden-character"');
	});
});

describe("rehypeWrapText：把文字节点换成可以交给不可信文字组件的元素", () => {
	type Node = {
		type: string;
		value?: string;
		tagName?: string;
		properties?: Record<string, unknown>;
		children?: Node[];
	};
	const text = (value: string): Node => ({ type: "text", value });
	const element = (tagName: string, ...children: Node[]): Node => ({
		type: "element",
		tagName,
		properties: {},
		children,
	});
	const run = (tree: Node) => {
		rehypeWrapText()(tree);
		return tree;
	};

	it("根上的 raw（块级 HTML）和文字、引用里的 raw 都换成 span 里的文字", () => {
		const tree = run({
			type: "root",
			children: [
				{ type: "raw", value: `<div>${RLO}</div>` },
				text("根上的字"),
				element("blockquote", { type: "raw", value: "<b>引用里</b>" }, text("引用里的字")),
			],
		});
		const [raw, plain, quote] = tree.children as Node[];
		expect(raw).toMatchObject({ type: "element", tagName: "span" });
		expect(raw?.children?.[0]).toEqual({ type: "text", value: `<div>${RLO}</div>` });
		expect(plain).toMatchObject({ type: "element", tagName: "span" });
		expect(quote?.children?.map((child) => child.tagName)).toEqual(["span", "span"]);
	});

	it("代码块（pre 里面）的文字不动：它由 pre 自己经组件显示，要拿原文", () => {
		const tree = run({
			type: "root",
			children: [element("pre", element("code", text("a\nb")))],
		});
		const code = tree.children?.[0]?.children?.[0];
		expect(code?.children).toEqual([{ type: "text", value: "a\nb" }]);
	});

	it("只有空白（空格、制表符、换行）的文字不动：表格、列表之间的换行不能变成元素", () => {
		const tree = run({
			type: "root",
			children: [element("ul", text("\n"), element("li", text("x")))],
		});
		const ul = tree.children?.[0];
		expect(ul?.children?.[0]).toEqual({ type: "text", value: "\n" });
	});

	it("看起来像空白的字符（U+FEFF 零宽不换行空格、U+200B）不算空白：要换", () => {
		const tree = run({ type: "root", children: [text("﻿"), text(ZWSP)] });
		expect(tree.children?.map((child) => child.tagName)).toEqual(["span", "span"]);
	});

	it("深度很大的树也不会爆栈（不递归）", () => {
		let node: Node = text("底");
		for (let i = 0; i < 200_000; i++) node = element("blockquote", node);
		expect(() => run({ type: "root", children: [node] })).not.toThrow();
	});
});

describe("嵌套太深的助手的话", () => {
	// 约 3 KB 的 3000 层嵌套引用让 mdast 转 hast 的递归爆栈（RangeError），整个会话页换成路由默认的英文错误页，刷新也一样（审查 #762）。
	const deepQuote = `${">".repeat(3000)} x`;
	const deepIndent = Array.from({ length: 400 }, (_, i) => `${"  ".repeat(i)}- 层 ${i}`).join("\n");

	it("每一行开头的嵌套层数：引用的 `>`、列表的标记、两个空格的缩进各算一层", () => {
		expect(nestingLevels("普通的一行")).toBe(0);
		expect(nestingLevels("> 引用")).toBe(1);
		expect(nestingLevels("> > > 三层引用")).toBe(3);
		expect(nestingLevels(">>> 紧挨着也算")).toBe(3);
		expect(nestingLevels("- 列表")).toBe(1);
		expect(nestingLevels("- - - 列表里的列表里的列表")).toBe(3);
		expect(nestingLevels("1. 有序")).toBe(1);
		expect(nestingLevels("        - 缩进 8 个空格的列表项")).toBe(5);
		// 分隔线、粗体、没有空格的减号不是列表标记。
		expect(nestingLevels("------------------------------------------------")).toBe(0);
		expect(nestingLevels("**粗体** 开头")).toBe(0);
		expect(nestingLevels("-1 是负数")).toBe(0);
	});

	it("层数过多（引用、列表的缩进、同一行里的列表标记）的话不交给 Markdown，退回纯文字", () => {
		expect(tooDeeplyNested(deepQuote)).toBe(true);
		expect(tooDeeplyNested(deepIndent)).toBe(true);
		expect(tooDeeplyNested(`${"- ".repeat(MAX_NESTING_LEVELS + 1)}x`)).toBe(true);
		expect(tooDeeplyNested(`${">".repeat(MAX_NESTING_LEVELS)} x`)).toBe(false);
		// 正常的嵌套（列表三层、引用两层）不受影响。
		expect(tooDeeplyNested("- a\n  - b\n    - c\n\n> x\n> > y")).toBe(false);
	});

	it("渲染 3000 层嵌套引用不抛：整条显示成纯文字（原样的字，不是 Markdown），文字里的有害字符照样写成占位", () => {
		let html = "";
		expect(() => {
			html = render(`${deepQuote}${RLO}`);
		}).not.toThrow();
		expect(html).toContain('data-fallback="plain"');
		expect(html).not.toContain("<blockquote");
		expect(html).not.toContain(RLO);
	});

	it("渲染很深的缩进列表同样不抛，退回纯文字；浅的照常是 Markdown", () => {
		expect(render(deepIndent)).toContain('data-fallback="plain"');
		expect(render("- a\n  - b")).toContain("<ul");
		expect(render("- a\n  - b")).not.toContain("data-fallback");
	});

	it("检查本身是线性的：几万行也很快", () => {
		const text = "> 一行话\n".repeat(50_000);
		const start = performance.now();
		tooDeeplyNested(text);
		expect(performance.now() - start).toBeLessThan(500);
	});
});
