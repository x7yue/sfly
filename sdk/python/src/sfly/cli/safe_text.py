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

import json
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

# 串序列（OSC、DCS、SOS、PM、APC）的正文里不会有的字符：换行、ESC、各个 C1 引导字符和结尾符。
# 正文只能是这些以外的字符，所以一个没有结尾的开头只会「吃」到下一个这样的字符为止，
# 不会越过换行把后面的日志行吃掉（#670 复审）。
_STRING_BODY_STOP = r"\x1b\x90\x98\x9c\x9d\x9e\x9f\n\r"

# 完整的转义序列，7 位（ESC 开头）和 8 位（U+0080–U+009F 开头）的写法都认。
# **串序列必须有结尾才整段去掉**，没有结尾的不删：留给第二遍写成 `\\uXXXX`，
# 后面的文字一个字也不能少。
_ESCAPE_SEQUENCE = re.compile(
    "|".join(
        [
            # OSC（改窗口标题、写剪贴板、超链接……）：到 BEL 或 ST 结束。
            rf"(?:\x1b\]|\x9d)[^\x07{_STRING_BODY_STOP}]*(?:\x07|\x1b\\|\x9c)",
            # DCS、SOS、PM、APC：到 ST 结束。
            rf"(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^{_STRING_BODY_STOP}]*(?:\x1b\\|\x9c)",
            # CSI（光标移动、清屏、颜色……）：参数和中间字节有界，结尾字节可以缺。
            r"(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?",
            # 其它 ESC 序列（两个字节，或带中间字节）；
            # 串序列的开头（] P X ^ _）和 CSI 的开头（[）不在这里。
            r"\x1b[ -/]*[0-OQ-WYZ\\`a-~]",
        ]
    )
)

# 零宽连接符、零宽不连字符、变体选择符：不在表里（表情和波斯文、印地文要用），但名字的规则要求
# 它们紧跟在一个看得见的字符后面（`packages/schema/src/text-safety.ts` 的 `nameProblem`），
# 这里照同一条规则：不合位置的写成 `\\uXXXX`。
_EXCEPTION = re.compile("[\u200c\u200d\ufe00-\ufe0f]")
_ZERO_WIDTH_JOINER = "\u200d"


def _is_white_space(char: str) -> bool:
    """Unicode 的 White_Space 属性：`str.isspace()` 另外还认 U+001C–U+001F（在表里，单独处理）。"""
    return char.isspace() and not "\x1c" <= char <= "\x1f"


def _is_exception(char: str) -> bool:
    return _EXCEPTION.fullmatch(char) is not None


def _is_visible_base(char: str) -> bool:
    """看得见的字符：不在表里、不是三个例外、不是空白。

    空白之后的状态和开头一样，例外不能挂在空白上。"""
    return (
        char != ""
        and _UNSAFE.fullmatch(char) is None
        and not _is_exception(char)
        and not _is_white_space(char)
    )


def misplaced_exceptions(text: str) -> list[int]:
    """文字里位置不对的零宽连接符、零宽不连字符、变体选择符的下标（从 0 起）。

    和 `nameProblem` 同一条规则（`packages/schema/test/name-position-cases.json` 两头对照）：
    它们必须紧跟在一个看得见的字符后面；零宽连接符前面也可以是紧跟在看得见的字符后面的那一个
    变体选择符（表情序列）；不能在开头、不能连着出现、不能接在空白后面；变体选择符一个字符后面
    最多一个，它后面只能接零宽连接符。结尾的例外照旧放行。
    """
    found: list[int] = []
    for match in _EXCEPTION.finditer(text):
        index = match.start()
        previous = text[index - 1] if index > 0 else ""
        if _is_visible_base(previous):
            continue
        after_variation = (
            match.group() == _ZERO_WIDTH_JOINER
            and "\ufe00" <= previous <= "\ufe0f"
            and index > 1
            and _is_visible_base(text[index - 2])
        )
        if not after_variation:
            found.append(index)
    return found


