"""命令行打印服务端的文字之前先过一遍（#670）：控制字符、终端的转义序列、看不见的字符不到终端上。

服务端的文字里有客户端自己报的、没有人看过的：「经 ……」的名称、昵称、Agent 报的名称和
版本，节点写进日志的内容，库里升级之前存下的旧值。它们原样打到终端上，一个转义序列就能
改写屏幕上已经显示的内容、改窗口标题、藏起一段话；读命令行输出的 AI 助手读到的是同一段
文字，看不见的字符能往它的上下文里塞话。所以这里统一处理：

- **只整段去掉两种序列：CSI（颜色、光标移动、清屏……，`ESC [` 或 U+009B 开头）和两个字节的
  ESC 序列。** 它们的参数只能是数字和标点，吃不了任意文字：一个没写完的 CSI 最多带走紧跟着的一小段
  数字和标点再加一个字符，而且只在同一行里（`[0-?]*[ -/]*[@-~]?` 不含换行）。
- **串序列（OSC、DCS、SOS、PM、APC，7 位 `ESC ]` 等和 8 位 U+009D 等的写法）不整段去掉。** 它们的
  正文可以是任意文字：整段去掉就等于给了写的人一把删别人文字的工具（在 JSON 里记录之间没有换行，
  一个节点写一个开头、另一个节点写一个结尾，夹在中间的别人的记录就没了）。开头和结尾像别的不该到
  终端的字符一样写成看得见的 `\\uXXXX`，正文留着：终端收不到能用的序列，没有东西被藏掉；日志里合法的
  超链接、改标题会显示成带转义的原文，难看但没有东西被藏掉；
- 剩下的控制字符、双向文字的控制字符、零宽空格这类看不见的字符、孤立的代理码元，写成
  看得见的 `\\uXXXX`（不悄悄吞掉，读的人看得出这里原来有东西）；换行和制表符保留
  （多行的文字要用）；
- 正文是 JSON 的（`sfly api` 在终端上显示的响应和事件流里 `data:` 的内容）走 `dump_json_safe`：
  只转义、不删任何东西，解析回来和原文相等（见 `json_text_safe`）。

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

# 整段去掉的转义序列，7 位（ESC 开头）和 8 位（U+009B）的写法都认，只有两种（#691 复审）：
# 串序列（OSC、DCS、SOS、PM、APC）的正文可以是任意文字，整段去掉能删别人的记录，不在这里，
# 留给第二遍写成 `\\uXXXX`。下面两种的参数只能是数字和标点：一个没写完的 CSI 最多带走后面紧跟的
# 一小段（`0-?` 的数字和标点、` -/` 的中间字节）再加一个字符，不含换行，所以只在同一行里；
# 两个字节的 ESC 序列只带走一个字符。
_ESCAPE_SEQUENCE = re.compile(
    "|".join(
        [
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
    """服务端的文字打到终端之前：整段去掉的只有 CSI 和两个字节的 ESC 序列（颜色、光标移动、清屏），
    其余不该到终端的字符（含串序列的开头和结尾、位置不对的零宽连接符这类）写成 `\\uXXXX`，
    文字都留着。"""
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


class _Raw:
    """已经写好的一段 JSON 文本（括号、逗号、键）。"""

    __slots__ = ("text",)

    def __init__(self, text: str) -> None:
        self.text = text


class _Leave:
    """一个容器写完了：从「正在写的容器」里去掉它（查循环引用用）。"""

    __slots__ = ("container",)

    def __init__(self, container: int) -> None:
        self.container = container


def _json_text(value: object) -> str:
    """把一个值写成精简 JSON，字符串走 `_json_string`。不递归（嵌套多深都行，标准库那条路也是）：
    用一个栈，先进后出，所以按相反的顺序压。"""
    pieces: list[str] = []
    stack: list[object] = [value]
    open_containers: set[int] = set()
    while stack:
        item = stack.pop()
        if isinstance(item, _Raw):
            pieces.append(item.text)
        elif isinstance(item, _Leave):
            open_containers.discard(item.container)
        elif isinstance(item, str):
            pieces.append(_json_string(item))
        elif isinstance(item, (dict, list, tuple)):
            if id(item) in open_containers:
                raise ValueError("Circular reference detected")
            open_containers.add(id(item))
            entries: list[tuple[_Raw | None, object]]
            if isinstance(item, dict):
                opening, closing = "{", "}"
                entries = [(_Raw(f"{_json_string(_json_key(k))}:"), v) for k, v in item.items()]
            else:
                opening, closing = "[", "]"
                entries = [(None, v) for v in item]
            pieces.append(opening)
            stack.append(_Raw(closing))
            stack.append(_Leave(id(item)))
            for index in range(len(entries) - 1, -1, -1):
                key, entry = entries[index]
                stack.append(entry)
                if key is not None:
                    stack.append(key)
                if index > 0:
                    stack.append(_Raw(","))
        else:
            pieces.append(json.dumps(item))
    return "".join(pieces)


def dump_json_safe(value: object) -> str:
    """精简 JSON：一行，不转义中文；表里的字符和位置不对的零宽连接符这类写成 JSON 的转义，
    解析回来和原来一模一样。

    先用标准库写；没有零宽连接符这类（绝大多数输出）时只过一遍 `json_safe`，快；有的时候
    才自己写（不递归），因为它们该不该转义要看在字符串里的位置，在已经写好的 JSON 文本里分不出
    哪个引号是字符串的开头。"""
    dumped = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if _EXCEPTION.search(dumped) is None:
        return json_safe(dumped)
    return _json_text(value)


def json_text_safe(text: str) -> str | None:
    """正文是一段 JSON 文本时，写成安全的 JSON：表里的字符和位置不对的零宽连接符这类写成
    JSON 的转义，**不删任何东西**（不去掉任何转义序列，包括颜色），输出解析回来和原文相等。
    `sfly api` 在终端上显示控制面的响应和事件流里的 `data:` 用它：这些 JSON 是一行，记录之间没有
    换行，任何「整段去掉」都能删掉夹在中间的别人的记录。不是合法的 JSON（解析不了，或者嵌套
    太深）时返回 None，调用方按普通文字处理（`printable`）。"""
    try:
        value = json.loads(text)
    except (ValueError, RecursionError):
        return None
    return dump_json_safe(value)
