// 昵称弹窗先用控制面同一个函数校验（`@sfly/schema` 的 `unsafeNameProblem`）：不等每个写请求都被服务端 400。
// 字符都用码位造出来，不把看不见的字符直接写在源码里。
import { describe, expect, it } from "vitest";
import { nicknameProblem } from "./nickname";

const chars = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

describe("昵称填得不合格的原因", () => {
	it("空的、只有空白：填写昵称", () => {
		expect(nicknameProblem("")).toBe("填写昵称");
		expect(nicknameProblem("   ")).toBe("填写昵称");
		// 首尾空白先去掉再看：开头是 BOM、结尾是制表符的「只有空白」也一样。
		expect(nicknameProblem(`${chars(0xfeff)}\t`)).toBe("填写昵称");
	});

	it("控制字符、双向控制字符、零宽空格：说出第几个字符、哪个码位", () => {
		expect(nicknameProblem(`小${chars(0x200b)}明`)).toContain("昵称的第 2 个字符是 U+200B");
		expect(nicknameProblem(`小${chars(0x202e)}明`)).toContain("昵称的第 2 个字符是 U+202E");
		expect(nicknameProblem("小\n明")).toContain("昵称的第 2 个字符是 U+000A");
		expect(nicknameProblem(`小${chars(0)}明`)).toContain("昵称的第 2 个字符是 U+0000");
		expect(nicknameProblem(`小${chars(0x85)}明`)).toContain("昵称的第 2 个字符是 U+0085");
	});

	it("藏字的办法：标签字符、补充的变体选择符、位置不对的零宽连接符、看起来是空的", () => {
		const tag = (text: string) => chars(...[...text].map((c) => 0xe0000 + c.charCodeAt(0)));
		expect(nicknameProblem(`小明${tag("hi")}`)).toContain("昵称的第 3 个字符是 U+E0068");
		expect(nicknameProblem(`小${chars(0xe0100)}`)).toContain("昵称的第 2 个字符是 U+E0100");
		expect(nicknameProblem(`${chars(0x200d)}小明`)).toContain("昵称的第 1 个字符是 U+200D");
		// 空白加零宽不连字符（看起来是空的）：去掉首尾空白之后它在名字开头，位置不对。
		expect(nicknameProblem(` ${chars(0x200c)}`)).toContain("昵称的第 1 个字符是 U+200C");
	});

	it("孤立的代理码元、盲文空白：说出第几个字符、哪个码位（盲文空白不是空白，trim 去不掉）", () => {
		expect(nicknameProblem(`小${chars(0xd800)}明`)).toContain("昵称的第 2 个字符是 U+D800");
		expect(nicknameProblem(`小${chars(0x2800)}明`)).toContain("昵称的第 2 个字符是 U+2800");
		// 只由盲文空白组成的昵称看起来是空的，但 trim 去不掉它：说它是哪个字符，不说「填写昵称」。
		expect(nicknameProblem(chars(0x2800))).toContain("昵称的第 1 个字符是 U+2800");
	});

	it("先去首尾空白再查表，和控制面一致：开头是 BOM、结尾是制表符的昵称，弹窗和控制面都放行", () => {
		expect(nicknameProblem(`${chars(0xfeff)}小明\t`)).toBeUndefined();
		// 里面的不行。
		expect(nicknameProblem(`小${chars(0xfeff)}明`)).toContain("U+FEFF");
	});

	it("正常的名字放行：中日韩、组合表情、带变体选择符的表情、国旗、波斯文", () => {
		for (const ok of [
			"小明",
			"田中",
			"김철수",
			chars(0x1f469, 0x200d, 0x1f4bb),
			chars(0x1f3f3, 0xfe0f, 0x200d, 0x1f308),
			chars(0x2764, 0xfe0f),
			chars(0x1f1e8, 0x1f1f3),
			`می${chars(0x200c)}خواهم`,
		]) {
			expect(nicknameProblem(ok), ok).toBeUndefined();
		}
	});
});