def _hex_escape(char: str) -> str:
    code = ord(char)
    return f"\\u{code:04x}" if code <= 0xFFFF else f"\\U{code:08x}"


def _escape_misplaced(text: str) -> str:
    if _EXCEPTION.search(text) is None:
        return text
    bad = misplaced_exceptions(text)
    if not bad:
        return text
    pieces: list[str] = []
    last = 0
    for index in bad:
        pieces.append(text[last:index])
        pieces.append(_hex_escape(text[index]))
        last = index + 1
    pieces.append(text[last:])
    return "".join(pieces)


def _escaped(match: re.Match[str]) -> str:
    char = match.group()
    return char if char in _KEEP else _hex_escape(char)


def printable(text: str) -> str:
    """服务端的文字打到终端之前：去掉完整的转义序列，其余不该到终端的字符（含位置不对的零宽连接符这类）
    写成 `\\uXXXX`。"""
    return _UNSAFE.sub(_escaped, _escape_misplaced(_ESCAPE_SEQUENCE.sub("", text)))


def _json_escaped(match: re.Match[str]) -> str:
    return _json_escape_char(match.group())


def _json_escape_char(char: str) -> str:
    code = ord(char)
    if code <= 0xFFFF:
        return f"\\u{code:04x}"
    code -= 0x10000
    return f"\\u{0xD800 + (code >> 10):04x}\\u{0xDC00 + (code & 0x3FF):04x}"


def json_safe(dumped: str) -> str:
    """一段 JSON 文本里，字符串中不该到终端的字符写成 JSON 的转义（`\\uXXXX`，补充平面的写成
    代理对）：解析回来和原来一模一样。JSON 本身只转义 U+0000–U+001F，其余的（U+0080–U+009F、
    双向控制字符……）不处理的话照样原样打到终端上。位置不对的零宽连接符这类在字符串里才分得出
    位置，由 `dump_json_safe` 处理。"""
    return _UNSAFE.sub(_json_escaped, dumped)


_JSON_SHORT_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
    "\b": "\\b",
    "\f": "\\f",
}


def _json_string(text: str) -> str:
    """一个字符串写成 JSON：和 `json.dumps(ensure_ascii=False)` 一样，另外表里的字符和位置不对的
    零宽连接符这类写成转义。"""
    misplaced = set(misplaced_exceptions(text))
    pieces = ['"']
    for index, char in enumerate(text):
        if char in _JSON_SHORT_ESCAPES:
            pieces.append(_JSON_SHORT_ESCAPES[char])
        elif index in misplaced or _UNSAFE.fullmatch(char) is not None:
            pieces.append(_json_escape_char(char))
        else:
            pieces.append(char)
    pieces.append('"')
    return "".join(pieces)


def _json_key(key: object) -> str:
    if isinstance(key, str):
        return key
    if key is True:
        return "true"
    if key is False:
        return "false"
    if key is None:
        return "null"
    if isinstance(key, (int, float)):
        return json.dumps(key)
    raise TypeError(f"keys must be str, int, float, bool or None, not {type(key).__name__}")


def _json_value(value: object) -> str:
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(f"{_json_string(_json_key(k))}:{_json_value(v)}" for k, v in value.items())
            + "}"
        )
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_json_value(item) for item in value) + "]"
    return json.dumps(value)


def dump_json_safe(value: object) -> str:
    """精简 JSON：一行，不转义中文；表里的字符和位置不对的零宽连接符这类写成 JSON 的转义，
    解析回来和原来一模一样。

    先用标准库写；没有零宽连接符这类（绝大多数输出）时只过一遍 `json_safe`，快；有的时候
    才自己写，因为它们该不该转义要看在字符串里的位置，在已经写好的 JSON 文本里分不出
    哪个引号是字符串的开头。"""
    dumped = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if _EXCEPTION.search(dumped) is None:
        return json_safe(dumped)
    return _json_value(value)
