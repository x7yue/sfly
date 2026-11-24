import { nameProblem, REJECTED_NAME_CHARACTER } from "@sfly/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Truncate } from "../components/ui/truncate";
import { UntrustedText } from "../components/untrusted-text";
import {
	hasHidden,
	isPlainText,
	type UntrustedMode,
	untrustedPlain,
	untrustedSegments,
} from "./untrusted-text";

// 显示不可信的文字（#699）：字符表是 @sfly/schema 的 text-safety.ts 里那一张；改变方向的控制字符、零宽字符、转义字符写出来，
// 三种例外（零宽连接符、零宽不连字符、变体选择符）照位置规则；正常的中文、表情、从右到左的文字不变。

/** 文字里被写出来的字符，按出现的顺序（`U+202E` 这样）。 */
const hiddenLabels = (text: string, mode: UntrustedMode = "line") =>
	untrustedSegments(text, mode).flatMap((s) => (s.kind === "hidden" ? [s.label] : []));

describe("正常的文字显示不变", () => {
	const SAMPLES = {
		中文: "给 http_check 加一个超时参数，失败时重试 3 次。",
		日文和韩文: "こんにちは、世界。안녕하세요",
		"表情（单个、肤色、国旗、组合）":
			"👍 👍🏽 🇨🇳 👩\u200D💻 🏳\uFE0F\u200D🌈 ❤\uFE0F\u200D🔥 ❤\uFE0F 👨\u200D👩\u200D👧\u200D👦",
		带变音符号的字母: "café résumé naïve é",
		"波斯文（词中的零宽不连字符）": "می\u200Cخواهم",
		"印地文（零宽连接符）": "क्\u200Dष",
		"从右到左：阿拉伯文": "مرحبا بالعالم ١٢٣",
		"从右到左：希伯来文和数字": "שלום עולם 123",
		从右到左夹着从左到右: "اسم الملف: report_final.pdf (v2)",
		"等宽的 ASCII、符号": "a/b-c_d@1.2.3 [ok] {x: 1} <tag> 100% $5 ~tilde `tick`",
	};
	for (const [name, text] of Object.entries(SAMPLES)) {
		it(name, () => {
			expect(untrustedSegments(text)).toEqual([{ kind: "text", text }]);
			expect(untrustedSegments(text, "text")).toEqual([{ kind: "text", text }]);
			expect(untrustedPlain(text)).toBe(text);
			expect(hasHidden(text)).toBe(false);
		});
	}

	it("空串没有段；只有空格的原样（空白不是看不见的字符，是排版）", () => {
		expect(untrustedSegments("")).toEqual([]);
		expect(untrustedSegments("   ")).toEqual([{ kind: "text", text: "   " }]);
	});
});

describe("改变文字方向的控制字符写出来", () => {
	const BIDI = [
		"\u202A", // 从左到右嵌入
		"\u202B",
		"\u202C",
		"\u202D", // 从左到右覆盖
		"\u202E", // 从右到左覆盖：名字倒着显示
		"\u2066", // 从左到右隔离
		"\u2067",
		"\u2068",
		"\u2069",
		"\u200E", // 从左到右标记
		"\u200F", // 从右到左标记
		"\u061C", // 阿拉伯字母标记
	];
	for (const control of BIDI) {
		const label = `U+${(control.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}`;
		it(`${label}`, () => {
			const segments = untrustedSegments(`ab${control}cd`);
			expect(segments.map((s) => (s.kind === "text" ? s.text : s.label))).toEqual([
				"ab",
				label,
				"cd",
			]);
			const hidden = segments.find((s) => s.kind === "hidden");
			expect(hidden?.kind === "hidden" && hidden.name).toContain("文字方向控制字符");
			expect(untrustedPlain(`ab${control}cd`)).toBe(`ab⟨${label}⟩cd`);
		});
	}

	it("用覆盖字符把一个名字倒过来：写出来之后文字里没有方向控制字符", () => {
		const plain = untrustedPlain("admin\u202Egpj.exe");
		expect(plain).toBe("admin⟨U+202E⟩gpj.exe");
		expect(REJECTED_NAME_CHARACTER.test(plain)).toBe(false);
	});
});

