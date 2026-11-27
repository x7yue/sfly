// 运行通知卡片里别人写的文字（场景名、触发人、子流程名称、节点显示名称、失败原因、出错位置）拼进 Markdown 之前要转义（#701）：
// 文字里的 Markdown 和卡片的标记在卡片上按原样显示。转义规则取自飞书开放平台文档「富文本（Markdown）」组件的「特殊字符转义说明」
// （HTML 数字实体 `&#编号;`）。纯函数，不需要控制面。
import { describe, expect, it } from "vitest";
import { escapeCardMarkdown } from "../src/feishu/messages.js";
import { type RunNotificationFacts, runNotificationCard } from "../src/feishu/run-notification.js";

/** 飞书把 `&#编号;` 显示成对应的字符：测试里照这条还原，看卡片上显示出来的是什么。 */
const rendered = (text: string): string =>
	text.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));

/** 文档里写明要转义的字符，加上 `&`。 */
const SPECIAL = "&<>~-!*/\\[]()#:+\"'`$_";

/** 去掉实体之后不能再有特殊字符：剩下的文字里没有任何一个 Markdown 或卡片标记的字符。 */
const hasNoMarkupLeft = (escaped: string): boolean =>
	![...escaped.replace(/&#\d+;/g, "")].some((char) => SPECIAL.includes(char));

describe("escapeCardMarkdown：文档里写明的特殊字符都转成数字实体", () => {
	it.each([...SPECIAL])("%s", (char) => {
		const escaped = escapeCardMarkdown(`甲${char}乙`);
		expect(escaped).toBe(`甲&#${char.charCodeAt(0)};乙`);
		expect(rendered(escaped)).toBe(`甲${char}乙`);
	});

	it("`~` 用数字实体（文档里的 `&sim;` 显示的是「∼」，不是 ASCII 的 `~`）", () => {
		expect(escapeCardMarkdown("~~删除线~~")).toBe("&#126;&#126;删除线&#126;&#126;");
		expect(escapeCardMarkdown("~")).not.toContain("&sim;");
	});

	it("`&` 先转义：文字里写着实体时显示的是这段文字本身，不被还原成字符", () => {
		expect(escapeCardMarkdown("&#42;")).toBe("&#38;&#35;42;");
		expect(rendered(escapeCardMarkdown("&#42;"))).toBe("&#42;");
	});

	it("没有特殊字符的文字原样：中文、字母、数字、空格、全角标点、「…」", () => {
		for (const plain of [
			"订单压测",
			"tester",
			"主链",
			"a b 1",
			"余额不足，请重试。（节点）",
			"超长…",
		]) {
			expect(escapeCardMarkdown(plain)).toBe(plain);
		}
	});

	it("换行、制表符等连续的空白换成一个空格：值成不了行首的标记", () => {
		expect(escapeCardMarkdown("第一行\n# 标题\r\n- 列表\t结尾")).toBe(
			"第一行 &#35; 标题 &#45; 列表 结尾",
		);
		expect(escapeCardMarkdown("a b c")).toBe("a b c");
	});
});

/** 一种标记一个样本：每种都是飞书卡片 Markdown 会解释的写法。 */
const MARKERS: Array<[name: string, text: string]> = [
	["强调", "**加粗** 和 *斜体* 和 __粗__ 和 _斜_"],
	["链接", "[点这里](https://evil.example/x) 和 ![图](https://evil.example/a.png)"],
	["自动链接", '<https://evil.example/x> 和 <a href="https://evil.example">点</a>'],
	["@所有人", '<at user_id="all">所有人</at> 和 <at id=ou_1></at>'],
	["字体颜色", "<font color=red>红色</font>"],
	["行内代码", "`rm -rf /` 和 ``` ``` ```"],
	["删除线", "~~删掉~~"],
	["标题、列表、引用", "# 标题\n- 列表\n1. 有序\n> 引用"],
	["换行和分割线", "上<br>下<hr/>"],
	["别的卡片标签", "<person id=ou_1></person><raw>x</raw><text_tag color=red>标签</text_tag>"],
	["公式和反斜杠", "$a_b$ 和 \\*not bold\\*"],
	["实体", "&#42;粗&#42; &amp; &lt;"],
];

const facts = (over: Partial<RunNotificationFacts> = {}): RunNotificationFacts => ({
	title: "订单压测",
	status: "failed",
	note: "",
	scenarioName: "订单压测",
	runId: "0123456789abcdef",
	triggeredBy: "tester",
	failure: { chain: "主链", node: "a", reason: "boom", location: null },
	runUrl: undefined,
	...over,
});

/** 卡片里所有 Markdown 元素的正文。 */
const contentsOf = (card: ReturnType<typeof runNotificationCard>): string[] => {
	if ("error" in card) throw new Error("卡片放不下");
	return card.body.card.body.elements.flatMap((e) => (e.tag === "markdown" ? [e.content] : []));
};

/** 某个标签后面的内容（`**标签**：` 之后的一行）。 */
const fieldOf = (contents: string[], label: string): string => {
	const prefix = `**${label}**：`;
	const line = contents.flatMap((c) => c.split("\n")).find((l) => l.startsWith(prefix));
	if (line === undefined) throw new Error(`卡片里没有「${label}」`);
	return line.slice(prefix.length);
};

/** 卡片上六处别人写的文字：怎么放进 facts、在哪个标签后面。 */
const FIELDS: Array<{
	name: string;
	label: string;
	put: (text: string) => RunNotificationFacts;
}> = [
	{ name: "场景名", label: "场景", put: (text) => facts({ scenarioName: text }) },
	{ name: "触发人", label: "触发人", put: (text) => facts({ triggeredBy: text }) },
	{
		name: "子流程名称（链）",
		label: "失败的节点",
		put: (text) =>
			facts({
				failure: { chain: `子流程 ${text} · 1a2b3c4d`, node: "a", reason: "", location: null },
			}),
	},
	{
		name: "节点显示名称",
		label: "失败的节点",
		put: (text) =>
			facts({ failure: { chain: "主链", node: `${text}（a）`, reason: "", location: null } }),
	},
	{
		name: "失败原因",
		label: "失败原因",
		put: (text) => facts({ failure: { chain: "主链", node: "a", reason: text, location: null } }),
	},
	{
		name: "出错位置",
		label: "出错位置",
		put: (text) => facts({ failure: { chain: "主链", node: "a", reason: "", location: text } }),
	},
];

/** 整张卡片的 Markdown 去掉实体和固定的标签粗体（`**场景**` 这几个）之后剩下的文字。 */
const withoutFixedMarkup = (contents: string[]): string =>
	contents
		.join("\n")
		.replace(/&#\d+;/g, "")
		.replace(/\*\*[^*\n]+\*\*/g, "");

describe("运行通知的卡片：每一处别人写的文字里放一种标记，卡片上按原样显示", () => {
	for (const field of FIELDS) {
		describe(field.name, () => {
			it.each(MARKERS)("%s", (_name, marker) => {
				const contents = contentsOf(runNotificationCard(field.put(marker)));
				// 卡片上显示出来的文字就是原文（换行换成了空格）……
				expect(rendered(fieldOf(contents, field.label))).toContain(marker.replace(/\s+/g, " "));
				// ……而且整张卡片里，实体之外只有固定的标签粗体，没有任何一个 Markdown 或卡片标记的字符。
				expect(hasNoMarkupLeft(withoutFixedMarkup(contents))).toBe(true);
			});
		});
	}

	it("场景名、触发人里的 `**`：整张卡片除了固定的标签粗体，没有别的 `*`", () => {
		const contents = contentsOf(
			runNotificationCard(facts({ scenarioName: "**伪造**", triggeredBy: "*x*" })),
		);
		// 固定的标签：场景、运行编号、触发人、失败的节点、失败原因，每个一对 `**`。
		expect(contents.join("\n").replace(/&#42;/g, "").match(/\*/g)).toHaveLength(5 * 4);
	});
});

describe("运行通知的卡片：正常的通知和以前一样", () => {
	it("没有特殊字符的文字：卡片的 Markdown 和转义之前逐字相同", () => {
		expect(contentsOf(runNotificationCard(facts()))).toEqual([
			["**场景**：订单压测", "**运行编号**：01234567", "**触发人**：tester"].join("\n"),
			["**失败的节点**：主链：a", "**失败原因**：boom"].join("\n"),
		]);
	});

	it("有特殊字符时卡片上显示的和以前一样（还原实体之后逐字相同）", () => {
		const contents = contentsOf(
			runNotificationCard(
				facts({
					scenarioName: "订单-压测(A 环境)",
					failure: {
						chain: "子流程 压测 · 1a2b3c4d",
						node: "创建用户（create_user）",
						reason: "ValueError: 余额不足 (code=402)",
						location: "pay.py:3",
					},
				}),
			),
		);
		expect(contents.map(rendered)).toEqual([
			["**场景**：订单-压测(A 环境)", "**运行编号**：01234567", "**触发人**：tester"].join("\n"),
			[
				"**失败的节点**：子流程 压测 · 1a2b3c4d：创建用户（create_user）",
				"**失败原因**：ValueError: 余额不足 (code=402)",
				"**出错位置**：pay.py:3",
			].join("\n"),
		]);
	});

	it("附加说明是用户写的 Markdown：不转义（飞书卡片的标记写在里面是有意的）", () => {
		const note = "环境 A，负责人 <at id=ou_1></at>，**重点**";
		expect(contentsOf(runNotificationCard(facts({ note })))[0]).toBe(note);
	});
});

describe("运行通知的卡片：先按原文截断、再转义（不会把一个转义切成两半）", () => {
	const reasonOf = (reason: string) =>
		fieldOf(
			contentsOf(
				runNotificationCard(
					facts({ failure: { chain: "主链", node: "a", reason, location: null } }),
				),
			),
			"失败原因",
		);

	it("原文第 300 个字符是特殊字符：留下完整的实体，再接「…」", () => {
		const shown = reasonOf(`${"*".repeat(305)}`);
		expect(shown).toBe(`${"&#42;".repeat(300)}…`);
		// 每一个实体都是完整的：去掉实体之后什么也不剩，只有「…」。
		expect(shown.replace(/&#\d+;/g, "")).toBe("…");
	});

	it("按原文的字符数截（300），不按转义之后的字数；补充平面的字符不会被截成两半", () => {
		const mixed = `${"错:".repeat(150)}${"尾".repeat(10)}`;
		const shown = reasonOf(mixed);
		expect(rendered(shown)).toBe(`${[...mixed].slice(0, 300).join("")}…`);
		const astral = reasonOf("𠮷".repeat(301));
		expect(astral).toBe(`${"𠮷".repeat(300)}…`);
	});

	it("恰好 300 个字符不截断", () => {
		expect(rendered(reasonOf("-".repeat(300)))).toBe("-".repeat(300));
	});
});
