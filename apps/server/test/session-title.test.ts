import { describe, expect, it } from "vitest";
import { TITLE_CHARS, TITLE_MIN_BEFORE_URL, titleOf } from "../src/sessions/session-service.js";

// 会话的标题（#654）：第一句话的前 60 个字（看起来的字，不是码点）；截短了就加省略号，不切开网址（网址只认 ASCII 可见字符，
// 不分大小写；前面留不下 10 个字时不躲网址）。

const pad = (n: number, ch = "字") => ch.repeat(n);
/** 一个看起来的字有几个字形簇：用 Intl.Segmenter 数，和被测代码独立的一份。 */
const graphemes = (text: string) =>
	[...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
const URL_PATH = `https://example.test/${"p".repeat(80)}`;

describe("会话的标题：长度", () => {
	it("不超过 60 个字：原样（空白压成一个空格、去掉首尾），没有省略号", () => {
		expect(titleOf("  给 http_check\n加一个   超时参数 ")).toBe("给 http_check 加一个 超时参数");
		const exact = pad(TITLE_CHARS);
		expect(titleOf(exact)).toBe(exact);
	});

	it("超过 60 个字：取前 60 个字，末尾加「…」", () => {
		expect(titleOf(pad(TITLE_CHARS + 1))).toBe(`${pad(TITLE_CHARS)}…`);
	});

	it("第 60 个字是空格：去掉末尾的空格再加「…」", () => {
		expect(titleOf(`${pad(TITLE_CHARS - 1)} ${pad(5)}`)).toBe(`${pad(TITLE_CHARS - 1)}…`);
	});
});

describe("会话的标题：字是看起来的字", () => {
	it("表情和生僻字算一个", () => {
		expect(titleOf(pad(TITLE_CHARS, "😀"))).toBe(pad(TITLE_CHARS, "😀"));
		expect(titleOf(pad(TITLE_CHARS + 1, "😀"))).toBe(`${pad(TITLE_CHARS, "😀")}…`);
	});

	// 每一种：第 60 个字是它，后面还有字 → 它整个留下；第 61 个字是它 → 它整个去掉，不留半个。
	const WHOLE: Record<string, string> = {
		"带零宽连接符的表情（一家人）": "👨‍👩‍👧‍👦",
		"国旗（两个区域指示符）": "🇨🇳",
		"字母加组合变音符号（é）": "é",
		"带变体选择符的符号（❤️）": "❤️",
		带肤色的手势: "👍\u{1F3FD}",
	};
	for (const [name, glyph] of Object.entries(WHOLE)) {
		it(`${name}：截点不落在它中间`, () => {
			expect(graphemes(glyph)).toBe(1);
			expect(titleOf(`${pad(TITLE_CHARS - 1)}${glyph}后面还有`)).toBe(
				`${pad(TITLE_CHARS - 1)}${glyph}…`,
			);
			expect(titleOf(`${pad(TITLE_CHARS)}${glyph}`)).toBe(`${pad(TITLE_CHARS)}…`);
		});
	}

	it("59 个字加 ❤️ 是正好 60 个字：原样，不加省略号", () => {
		const text = `${pad(TITLE_CHARS - 1)}❤️`;
		expect(titleOf(text)).toBe(text);
	});

	it("标题最多 60 个字加省略号（按字数，不是码点或 UTF-16 单元数）", () => {
		const title = titleOf(`${pad(30, "👨‍👩‍👧‍👦")}${pad(40, "🇨🇳")}`);
		expect(graphemes(title)).toBe(TITLE_CHARS + 1);
		expect(title.endsWith("…")).toBe(true);
	});
});

describe("会话的标题：不切开网址", () => {
	it("第 60 个字落在网址里：截在网址之前，不留半截网址", () => {
		const text = `${"先看看这个现象".repeat(6)}然后探测 https://staging.example.test/api/v2/health?verbose=1 再说`;
		const title = titleOf(text);
		expect(title).toBe(`${"先看看这个现象".repeat(6)}然后探测…`);
		expect(title).not.toContain("https");
	});

	it("网址整段在 60 个字以内：保留，后面截短", () => {
		const title = titleOf(`探测 http://s.test/x ${pad(80)}`);
		expect(title.startsWith("探测 http://s.test/x ")).toBe(true);
		expect(title.endsWith("…")).toBe(true);
		expect(graphemes(title)).toBe(TITLE_CHARS + 1);
	});

	it("截点正好在网址结束处或之后：不用躲", () => {
		const url = "https://a.test/x";
		const lead = pad(TITLE_CHARS - url.length);
		expect(titleOf(`${lead}${url} 后面还有字`)).toBe(`${lead}${url}…`);
	});

	describe("网址只认 ASCII 可见字符：后面紧跟中文也结束（不把后面的话当成网址）", () => {
		// 网址前面要留得下 10 个字以上：前面留不下时本来就不躲网址，这几条测不出网址认到哪里为止。
		const before = "请帮我看看下面这个服务";
		it("网址后面直接跟中文", () => {
			const text = `${before}https://staging.example.test/api/v2/health为什么一直返回500，日志里说连接池满了，昨天还好好的，今天早上发布之后就这样了，麻烦看一下`;
			const title = titleOf(text);
			expect(
				title.startsWith(`${before}https://staging.example.test/api/v2/health为什么一直`),
			).toBe(true);
			expect(graphemes(title)).toBe(TITLE_CHARS + 1);
		});

		it("网址后面直接跟全角标点", () => {
			const head = `${before}https://a.test/x。`;
			expect(titleOf(`${head}${pad(70)}`)).toBe(`${head}${pad(TITLE_CHARS - graphemes(head))}…`);
			expect(
				titleOf(`${before}https://s.test/x，然后${pad(70)}`).startsWith(
					`${before}https://s.test/x，然后`,
				),
			).toBe(true);
		});

		it("网址被全角括号包着", () => {
			const title = titleOf(`${before}（https://a.test/x）${pad(70)}`);
			expect(title.startsWith(`${before}（https://a.test/x）`)).toBe(true);
			expect(graphemes(title)).toBe(TITLE_CHARS + 1);
		});

		it("网址里含 ASCII 标点（?、&、=、#、%）照样在网址里：截点落在其中时躲开", () => {
			const text = `${pad(20)}然后探测 https://s.test/a?b=1&c=%E4%B8%AD#frag${"p".repeat(60)}再说`;
			expect(titleOf(text)).toBe(`${pad(20)}然后探测…`);
		});
	});

	describe("协议不分大小写", () => {
		for (const scheme of ["HTTPS://", "Http://", "hTTp://"]) {
			it(scheme, () => {
				const text = `${pad(50)}然后探测 ${scheme}staging.example.test/api/v2/health 再说`;
				expect(titleOf(text)).toBe(`${pad(50)}然后探测…`);
			});
		}
	});

	describe("网址前面留不下 10 个字：不躲网址，照常截在第 60 个字（网址被切开）", () => {
		const wholeCut = (before: string) => {
			const title = titleOf(`${before}${URL_PATH} 看一下`);
			expect(graphemes(title)).toBe(TITLE_CHARS + 1);
			expect(title.startsWith(before)).toBe(true);
			expect(title).toContain("https://");
			return title;
		};

		it("前面什么都没有", () => {
			expect(titleOf(`${URL_PATH} 看一下`)).toBe(
				`${[...URL_PATH].slice(0, TITLE_CHARS).join("")}…`,
			);
		});

		it("前面只有标点", () => {
			for (const before of ["（", "“", "- ", "1. ", "（“-", "…… "]) wholeCut(before);
		});

		it("前面一两个字", () => {
			wholeCut("看 ");
			wholeCut("请看：");
		});

		it(`前面 ${TITLE_MIN_BEFORE_URL - 1} 个字：不躲；${TITLE_MIN_BEFORE_URL} 个字：躲`, () => {
			wholeCut(`${pad(TITLE_MIN_BEFORE_URL - 1)} `);
			expect(titleOf(`${pad(TITLE_MIN_BEFORE_URL)} ${URL_PATH} 看一下`)).toBe(
				`${pad(TITLE_MIN_BEFORE_URL)}…`,
			);
		});

		it("首尾的空白和标点不算：（十个字）加网址，躲；（九个字）加网址，不躲", () => {
			expect(titleOf(`（${pad(TITLE_MIN_BEFORE_URL)}）${URL_PATH} 看一下`)).toBe(
				`（${pad(TITLE_MIN_BEFORE_URL)}）…`,
			);
			wholeCut(`……（${pad(TITLE_MIN_BEFORE_URL - 1)}）：`);
		});

		it("中间的标点算内容（只去掉首尾的）", () => {
			// 「你好，世界」中间的逗号留着：内容是 5 个字加 1 个逗号，不够 10 个字就不躲；写成 5+5 个字加中间的标点就够了。
			wholeCut("你好，世界 ");
			expect(titleOf(`${pad(5)}，${pad(5)} ${URL_PATH} 看一下`)).toBe(`${pad(5)}，${pad(5)}…`);
		});
	});

	describe("截点之后的网址不用看", () => {
		it("截点后有网址：标题不受它影响", () => {
			expect(titleOf(`${pad(70)} https://a.test/x 然后`)).toBe(`${pad(TITLE_CHARS)}…`);
		});

		it("很长的话里有成千上万个网址：只看截点之前的，很快", () => {
			const text = `${pad(100)}${" https://a.test/x".repeat(100_000)}`;
			const began = performance.now();
			expect(titleOf(text)).toBe(`${pad(TITLE_CHARS)}…`);
			expect(performance.now() - began).toBeLessThan(1000);
		});
	});
});