describe("看不见的字符写出来", () => {
	const CASES: [string, string, string][] = [
		["零宽空格", "\u200B", "零宽空格"],
		["词连接符", "\u2060", "词连接符"],
		["字节顺序标记", "\uFEFF", "字节顺序标记"],
		["软连字符", "\u00AD", "软连字符"],
		["盲文空白", "\u2800", "盲文空白"],
		["填充字符", "\u3164", "填充字符"],
		["标签字符（能拼出一整句看不见的话）", "\u{E0041}", "标签字符"],
		["补充的变体选择符（能逐字节编码数据）", "\u{E0100}", "补充的变体选择符"],
		["蒙古文变体选择符", "\u180B", "蒙古文"],
		["行分隔符", "\u2028", "行分隔符"],
		["段分隔符", "\u2029", "段分隔符"],
		["孤立的代理码元", "\uD800", "孤立的代理码元"],
	];
	for (const [name, character, expected] of CASES) {
		it(name, () => {
			const segments = untrustedSegments(`a${character}b`);
			expect(segments).toHaveLength(3);
			const hidden = segments[1];
			expect(hidden?.kind).toBe("hidden");
			expect(hidden?.kind === "hidden" && hidden.name).toContain(expected);
		});
	}

	it("藏在后面的一串看不见的字符：每一个都写出来，看得见的字原样", () => {
		const hiddenMessage = "\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045}";
		expect(hiddenLabels(`正常的名字${hiddenMessage}`)).toHaveLength(6);
		expect(untrustedPlain(`正常的名字${hiddenMessage}`).startsWith("正常的名字⟨U+E0049⟩")).toBe(
			true,
		);
	});
});

describe("控制字符", () => {
	it("单行（line）：换行、制表符、回车、转义字符、DEL、C1 控制字符都写出来", () => {
		expect(hiddenLabels("a\nb\tc\rd\u001Be\u007Ff\u0085g")).toEqual([
			"U+000A",
			"U+0009",
			"U+000D",
			"U+001B",
			"U+007F",
			"U+0085",
		]);
	});

	it("多行（text）：换行、制表符、换行前的回车是排版，照常显示", () => {
		expect(untrustedSegments("第一行\n\t第二行\r\n第三行", "text")).toEqual([
			{ kind: "text", text: "第一行\n\t第二行\r\n第三行" },
		]);
	});

	it("多行（text）里：转义字符、单独的回车、垂直制表符、换页还是写出来（终端的转义序列、覆盖一行的进度条）", () => {
		expect(hiddenLabels("\u001B[31m红\u001B[0m", "text")).toEqual(["U+001B", "U+001B"]);
		expect(hiddenLabels("进度 10%\r进度 20%", "text")).toEqual(["U+000D"]);
		expect(hiddenLabels("a\u000Bb\u000Cc", "text")).toEqual(["U+000B", "U+000C"]);
		// 写出来之后，转义序列后面的 `[31m` 是普通的字，照常显示。
		expect(untrustedPlain("\u001B[31m红", "text")).toBe("⟨U+001B⟩[31m红");
	});

	it("多行（text）：方向控制字符和零宽字符仍然写出来", () => {
		expect(hiddenLabels("第一行\n\u202E第二行\u200B", "text")).toEqual(["U+202E", "U+200B"]);
	});
});

