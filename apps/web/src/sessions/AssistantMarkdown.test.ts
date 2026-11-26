import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hasHidden } from "#/lib/untrusted-text";
import {
	AssistantMarkdown,
	bracketDepth,
	linkHost,
	MAX_BRACKET_DEPTH,
	MAX_NESTING_LEVELS,
	MAX_TREE_DEPTH,
	MarkdownBoundary,
	MarkdownTooDeepError,
	nestingLevels,
	rehypeWrapText,
	tooDeeplyNested,
	tooManyOpenBrackets,
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

	it("深度很大的树也不会爆栈（不递归）：抛的是 MarkdownTooDeepError，不是 RangeError", () => {
		let node: Node = text("底");
		for (let i = 0; i < 200_000; i++) node = element("blockquote", node);
		let thrown: unknown;
		try {
			run({ type: "root", children: [node] });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(MarkdownTooDeepError);
		expect(thrown).not.toBeInstanceOf(RangeError);
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

describe("嵌套的深度要在解析出来的树上量（复审 #762 第二轮：脚注定义绕过行首的检查）", () => {
	// 脚注定义 `[^a]:` 以 `[` 开头，行首检查数出 0 层；定义里的引用 `>` × N 照样嵌成 N 层。N=1500 渲染出 1504 层 DOM，
	// N=1800、2000 Chromium 的渲染进程崩溃（Blink 排版爆原生栈，错误边界兜不住，存在历史里每次打开都崩），N=3000 mdast 转 hast 爆栈。
	const footnoteQuote = (n: number) => `x[^a]\n\n[^a]: ${">".repeat(n)} y`;
	type Node = {
		type: string;
		value?: string;
		tagName?: string;
		properties?: Record<string, unknown>;
		children?: Node[];
	};
	const element = (tagName: string, ...children: Node[]): Node => ({
		type: "element",
		tagName,
		properties: {},
		children,
	});
	const chain = (depth: number): Node => {
		let node: Node = { type: "text", value: "底" };
		for (let i = 0; i < depth; i++) node = element("blockquote", node);
		return node;
	};

	it("行首检查拦不住脚注里的深引用（这就是为什么要在树上量）", () => {
		expect(tooDeeplyNested(footnoteQuote(2000))).toBe(false);
		expect(tooDeeplyNested(footnoteQuote(1500))).toBe(false);
	});

	it("树的深度超过 MAX_TREE_DEPTH 就抛 MarkdownTooDeepError，等于上限不抛；很深的树也不爆栈（不递归）", () => {
		const run = (depth: number) => rehypeWrapText()({ type: "root", children: [chain(depth)] });
		expect(() => run(MAX_TREE_DEPTH - 1)).not.toThrow();
		expect(() => run(MAX_TREE_DEPTH)).not.toThrow();
		expect(() => run(MAX_TREE_DEPTH + 1)).toThrow(MarkdownTooDeepError);
		expect(() => run(500_000)).toThrow(MarkdownTooDeepError);
	});

	it("脚注定义里的深引用（N=100、1500、2000，行首检查拦不住的）渲染时抛 MarkdownTooDeepError，不交给浏览器去排版", () => {
		for (const n of [100, 1500, 2000]) {
			expect(() => render(footnoteQuote(n)), `N=${n}`).toThrow(MarkdownTooDeepError);
		}
	});

	it("浅的脚注、正常的嵌套（列表三层、引用两层、表格、脚注）不受影响", () => {
		expect(() => render(footnoteQuote(5))).not.toThrow();
		expect(render("正文[^1]\n\n[^1]: > 脚注里的一层引用")).toContain("<blockquote");
		expect(() => render("- a\n  - b\n    - c\n\n> x\n> > y")).not.toThrow();
	});

	it("错误边界：渲染抛了错就置 failed，这一条退回纯文字（getDerivedStateFromError）", () => {
		expect(MarkdownBoundary.getDerivedStateFromError()).toEqual({ failed: true });
	});

	describe("错误边界的重试（getDerivedStateFromProps）：失败过的这一条逐字出现时不每变一次就重试，整条消息到了再试一次", () => {
		type State = { text: string; streaming: boolean; failed: boolean };
		const next = (props: { text: string; streaming: boolean }, state: State): State => ({
			...state,
			...(MarkdownBoundary.getDerivedStateFromProps(props, state) ?? {}),
		});

		it("没有变化：不动", () => {
			const state = { text: "a", streaming: true, failed: true };
			expect(
				MarkdownBoundary.getDerivedStateFromProps({ text: "a", streaming: true }, state),
			).toBeNull();
		});

		it("逐字出现中失败过：文字再变也保持失败，不重试（每次重试都是一次 0.1 到 0.4 秒的失败）", () => {
			let state: State = { text: "a", streaming: true, failed: true };
			for (const text of ["ab", "abc", "abcd"]) {
				state = next({ text, streaming: true }, state);
				expect(state, text).toEqual({ text, streaming: true, failed: true });
			}
		});

		it("逐字出现中没有失败：文字变了照常，不置 failed", () => {
			const state = next(
				{ text: "ab", streaming: true },
				{ text: "a", streaming: true, failed: false },
			);
			expect(state).toEqual({ text: "ab", streaming: true, failed: false });
		});

		it("整条消息到了（streaming 变假）：重试一次（failed 清掉）；这一次再失败就一直是失败，直到文字变了", () => {
			let state: State = { text: "abcd", streaming: true, failed: true };
			state = next({ text: "abcde", streaming: false }, state);
			expect(state).toEqual({ text: "abcde", streaming: false, failed: false });
			// 重试又抛了错：getDerivedStateFromError 置 failed；之后同样的 props 不再清掉它。
			state = { ...state, ...MarkdownBoundary.getDerivedStateFromError() };
			expect(state.failed).toBe(true);
			expect(
				MarkdownBoundary.getDerivedStateFromProps({ text: "abcde", streaming: false }, state),
			).toBeNull();
			// 没有在逐字出现的消息文字变了（比如改了）：重试。
			expect(next({ text: "另一段", streaming: false }, state).failed).toBe(false);
		});
	});
});

describe("括号嵌套太深的助手的话（连写的 `![`）退回纯文字", () => {
	// 嵌套着成对的 `![ … ](u)`（所有开括号在前、闭括号在后）解析是平方级：9 KB 约 0.5 秒、18 KB 约 1.8 秒、36 KB 约 7.7 秒（浏览器里量的，
	// 每次打开都冻住）。没闭合的 `[`、平摊的 `[1,2]`、平摊的链接、代码块里的大数组都是线性的，所以按括号的嵌套深度判，不按个数判。
	const nestedImages = (n: number) => `${"![".repeat(n)}x${"](u)".repeat(n)}`;

	it("括号深度：`[` 加一、`]` 减一（不小于 0），取最大值；平摊的不累加", () => {
		expect(bracketDepth("没有括号")).toBe(0);
		expect(bracketDepth("[a](u) [b](v) [c](w)")).toBe(1);
		expect(bracketDepth("[[1,2],[3,4]]")).toBe(2);
		expect(bracketDepth("![![![x](a)](b)](c)")).toBe(3);
		expect(bracketDepth("]]]] [a]")).toBe(1);
		expect(bracketDepth(nestedImages(1000))).toBe(1000);
	});

	it("深度超过 MAX_BRACKET_DEPTH 的不交给 Markdown；没闭合的 `[` 很多也算（拿不准，宁可按纯文字）；大数组、很多个链接不受影响", () => {
		expect(tooManyOpenBrackets(nestedImages(MAX_BRACKET_DEPTH + 1))).toBe(true);
		expect(tooManyOpenBrackets(nestedImages(MAX_BRACKET_DEPTH))).toBe(false);
		expect(tooManyOpenBrackets("[".repeat(MAX_BRACKET_DEPTH + 1))).toBe(true);
		expect(tooManyOpenBrackets("[[1,2],[3,4]]\n".repeat(5000))).toBe(false);
		expect(tooManyOpenBrackets("[a](https://e.example/x) ".repeat(5000))).toBe(false);
		expect(tooManyOpenBrackets("[1,2] ".repeat(20_000))).toBe(false);
	});

	it("渲染 9 KB、36 KB 的连写 `![`：退回纯文字，在时限内完成（修之前 0.5 到 7.7 秒）", () => {
		for (const n of [1500, 6000]) {
			const start = performance.now();
			const html = render(nestedImages(n));
			expect(performance.now() - start, `n=${n}`).toBeLessThan(500);
			expect(html).toContain('data-fallback="plain"');
			expect(html).not.toContain("<img");
		}
	});

	it("检查本身是线性的：几十万个字符也很快", () => {
		const start = performance.now();
		tooManyOpenBrackets("[a](u) ".repeat(100_000));
		expect(performance.now() - start).toBeLessThan(500);
	});
});
