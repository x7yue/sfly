"""命令行打印服务端的文字之前先过一遍（#670）：控制字符、终端的转义序列、看不见的字符不到终端上。

服务端的文字里有客户端自己报的、没有人看过的：「经 ……」的名称、昵称、Agent 报的名称和
版本，节点写进日志的内容，库里升级之前存下的旧值。它们原样打到终端上，一个转义序列就能
改写屏幕上已经显示的内容、改窗口标题、藏起一段话；读命令行输出的 AI 助手读到的是同一段
文字，看不见的字符能往它的上下文里塞话。所以这里统一处理：

- 完整的转义序列（CSI、OSC、DCS、SOS、PM、APC 和两个字节的 ESC 序列，含 8 位的写法
  U+009B 等）整段去掉；
- 剩下的控制字符、双向文字的控制字符、零宽空格这类看不见的字符、孤立的代理码元，写成
  看得见的 `\\uXXXX`（不悄悄吞掉，读的人看得出这里原来有东西）；换行和制表符保留
  （多行的文字要用）。

字符表和 `packages/schema/src/text-safety.ts` 的 `REJECTED_NAME_CHARACTER` 是同一张（名字
写入时拒绝的就是这些），测试从那个文件里读出来逐个码位对照，不会各改各的。零宽连接符、
零宽不连字符和变体选择符不在表里：表情和波斯文、印地文要用。
"""

from __future__ import annotations

import re

# 和 text-safety.ts 同一张表的码位范围：C0、DEL、C1，行分隔符和段分隔符，默认可忽略的码位
# （去掉零宽连接符、零宽不连字符、变体选择符），盲文空白，行间注释的锚点和埃及象形文字的格式控制，
# 孤立的代理码元。
UNSAFE_RANGES: tuple[tuple[int, int], ...] = (
    (0x00, 0x1F),
    (0x7F, 0x9F),
    (0xAD, 0xAD),
    (0x34F, 0x34F),
    (0x61C, 0x61C),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x200B, 0x200B),
    (0x200E, 0x200F),
    (0x2028, 0x202E),
    (0x2060, 0x206F),
    (0x2800, 0x2800),
    (0x3164, 0x3164),
    (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFFB),
    (0x13430, 0x1343F),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
    (0xD800, 0xDFFF),
)

# 多行的文字（日志、摘要）要保留的两个控制字符。
_KEEP = frozenset("\t\n")

_UNSAFE = re.compile("[" + "".join(f"\\U{lo:08x}-\\U{hi:08x}" for lo, hi in UNSAFE_RANGES) + "]")

# 完整的转义序列。无论 7 位（ESC 开头）还是 8 位（U+0080–U+009F 开头）的写法；没有结尾的
# （被截断的、故意不写结尾的）一直吃到文字结束或下一个 ESC：它后面的东西本来就是被它
# 「吃掉」的。
_ESCAPE_SEQUENCE = re.compile(
    "|".join(
        [
            # OSC（改窗口标题、写剪贴板、超链接……）：到 BEL 或 ST 结束。
            r"(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?",
            # DCS、SOS、PM、APC：到 ST 结束。
            r"(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c)?",
            # CSI（光标移动、清屏、颜色……）。
            r"(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?",
            # 其它 ESC 序列（两个字节，或带中间字节）。
            r"\x1b[ -/]*[0-~]?",
        ]
    )
)


def _escaped(match: re.Match[str]) -> str:
    char = match.group()
    if char in _KEEP:
        return char
    code = ord(char)
    return f"\\u{code:04x}" if code <= 0xFFFF else f"\\U{code:08x}"


def printable(text: str) -> str:
    """服务端的文字打到终端之前：去掉转义序列，其余不该到终端的字符写成 `\\uXXXX`。"""
    return _UNSAFE.sub(_escaped, _ESCAPE_SEQUENCE.sub("", text))


def _json_escaped(match: re.Match[str]) -> str:
    code = ord(match.group())
    if code <= 0xFFFF:
        return f"\\u{code:04x}"
    code -= 0x10000
    return f"\\u{0xD800 + (code >> 10):04x}\\u{0xDC00 + (code & 0x3FF):04x}"


def json_safe(dumped: str) -> str:
    """一段 JSON 文本里，字符串中不该到终端的字符写成 JSON 的转义（`\\uXXXX`，补充平面的写成
    代理对）：解析回来和原来一模一样。JSON 本身只转义 U+0000–U+001F，其余的（U+0080–U+009F、
    双向控制字符……）不处理的话照样原样打到终端上。"""
    return _UNSAFE.sub(_json_escaped, dumped)