describe("三种例外照位置规则（零宽连接符、零宽不连字符、变体选择符）", () => {
	it("位置对：原样显示，不写出来", () => {
		for (const text of ["a\u200Db", "a\u200Cb", "a\uFE0F", "❤\uFE0F\u200D🔥", "a\u200D"]) {
			expect(hiddenLabels(text), JSON.stringify(text)).toEqual([]);
		}
	});

	it("位置不对：写出来，说明它只能紧跟在一个看得见的字符后面", () => {
		const CASES: [string, string[]][] = [
			["\u200Dabc", ["U+200D"]], // 开头
			["a \u200Db", ["U+200D"]], // 接在空白后面
			["a\u200D\u200Db", ["U+200D"]], // 连着出现
			["a\u200C\u200Db", ["U+200D"]],
			["a\uFE0F\uFE0Fb", ["U+FE0F"]], // 一个字符后面最多一个变体选择符
			["a\u200D\uFE0F", ["U+FE0F"]], // 零宽连接符后面不能接变体选择符
			["a\uFE0F\u200Cb", ["U+200C"]], // 变体选择符后面只能接零宽连接符
			["\uFE0Fabc", ["U+FE0F"]],
		];
		for (const [text, expected] of CASES) {
			expect(hiddenLabels(text), JSON.stringify(text)).toEqual(expected);
		}
		const misplaced = untrustedSegments("\u200Dabc")[0];
		expect(misplaced?.kind === "hidden" && misplaced.name).toContain("位置不对");
	});

	it("例外字符挂在被写出来的字符后面也不行（不让它们藏在一个写出来的字符后面）", () => {
		expect(hiddenLabels("a\u200B\u200Db")).toEqual(["U+200B", "U+200D"]);
	});
});

describe("和命令行、名字校验是同一套规则：text-safety.ts 的 nameProblem", () => {
	// 一个确定的伪随机序列（不依赖运行时），从一池有代表性的字符里拼出短字符串。
	const POOL = [
		"a",
		"中",
		"b",
		" ",
		"\t",
		"\n",
		"\u200D",
		"\u200C",
		"\uFE0F",
		"\uFE00",
		"\u200B",
		"\u202E",
		"\u2066",
		"́",
		"\u{1F469}",
		"\u{1F4BB}",
		"ا",
		"\u2800",
		"\uFEFF",
		"\u{E0041}",
		"\u001B",
		"\u00AD",
		"　",
	];
	let seed = 20261124;
	const next = () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed;
	};
	const samples = Array.from({ length: 4000 }, () =>
		Array.from({ length: 1 + (next() % 8) }, () => POOL[next() % POOL.length]).join(""),
	);

	it("名字校验认为有问题（被拒或位置不对）⇔ 单行里有要写出来的字符；第一个就是校验报告的那个位置", () => {
		let withProblem = 0;
		for (const text of samples) {
			const problem = nameProblem(text);
			const found = problem?.kind === "rejected" || problem?.kind === "misplaced";
			const segments = untrustedSegments(text, "line");
			expect(
				segments.some((s) => s.kind === "hidden"),
				JSON.stringify(text),
			).toBe(found);
			if (found && problem) {
				withProblem++;
				// 第几个字符（按码位数，从 1 起）：切出来的段里第一个写出来的字符之前有多少个码位。
				let before = 0;
				for (const segment of segments) {
					if (segment.kind === "hidden") break;
					before += Array.from(segment.text).length;
				}
				expect(before + 1, JSON.stringify(text)).toBe(problem.position);
				expect(segments.find((s) => s.kind === "hidden")).toMatchObject({
					codePoint: problem.codePoint,
				});
			}
		}
		expect(withProblem).toBeGreaterThan(500);
	});

	it("写出来之后的纯文字，名字校验不再报被拒或位置不对", () => {
		for (const text of samples) {
			for (const mode of ["line", "text"] as const) {
				const plain = untrustedPlain(text, mode);
				const problem = nameProblem(mode === "text" ? plain.replace(/[\t\n]/g, " ") : plain);
				expect(
					problem === undefined || problem.kind === "no_visible",
					JSON.stringify([text, mode]),
				).toBe(true);
			}
		}
	});
});

