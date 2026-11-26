import { describe, expect, it } from "vitest";
import { collapseBlankLines, stripTerminalSequences, terminalOutputText } from "./terminal-text";

const ESC = "\u001b";

describe("去掉终端的控制序列（只改显示，不改存的数据）", () => {
	// 这张表就是「覆盖的序列」：每一行是一种写法，整段去掉，不留 `[31m` 这类残文。
	const COVERED: [name: string, input: string, shown: string][] = [
		["颜色：前景色", `${ESC}[31mred${ESC}[0m`, "red"],
		["颜色：多个参数", `${ESC}[1;32mbold green${ESC}[0m`, "bold green"],
		["颜色：不带参数的复位", `${ESC}[mplain`, "plain"],
		["颜色：256 色", `${ESC}[38;5;196mred${ESC}[39m`, "red"],
		["颜色：真彩色（冒号分隔）", `${ESC}[38:2::1:2:3mx${ESC}[0m`, "x"],
		["光标：上移一行", `${ESC}[1Ax`, "x"],
		["光标：定位", `${ESC}[12;40Hx`, "x"],
		["清除：整行", `${ESC}[2Kx`, "x"],
		["清除：到行尾", `${ESC}[Kx`, "x"],
		["私有模式：隐藏光标", `${ESC}[?25lx${ESC}[?25h`, "x"],
		["带中间字节的 CSI（光标样式）", `${ESC}[2 qx`, "x"],
		["OSC：窗口标题，用响铃结束", `${ESC}]0;window title\u0007x`, "x"],
		["OSC：窗口标题，用 ST（ESC \\）结束", `${ESC}]2;window title${ESC}\\x`, "x"],
		[
			"OSC：超链接，链接文字留着",
			`${ESC}]8;;http://example.com${ESC}\\link${ESC}]8;;${ESC}\\`,
			"link",
		],
		["DCS", `${ESC}Pq#0;2;0;0;0${ESC}\\x`, "x"],
		["APC", `${ESC}_Gi=1;payload${ESC}\\x`, "x"],
		["PM", `${ESC}^privacy${ESC}\\x`, "x"],
		["SOS", `${ESC}Xstring${ESC}\\x`, "x"],
		["指定字符集", `${ESC}(Bx`, "x"],
		["单个字符的转义：重置终端", `${ESC}cx`, "x"],
		["单个字符的转义：小键盘模式", `${ESC}=x`, "x"],
		["单个字符的转义：反向换行", `${ESC}Mx`, "x"],
		["8 位的 CSI（U+009B）", "\u009b31mx\u009b0m", "x"],
		["8 位的 OSC（U+009D）用 ST（U+009C）结束", "\u009d0;title\u009cx", "x"],
	];

	for (const [name, input, shown] of COVERED) {
		it(`${name}：整段去掉，不留残文`, () => {
			expect(stripTerminalSequences(input)).toBe(shown);
		});
	}

	it("夹在文字中间的颜色码去掉，文字原样", () => {
		expect(stripTerminalSequences(`ok ${ESC}[31mFAILED${ESC}[0m tests/a.py::t\n`)).toBe(
			"ok FAILED tests/a.py::t\n",
		);
	});

	it("没有转义序列的文字原样返回（同一个字符串）", () => {
		const text = "命令输出\n第二行\ttab\n";
		expect(stripTerminalSequences(text)).toBe(text);
	});

	it("超链接只去掉两头的控制序列，链接文字和地址之外的内容留着", () => {
		expect(
			stripTerminalSequences(
				`${ESC}]8;;http://example.com${ESC}\\link text${ESC}]8;;${ESC}\\ after`,
			),
		).toBe("link text after");
	});

	it("没有结束的字符串类序列（OSC 等）不吞掉后面的文字：ESC 留着，由不可信文字组件写出来", () => {
		const text = `${ESC}]0;never ended\nnext line`;
		expect(stripTerminalSequences(text)).toBe(text);
	});

	it("中断的 CSI（参数里夹了换行）不去掉，也不吞掉后面的文字", () => {
		const text = `${ESC}[31\nnext`;
		expect(stripTerminalSequences(text)).toBe(text);
	});

	it("末尾被截断的半截序列（没有结束字节）去掉", () => {
		expect(stripTerminalSequences(`done${ESC}[3`)).toBe("done");
		expect(stripTerminalSequences(`done${ESC}`)).toBe("done");
	});

	it("其余的控制字符（响铃、退格、回车）不在这里处理：留给不可信文字组件写成可见的占位", () => {
		expect(stripTerminalSequences("a\u0007b\bc\rd")).toBe("a\u0007b\bc\rd");
	});

	it("很长的文字没有序列时一次扫描就返回，不逐字符处理", () => {
		const text = "x".repeat(2_000_000);
		expect(stripTerminalSequences(text)).toBe(text);
	});
});

describe("连续的空行压成一个（只改显示）", () => {
	it("两个以上连续的空行压成一个：失败命令的输出以换行结尾，再接上一行空行和退出说明时不多出空白", () => {
		expect(collapseBlankLines("stderr line\n\n\nCommand exited with code 3")).toBe(
			"stderr line\n\nCommand exited with code 3",
		);
		expect(collapseBlankLines("a\n\n\n\n\nb")).toBe("a\n\nb");
	});

	it("一个空行原样留着；输出里本来就有的单个空行不动", () => {
		expect(collapseBlankLines("a\n\nb\n")).toBe("a\n\nb\n");
	});

	it("只由空白组成的行也算空行（行尾空格、回车）", () => {
		expect(collapseBlankLines("a\n  \n\t\n\nb")).toBe("a\n\nb");
		expect(collapseBlankLines("a\r\n\r\n\r\nb")).toBe("a\r\n\r\nb");
	});

	it("结尾的空行也压：多个换行结尾的输出留一个空行", () => {
		expect(collapseBlankLines("a\n\n\n\n")).toBe("a\n\n");
	});
});

describe("工具输出显示前的整理", () => {
	it("先去掉控制序列，再压空行；顺序反过来的话颜色码夹着的空行压不掉", () => {
		expect(terminalOutputText(`${ESC}[31merr${ESC}[0m\n${ESC}[0m\n\n${ESC}[0mCommand exited`)).toBe(
			"err\n\nCommand exited",
		);
	});
});
