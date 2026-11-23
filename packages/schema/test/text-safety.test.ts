// 名字里不能有的字符（src/text-safety.ts，#606）：令牌的名称、用户的显示名、写操作的昵称共用一张明确的表。
// 目标：名字不能在控制台和终端里倒着显示、藏字、换行；不是「看起来一样的名字不能并存」。
import { describe, expect, it } from "vitest";
import { AccountDisplayName } from "../src/http/accounts.js";
import { TokenName } from "../src/http/tokens.js";
import { hasUnsafeNameCharacter, unsafeNameMessage } from "../src/text-safety.js";

/** 每一项：说明、一个含有它的名字。要拒绝的整张表（照 #606 第二次审查的决定）。 */
const REJECTED: ReadonlyArray<readonly [string, string]> = [
	["NUL", "带\u0000NUL"],
	["制表符", "带\t制表"],
	["换行", "带\n换行"],
	["回车", "带\r回车"],
	["转义序列 ESC", "\u001b[31m红色\u001b[0m"],
	["DEL", "带\u007fDEL"],
	["C1 控制字符 NEL（U+0085）", "带\u0085下一行"],
	["C1 控制字符 U+009F", "带\u009f控制"],
	["行分隔符", "带\u2028行分隔符"],
	["段分隔符", "带\u2029段分隔符"],
	["从左到右标记 LRM", "带\u200e标记"],
	["从右到左标记 RLM", "带\u200f标记"],
	["阿拉伯字母标记 ALM", "带\u061c标记"],
	["从左到右嵌入 LRE", "带\u202a嵌入"],
	["从右到左嵌入 RLE", "带\u202b嵌入"],
	["弹出方向格式 PDF", "带\u202c弹出"],
	["从左到右覆盖 LRO", "带\u202d覆盖"],
	["从右到左覆盖 RLO（倒着显示）", "带\u202e倒着显示"],
	["从左到右隔离 LRI", "带\u2066隔离"],
	["从右到左隔离 RLI", "带\u2067隔离"],
	["首强隔离 FSI", "带\u2068隔离"],
	["弹出方向隔离 PDI", "带\u2069隔离"],
	["零宽空格", "带\u200b零宽空格"],
	["词连接符", "带\u2060词连接符"],
	["字节顺序标记", "带\ufeff字节顺序标记"],
	["软连字符", "带\u00ad软连字符"],
];

/** 要放行的：正常的文字和表情。 */
const ALLOWED: ReadonlyArray<readonly [string, string]> = [
	["中文", "王小明的电脑"],
	["日文", "田中さんのPC"],
	["韩文", "김철수의 컴퓨터"],
	["阿拉伯文", "حاسوب أحمد"],
	["希伯来文", "המחשב של דוד"],
	["带变音符号（预组合）", "Zoë"],
	["带变音符号（分解）", "Zoë"],
	["单个 emoji", "笔记本 💻"],
	["带肤色的 emoji", "👍🏽"],
	["国旗（区域指示符）", "🇨🇳"],
	["键帽", "1️⃣"],
	["带变体选择符的心", "❤️"],
	["零宽连接符拼出的组合表情（程序员）", "👩‍💻"],
	["零宽连接符拼出的组合表情（彩虹旗）", "🏳️‍🌈"],
	["子区域旗（英格兰，标签字符）", "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"],
	["波斯文（零宽不连字符）", "می‌خواهم"],
	["僧伽罗文（零宽连接符）", "ශ්‍රී"],
	["印地文（零宽连接符的半形）", "क्‍ष"],
	["变体选择符（表意文字的异体）", "葛\u{e0100}"],
	// 下面这些以前被「整个格式字符类别」拒绝，现在不在表里：它们要么有正当的用途，要么不在这个检查的目标里。
	["蒙古文元音分隔符（U+180E，格式字符，不在表里）", "带\u180e分隔"],
	["不可见乘号（U+2062，格式字符，不在表里）", "带\u2062乘号"],
	// 看起来一样的名字不在这个检查里：不承诺「看起来一样的不能并存」。
	["韩文填充符（看不见，不是格式字符）", "aㅤb"],
	["不换行空格", "a b"],
	["西里尔字母 а 冒充拉丁字母 a", "аdmin"],
];

describe("名字里不能有的字符（一张明确的表）", () => {
	it.each(REJECTED)("拒绝：%s", (_what, name) => {
		expect(hasUnsafeNameCharacter(name)).toBe(true);
		expect(TokenName.safeParse(name).success).toBe(false);
		expect(AccountDisplayName.safeParse(name).success).toBe(false);
	});

	it.each(ALLOWED)("放行：%s", (_what, name) => {
		expect(hasUnsafeNameCharacter(name)).toBe(false);
		expect(TokenName.safeParse(name).success).toBe(true);
		expect(AccountDisplayName.safeParse(name).success).toBe(true);
	});

	it("报错写明拒绝的是什么：令牌名称、显示名各用自己的称呼", () => {
		const token = TokenName.safeParse("带\u200b零宽");
		expect(token.success ? "" : token.error.issues[0]?.message).toBe(
			unsafeNameMessage("令牌的名称"),
		);
		const display = AccountDisplayName.safeParse("带\u200b零宽");
		expect(display.success ? "" : display.error.issues[0]?.message).toBe(
			unsafeNameMessage("显示名"),
		);
		expect(unsafeNameMessage("昵称")).toBe(
			"昵称里不能有控制字符（换行、转义序列等）、双向文字的控制字符和零宽空格这类看不见的字符",
		);
	});

	it("表之外的字符一个也没有被误拒：从 U+0000 扫到 U+10FFFF，被拒绝的恰好是表里的那些码位", () => {
		const table = new Set<number>();
		for (let c = 0x00; c <= 0x1f; c++) table.add(c);
		for (let c = 0x7f; c <= 0x9f; c++) table.add(c);
		for (const c of [0xad, 0x61c, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0x2060, 0xfeff])
			table.add(c);
		for (let c = 0x202a; c <= 0x202e; c++) table.add(c);
		for (let c = 0x2066; c <= 0x2069; c++) table.add(c);
		const rejected = new Set<number>();
		for (let c = 0; c <= 0x10ffff; c++) {
			// 代理对码位单独不是合法的字符：跳过。
			if (c >= 0xd800 && c <= 0xdfff) continue;
			if (hasUnsafeNameCharacter(String.fromCodePoint(c))) rejected.add(c);
		}
		expect([...rejected].sort((a, b) => a - b)).toEqual([...table].sort((a, b) => a - b));
	});
});