describe("isPlainText：普通的文字不包一层（没有要写出来的字符、没有从右到左的字母）", () => {
	it("中文、英文、数字、符号、表情、带零宽连接符的组合表情、表情的呈现方式：是普通文字", () => {
		for (const text of [
			"正常的名字",
			"worker-7 处理第 12 批，耗时 31ms（成功率 99.1%）",
			"日本語のテキスト 한국어",
			"🎉 🚀 👨‍👩‍👧 🏳️‍🌈 ❤️‍🔥 👩\u200D💻",
			"café — naïve",
			"a\u200Cb",
			"",
			"第一行\n第二行\t缩进",
		]) {
			expect(isPlainText(text, "text"), JSON.stringify(text)).toBe(true);
		}
	});

	it("从右到左书写的字母（希伯来文、阿拉伯文、波斯文、叙利亚文、塔纳文、恩科文）：不是普通文字，要隔离", () => {
		for (const text of [
			"שלום",
			"مرحبا",
			"می\u200Cخواهم",
			"ܫܠܡܐ",
			"ދިވެހި",
			"ߒߞߏ",
			"abc שלום def",
			"\uFB1D\u05D0",
			"\uFE70\uFE71",
			"\u{10800}",
			"\u{1E900}",
		]) {
			expect(isPlainText(text), JSON.stringify(text)).toBe(false);
		}
	});

	it("有要写出来的字符（方向控制字符、零宽字符、转义字符）、位置不对的例外字符：不是普通文字", () => {
		for (const text of [
			"a\u202Eb",
			"a\u200Bb",
			"a\u200Fb",
			"a\u001Bb",
			"\u200Dab",
			"a \u200Db",
			"a\uFE0F\uFE0Fb",
		]) {
			expect(isPlainText(text), JSON.stringify(text)).toBe(false);
		}
		// 多行（text）里：换行和制表符是排版，单独的回车不是
		expect(isPlainText("a\r\nb", "text")).toBe(true);
		expect(isPlainText("a\rb", "text")).toBe(false);
	});

	it("和切段一致：是普通文字 ⇔ 一段原样的文字（没有写出来的）且没有从右到左的字母；抽样 4000 个伪随机字符串里不出入", () => {
		let seed = 7;
		const next = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed;
		};
		const pool = [
			"a",
			"中",
			"🎉",
			" ",
			"\u200D",
			"\u200C",
			"\uFE0F",
			"\u202E",
			"\u200B",
			"ש",
			"م",
			"\n",
			"\t",
			"\r",
			"1",
		];
		for (let i = 0; i < 4000; i++) {
			const text = Array.from({ length: 1 + (next() % 8) }, () => pool[next() % pool.length]).join(
				"",
			);
			for (const mode of ["line", "text"] as const) {
				const rtl = /[\u0590-\u08FF]/.test(text);
				expect(isPlainText(text, mode), JSON.stringify([text, mode])).toBe(
					!rtl && !hasHidden(text, mode),
				);
			}
		}
	});
});

