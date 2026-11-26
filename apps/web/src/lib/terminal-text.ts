/**
 * 命令输出显示之前的整理（#550）。**只改显示，不改存的数据**：存下来的、复制出去的都是原文；这里算出来的只给页面画在屏幕上。
 *
 * 命令的输出是终端的输出：颜色码（`ESC[31m`）、光标移动、窗口标题这些控制序列在终端里是「不显示的指令」，页面不是终端，它们
 * 只会变成噪音。页面以前只把单独的 ESC 写成一小块（不可信文字组件，#707），后面的 `[31m` 原样露在输出里，比原样显示整段序列
 * 更难看出是什么。现在**整段**序列先去掉；去掉之后剩下的其余控制字符（响铃、退格、单独的回车……）照旧由不可信文字组件
 * （`UntrustedText mode="text"`）写成可见的占位，文字里藏的方向控制字符、零宽字符同样。两层各管各的：这一层只认终端序列的语法。
 *
 * 覆盖的序列（`terminal-text.test.ts` 逐种列出）：
 * - CSI：`ESC [`（或 8 位的 U+009B）、参数（`0-?`）、中间字节（空格到 `/`）、结束字节（`@` 到 `~`）：颜色（SGR，含 256 色和真彩色）、
 *   光标移动和定位、清屏清行、私有模式（隐藏光标……）、光标样式；
 * - 字符串类：OSC（窗口标题、超链接）、DCS、SOS、PM、APC，用响铃（只有 OSC）或 ST（`ESC \` 或 U+009C）结束，8 位的开头
 *   （U+009D、U+0090、U+0098、U+009E、U+009F）同样；超链接只去掉两头的序列，链接文字留着；
 * - 单个字符的转义：`ESC` 加可有可无的中间字节加一个结束字节（指定字符集 `ESC ( B`、重置 `ESC c`、小键盘模式 `ESC =`、反向换行 `ESC M`……）；
 * - 末尾被截断的半截序列（没有结束字节）。
 *
 * **认不全的不去掉**：没有结束符的字符串类序列、参数里夹了别的控制字符的 CSI 不去掉（不吞掉后面的文字），ESC 留着，由不可信文字组件
 * 写出来：宁可多露一个占位，也不让一个没写完的序列把后面的输出吃掉。
 */

/** 字符串类序列的内容最长多少个字符：真实的标题和链接都远小于它；有上限才不会让没有结束符的开头每个都扫到文字末尾。 */
const STRING_BODY_MAX = 8192;

const ST = "(?:\\u001b\\\\|\\u009c)";
const STRING_BODY = `[^\\u001b\\u009c]{0,${STRING_BODY_MAX}}?`;

/**
 * 一段序列的写法，按先后：① 字符串类（OSC 可以用响铃结束）；② CSI；③ 末尾没写完的（没有结束字节的 CSI、没有结束符又不跨行的
 * 字符串类、单独的 ESC）；④ 单个字符的转义（不含 `[ ] P X ^ _`：它们是上面几种的开头）。
 */
const SEQUENCE = new RegExp(
	[
		`(?:\\u001b\\]|\\u009d)[^\\u001b\\u009c\\u0007]{0,${STRING_BODY_MAX}}?(?:\\u0007|${ST})`,
		`(?:\\u001b[PX^_]|[\\u0090\\u0098\\u009e\\u009f])${STRING_BODY}${ST}`,
		"(?:\\u001b\\[|\\u009b)[\\u0030-\\u003f]*[\\u0020-\\u002f]*[\\u0040-\\u007e]",
		"\\u001b(?:\\[[\\u0030-\\u003f]*[\\u0020-\\u002f]*)?$",
		"(?:\\u001b[\\]PX^_]|[\\u009d\\u0090\\u0098\\u009e\\u009f])[^\\n\\u001b\\u009c\\u0007]*$",
		"\\u001b[\\u0020-\\u002f]*[\\u0030-\\u004f\\u0051-\\u0057\\u0059\\u005a\\u005c\\u0060-\\u007e]",
	].join("|"),
	"g",
);

/** 文字里有没有可能是序列的开头（ESC，或 8 位的 C1 控制字符）：没有的（几乎所有的文字）不跑上面那条正则。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 终端序列的开头本来就是控制字符（ESC 和 8 位的 C1）
const MAY_HAVE_SEQUENCE = /[\u001b\u0080-\u009f]/;

/** 去掉终端的控制序列（见文件开头的清单）。没有序列的文字原样返回（同一个字符串）。 */
export function stripTerminalSequences(text: string): string {
	if (!MAY_HAVE_SEQUENCE.test(text)) return text;
	return text.replace(SEQUENCE, "");
}

/** 连着的几个空行（只有空白的行）。 */
const BLANK_RUN = /(?:[ \t]*\r?\n){3,}/g;
const LINE_BREAK = /\r?\n/g;

/**
 * 连续的空行压成一个。失败命令的输出常常以换行结尾，后面再接一行空行和「退出码」的说明，页面上就多出两行空白；
 * 输出里有意的单个空行不动。只压显示：存的、复制出去的仍是原文。
 */
export function collapseBlankLines(text: string): string {
	return text.replace(BLANK_RUN, (run) => {
		const breaks = run.match(LINE_BREAK) as RegExpMatchArray;
		return `${breaks[0]}${breaks[1]}`;
	});
}

/** 工具输出画在屏幕上之前的整理：先去掉控制序列（颜色码夹着的空行才看得出是空行），再压空行。 */
export const terminalOutputText = (text: string): string =>
	collapseBlankLines(stripTerminalSequences(text));