describe("UntrustedText 组件", () => {
	const render = (text: string, mode?: UntrustedMode) =>
		renderToStaticMarkup(createElement(UntrustedText, { text, ...(mode ? { mode } : {}) }));

	it("普通的文字（没有要写出来的字符、没有从右到左的字母）不包一层：直接是文字，和不经过组件时一样", () => {
		expect(render("正常的名字")).toBe("正常的名字");
		expect(render("worker-7 处理第 12 批 🎉")).toBe("worker-7 处理第 12 批 🎉");
		expect(render("👩\u200D💻 和 ❤\uFE0F\u200D🔥")).toBe("👩\u200D💻 和 ❤\uFE0F\u200D🔥");
	});

	it("从右到左书写的文字：包一个 <bdi dir=ltr>，基准方向是从左到右，它自己成一段，不影响旁边", () => {
		expect(render("مرحبا بالعالم")).toBe('<bdi dir="ltr">مرحبا بالعالم</bdi>');
		expect(render("שלום עולם")).toBe('<bdi dir="ltr">שלום עולם</bdi>');
		expect(render("می\u200Cخواهم")).toBe('<bdi dir="ltr">می\u200Cخواهم</bdi>');
	});

	it("以希伯来文开头、后面是中文和表情的混排文字：还是 <bdi dir=ltr>，文字原样（整行不按第一个字母翻过来）", () => {
		const html = render("שלום 世界 🎉");
		expect(html).toBe('<bdi dir="ltr">שלום 世界 🎉</bdi>');
		expect(html).not.toContain('dir="auto"');
		expect(html).not.toContain('dir="rtl"');
	});

	it("改变方向的控制字符和零宽字符：写成一小块，旁边的文字原样，输出里没有那两个字符", () => {
		const html = render("admin\u202Egpj.exe\u200B");
		expect(html).toContain('data-slot="hidden-character"');
		expect(html).toContain(">U+202E<");
		expect(html).toContain(">U+200B<");
		expect(html).toContain("admin");
		expect(html).toContain("gpj.exe");
		expect(html).not.toContain("\u202E");
		expect(html).not.toContain("\u200B");
		expect(html).toMatch(/^<bdi dir="ltr">/);
	});

	it("写出来的那一小块自己是从左到右的，并带说明", () => {
		const html = render("a\u200Fb");
		expect(html).toContain('dir="ltr"');
		expect(html).toContain("文字方向控制字符");
	});

	it("写出来的那一小块选中复制出去是带尖括号的 ⟨U+202E⟩（和属性里 untrustedPlain 的写法一致），不和原文里本来就写着的「U+202E」混；括号只给复制用（sr-only）", () => {
		const html = render("a\u202Eb");
		expect(html).toContain('<span class="sr-only">⟨</span>U+202E<span class="sr-only">⟩</span>');
		// 去掉标签就是复制出去的文字
		expect(html.replace(/<[^>]*>/g, "")).toBe("a⟨U+202E⟩b");
		expect(render("原文就写着 U+202E")).toBe("原文就写着 U+202E");
	});

	it("一整句里夹着从右到左的字母：整句是一个 <bdi dir=ltr>，从右到左的字母自己成一段", () => {
		expect(render("Agent مرحبا 不在线")).toBe('<bdi dir="ltr">Agent مرحبا 不在线</bdi>');
	});

	it("多行（text）：换行原样留在文字里，普通的文字不包一层", () => {
		expect(render("第一行\n第二行", "text")).toBe("第一行\n第二行");
		expect(render("第一行\nשלום", "text")).toBe('<bdi dir="ltr">第一行\nשלום</bdi>');
	});
});

describe("Truncate 的 untrusted 选项", () => {
	const render = (text: string, props: Record<string, unknown> = {}) =>
		renderToStaticMarkup(createElement(Truncate, { untrusted: true, ...props } as never, text));

	it("文字里没有要写出来的字符：原样，方向隔离（dir=ltr 加 unicode-bidi: isolate；不用 auto：以从右到左的字母开头的混排文字不能整行翻过来）", () => {
		const html = render("my-agent");
		expect(html).toContain("my-agent");
		expect(html).toContain('dir="ltr"');
		expect(html).not.toContain('dir="auto"');
		expect(html).toContain("[unicode-bidi:isolate]");
		expect(render("שלום 世界 🎉")).not.toContain('dir="auto"');
	});

	it("方向控制字符和零宽字符写成一小块，输出里没有那两个字符", () => {
		const html = render("admin\u202Egpj.exe\u200B");
		expect(html).toContain('data-slot="hidden-character"');
		expect(html).toContain(">U+202E<");
		expect(html).toContain(">U+200B<");
		expect(html).not.toContain("\u202E");
		expect(html).not.toContain("\u200B");
	});

	it("带 keepEnd（按字符数拆成两段，放不了组件）：写成纯文字的 ⟨U+202E⟩，读屏读的一段里也是", () => {
		const html = render("pkg\u202E/node@1.0.0", { keepEnd: 6 });
		expect(html).toContain("⟨U+202E⟩");
		expect(html).not.toContain("\u202E");
	});

	it("没传 untrusted 的 Truncate 不处理文字（只有别人写的文字才传）", () => {
		const html = renderToStaticMarkup(createElement(Truncate, {} as never, "a\u200Bb"));
		expect(html).toContain("\u200B");
	});
});
