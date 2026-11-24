"""命令行打印服务端的文字之前先过一遍（#670）：转义序列去掉，不该到终端的字符写成看得见的转义，
JSON 里同样；表和控制面写入时拒绝名字的那张表（packages/schema/src/text-safety.ts）是同一张。

不该到终端的字符都用码位造出来，不把它们直接写在源码里。
"""

from __future__ import annotations

import io
import json
import random
import re
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from sfly.cli import api
from sfly.cli.client import Client
from sfly.cli.errors import CliError
from sfly.cli.output import Output, actor_label, dump_json, via_label
from sfly.cli.run_exec import _progress
from sfly.cli.run_logs import print_notes
from sfly.cli.safe_text import (
    UNSAFE_RANGES,
    dump_json_safe,
    json_safe,
    misplaced_exceptions,
    printable,
)
from sfly.cli.session import Session

ESC = chr(0x1B)
BEL = chr(0x07)
CSI8 = chr(0x9B)
ST8 = chr(0x9C)
ZWSP = chr(0x200B)
RLO = chr(0x202E)
NEL = chr(0x85)
TAG_G = chr(0xE0067)
LONE = chr(0xD800)

_UNSAFE_CODES = {code for lo, hi in UNSAFE_RANGES for code in range(lo, hi + 1)}


def _unsafe_in(text: str) -> list[str]:
    """文字里不该到终端的字符（换行和制表符除外）。"""
    return [hex(ord(c)) for c in text if ord(c) in _UNSAFE_CODES and c not in "\t\n"]


_TOKEN = re.compile(
    r"\\p\{Cc\}"
    r"|\\u\{([0-9A-Fa-f]+)\}(?:-\\u\{([0-9A-Fa-f]+)\})?"
    r"|\\u([0-9A-Fa-f]{4})(?:-\\u([0-9A-Fa-f]{4}))?"
)


def _parse_rejected_class(content: str) -> set[int]:
    """TypeScript 里那个正则字符类的内容解析成码位集合。整个字符类都要解析完：有不认识的写法
    （比如以后加一个 `\\p{Cf}`）就失败，不能悄悄跳过让两头的表分道扬镳。"""
    codes: set[int] = set()
    position = 0
    while position < len(content):
        token = _TOKEN.match(content, position)
        assert token, (
            f"text-safety.ts 的字符类里有这里不认识的写法：{content[position : position + 20]!r}"
        )
        position = token.end()
        if token.group(0) == r"\p{Cc}":
            codes.update(range(0x00, 0x20))
            codes.update(range(0x7F, 0xA0))
            continue
        lo_text = token.group(1) or token.group(3)
        hi_text = token.group(2) or token.group(4) or lo_text
        codes.update(range(int(lo_text, 16), int(hi_text, 16) + 1))
    return codes


def test_table_is_the_one_the_control_plane_rejects_names_with() -> None:
    """表从 TypeScript 的源码里读出来逐个码位对照：写入时拒绝的和打印时转义的不会各改各的。"""
    source = (Path(__file__).resolve().parents[3] / "packages/schema/src/text-safety.ts").read_text(
        encoding="utf-8"
    )
    match = re.search(r"REJECTED_NAME_CHARACTER =\s*(?://[^\n]*\n\s*)*/\[(.+?)\]/u;", source, re.S)
    assert match, "text-safety.ts 里找不到 REJECTED_NAME_CHARACTER"
    expected = _parse_rejected_class(match.group(1))
    assert expected, "没有从 text-safety.ts 里读出任何码位"
    assert _UNSAFE_CODES == expected


def test_table_parser_fails_on_a_notation_it_does_not_know() -> None:
    """对照测试自己的保险：字符类里有不认识的写法时失败，不是悄悄跳过。"""
    with pytest.raises(AssertionError, match="不认识的写法"):
        _parse_rejected_class(r"\p{Cc}\u00AD\p{Cf}")
    with pytest.raises(AssertionError, match="不认识的写法"):
        _parse_rejected_class(r"\u00AD[a-z]")
    assert _parse_rejected_class(r"\p{Cc}\u00AD\u{E0000}-\u{E0FFF}\uD800-\uDFFF") >= {0xAD, 0xE0001}


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # 整段去掉的只有 CSI 和两个字节的 ESC 序列：颜色、清屏、光标移动、8 位的 CSI。
        (f"{ESC}[31m红{ESC}[0m字", "红字"),
        (f"前{ESC}[2J{ESC}[H后", "前后"),
        (f"前{ESC}[1;1H覆盖", "前覆盖"),
        (f"{CSI8}31m红{CSI8}0m", "红"),
        (f"{ESC}c正文", "正文"),
        # 串序列（OSC、DCS 等）不整段去掉：开头和结尾写成看得见的转义，正文留着（#691 复审：
        # 整段去掉能删别人的记录）。7 位的 ST（ESC \\）是两个字节的 ESC 序列，吃不了文字，照旧去掉。
        (f"{ESC}]0;窗口标题{BEL}正文", "\\u001b]0;窗口标题\\u0007正文"),
        (
            f"{ESC}]8;;http://x{ESC}\\链接{ESC}]8;;{ESC}\\",
            "\\u001b]8;;http://x链接\\u001b]8;;",
        ),
        (f"{ESC}P1$r{ESC}\\正文", "\\u001bP1$r正文"),
        # 8 位的 ST 结尾、8 位的 OSC 和 DCS 开头。
        (f"{ESC}]0;标题{ST8}正文", "\\u001b]0;标题\\u009c正文"),
        (f"{chr(0x9D)}0;标题{BEL}正文", "\\u009d0;标题\\u0007正文"),
        (f"{chr(0x9D)}0;标题{ST8}正文", "\\u009d0;标题\\u009c正文"),
        (f"{chr(0x90)}1$r{ST8}正文", "\\u00901$r\\u009c正文"),
        (f"{chr(0x90)}1$r{ESC}\\正文", "\\u00901$r正文"),
        # 没有结尾的串序列也一样：开头写成看得见的转义，正文照常显示。
        (f"正文{ESC}]0;一直不结束", "正文\\u001b]0;一直不结束"),
        (f"前{chr(0x9D)}后", "前\\u009d后"),
        (f"前{ESC}P后", "前\\u001bP后"),
        (f"前{chr(0x90)}后", "前\\u0090后"),
        (f"前{ESC}X后", "前\\u001bX后"),
        (f"前{chr(0x98)}后", "前\\u0098后"),
        (f"前{ESC}^后", "前\\u001b^后"),
        (f"前{chr(0x9E)}后", "前\\u009e后"),
        (f"前{ESC}_后", "前\\u001b_后"),
        (f"前{chr(0x9F)}后", "前\\u009f后"),
        # 剩下的控制字符写成看得见的转义：不悄悄吞掉。
        (f"响铃{BEL}退格{chr(8)}", "响铃\\u0007退格\\u0008"),
        (f"NUL{chr(0)}DEL{chr(0x7F)}", "NUL\\u0000DEL\\u007f"),
        (f"下一行{NEL}", "下一行\\u0085"),
        (f"倒着{RLO}显示", "倒着\\u202e显示"),
        (f"零宽{ZWSP}空格", "零宽\\u200b空格"),
        (f"标签{TAG_G}", "标签\\U000e0067"),
        (f"孤立{LONE}代理", "孤立\\ud800代理"),
        (f"盲文{chr(0x2800)}空白", "盲文\\u2800空白"),
        # 换行和制表符保留（多行的日志、摘要要用）。
        ("第一行\n第二行\t缩进", "第一行\n第二行\t缩进"),
        # 正常的文字原样：中日韩、emoji、零宽连接符的组合表情、变体选择符、波斯文。
        ("王小明 田中 김철수", "王小明 田中 김철수"),
        (chr(0x1F469) + chr(0x200D) + chr(0x1F4BB), chr(0x1F469) + chr(0x200D) + chr(0x1F4BB)),
        (chr(0x2764) + chr(0xFE0F), chr(0x2764) + chr(0xFE0F)),
        ("می" + chr(0x200C) + "خواهم", "می" + chr(0x200C) + "خواهم"),
    ],
)
def test_printable(text: str, expected: str) -> None:
    assert printable(text) == expected
    assert _unsafe_in(printable(text)) == []


def test_printable_leaves_nothing_unsafe_for_any_single_code_point() -> None:
    for code in range(0x110000):
        out = printable(f"a{chr(code)}b")
        assert _unsafe_in(out) == [], hex(code)
        assert ESC not in out, hex(code)


def test_json_safe_keeps_the_value_and_leaves_no_raw_unsafe_characters() -> None:
    value = {
        "name": f"a{NEL}b{RLO}c{ZWSP}d{TAG_G}e{LONE}f",
        "list": [f"{CSI8}31m"],
        "中文": "王小明 " + chr(0x1F469) + chr(0x200D) + chr(0x1F4BB),
    }
    text = dump_json(value)
    assert _unsafe_in(text) == []
    assert "\n" not in text
    parsed = json.loads(text)
    assert parsed == value
    # 补充平面的字符写成代理对，解析回来是同一个字符。
    assert "\\udb40\\udc67" in text


def test_json_safe_is_identity_on_plain_text() -> None:
    plain = '{"a":"b","中文":"王小明","emoji":"' + chr(0x1F600) + '"}'
    assert json_safe(plain) == plain


def _session(stdout: io.TextIOBase, stderr: io.StringIO | None = None) -> Session:
    """只有 `out.stdout`、`out.stderr` 的会话替身：`_copy_body`、`_copy_stream` 只用到这两个。"""
    out = SimpleNamespace(stdout=stdout, stderr=stderr or io.StringIO())
    return cast(Session, SimpleNamespace(out=out))


class _Terminal(io.StringIO):
    def isatty(self) -> bool:
        return True


def _output(*, json_mode: bool) -> tuple[Output, io.StringIO, io.StringIO]:
    out, err = io.StringIO(), io.StringIO()
    return Output(json_mode=json_mode, stdout=out, stderr=err), out, err


def test_text_output_and_errors_are_printable() -> None:
    output, out, err = _output(json_mode=False)
    output.emit({}, f"昵称 {ESC}[31m红{ESC}[0m{RLO}名{ZWSP}字", note=f"提示{ESC}]0;x{BEL}")
    output.error(CliError("e", f"出错{ESC}[2J{NEL}", next=f"重试{RLO}"))
    assert ESC not in out.getvalue() + err.getvalue()
    assert _unsafe_in(out.getvalue() + err.getvalue()) == []
    assert "昵称 红\\u202e名\\u200b字" in out.getvalue()
    assert "错误：出错\\u0085" in err.getvalue()
    assert "下一步：重试\\u202e" in err.getvalue()


def test_json_output_and_errors_are_escaped_and_parse_back_unchanged() -> None:
    output, out, err = _output(json_mode=True)
    value: list[dict[str, Any]] = [{"author": f"小{NEL}明{RLO}", "via": f"x{TAG_G}"}]
    output.emit(value, "ignored", note=f"提示{ESC}[2J")
    output.error(CliError("e", f"出错{NEL}", next=None))
    assert _unsafe_in(out.getvalue() + err.getvalue()) == []
    assert ESC not in out.getvalue() + err.getvalue()
    assert json.loads(out.getvalue()) == value
    assert json.loads(err.getvalue().splitlines()[-1])["error"]["message"] == f"出错{NEL}"


def test_actor_label_with_hostile_via_is_printable_through_output() -> None:
    output, out, _ = _output(json_mode=False)
    output.emit({}, actor_label("小明", f"codex{ESC}[2J{RLO}"))
    # 不合格的「经 …」名称显示成「未知」（控制面写入时也不收，旧值同样处理）。
    assert "小明 经 未知" in out.getvalue()


class _Response:
    def __init__(self, body: bytes, content_type: str = "application/json") -> None:
        self._chunks = [body[i : i + 7] for i in range(0, len(body), 7)]
        self.headers = SimpleNamespace(get_content_type=lambda: content_type)

    def read(self, _size: int = -1) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""


def test_api_prints_the_body_through_the_filter_only_on_a_terminal() -> None:
    body = f'{{"name":"a{NEL}b","title":"{RLO}x"}}'.encode()
    # 终端：过一遍；转义序列被切在两个块之间也认得出（整段读完再过）。
    terminal = _Terminal()
    api._copy_body(
        _session(terminal),
        _Response(f"前{ESC}[31m红{ESC}[0m".encode()),
    )
    assert "前红" in terminal.getvalue() and ESC not in terminal.getvalue()
    terminal = _Terminal()
    api._copy_body(_session(terminal), _Response(body))
    assert _unsafe_in(terminal.getvalue()) == []
    assert "\\u0085" in terminal.getvalue()
    # 重定向到文件或管道：原样（给 jq 之类的程序用）。
    piped = io.StringIO()
    api._copy_body(_session(piped), _Response(body))
    assert piped.getvalue().startswith(body.decode())


def test_api_event_stream_on_a_terminal_is_filtered_line_by_line() -> None:
    class _Lines:
        def __init__(self, lines: list[bytes]) -> None:
            self.lines = lines

        def readline(self) -> bytes:
            return self.lines.pop(0) if self.lines else b""

    terminal = _Terminal()
    session = _session(terminal)
    api._copy_stream(
        session,
        _Lines([f"data: x{ESC}[2J{NEL}\n".encode(), b"data: ok\n"]),
        timeout=5,
    )
    assert terminal.getvalue() == "data: x\\u0085\ndata: ok\n"


_OPENERS = [
    f"{ESC}]",
    chr(0x9D),
    f"{ESC}P",
    chr(0x90),
    f"{ESC}X",
    chr(0x98),
    f"{ESC}^",
    chr(0x9E),
    f"{ESC}_",
    chr(0x9F),
]


def _records_between_an_opener_and_a_terminator(opener: str, terminator: str) -> dict[str, Any]:
    """控制面回的 JSON 是一行，记录之间没有换行：第二条记录里有串序列的开头、第四条里有结尾，
    夹在中间的第三条是别人的。"""
    return {
        "lines": [
            {"seq": 1, "text": "第一行"},
            {"seq": 2, "text": f"第二行{opener}标题"},
            {"seq": 3, "text": "第三行 别人的 ERROR 设备 3 校准失败"},
            {"seq": 4, "text": f"第四行{terminator}尾巴"},
            {"seq": 5, "text": "第五行"},
        ]
    }


def test_api_json_on_a_terminal_keeps_every_record_between_an_opener_and_a_terminator() -> None:
    """#691 复审：`sfly api` 在终端上把别人的记录整段删掉（JSON 里 C1 字符不转义，一条记录里的开头
    和另一条里的结尾把中间的都当成序列的正文）。JSON 现在只转义：解析回来和原文相等，什么都没少。"""
    for opener in _OPENERS:
        for terminator in (BEL, ST8, f"{ESC}\\"):
            value = _records_between_an_opener_and_a_terminator(opener, terminator)
            body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
            terminal = _Terminal()
            api._copy_body(_session(terminal), _Response(body))
            shown = terminal.getvalue()
            assert json.loads(shown) == value, (opener, terminator)
            assert "第三行 别人的 ERROR 设备 3 校准失败" in shown
            assert _unsafe_in(shown) == [] and ESC not in shown, (opener, terminator)
            assert shown.endswith("\n") and shown.count("\n") == 1
            # 管道里原样（有 buffer 的 stdout：字节原样写出去）。
            raw = io.BytesIO()
            piped = io.TextIOWrapper(raw, encoding="utf-8")
            api._copy_body(_session(piped), _Response(body))
            piped.flush()
            assert raw.getvalue() == body + b"\n"


def test_api_json_on_a_terminal_keeps_colors_and_everything_else_in_the_text() -> None:
    """JSON 的字符串里的转义序列（颜色等）也不去掉，只是 ESC 写成 `\\u001b`：解析回来和原文相等。"""
    value = {
        "color": f"{ESC}[31m红{ESC}[0m",
        "title": f"{ESC}]0;标题{BEL}",
        "number": 12345678901234567890,
        "nested": [{"k": None, "t": True, "f": 1.5}],
        f"键{RLO}": "值",
    }
    terminal = _Terminal()
    body = json.dumps(value, ensure_ascii=False).encode()  # 有空格的、不是精简的写法
    api._copy_body(_session(terminal), _Response(body))
    shown = terminal.getvalue()
    assert json.loads(shown) == value
    assert "\\u001b[31m" in shown and ESC not in shown and _unsafe_in(shown) == []


def test_api_json_on_a_terminal_applies_the_position_rule_inside_strings() -> None:
    value = {"开头": chr(0x200D) + "a", "表情": chr(0x1F469) + chr(0x200D) + chr(0x1F4BB)}
    terminal = _Terminal()
    api._copy_body(_session(terminal), _Response(json.dumps(value, ensure_ascii=False).encode()))
    shown = terminal.getvalue()
    assert json.loads(shown) == value
    assert "\\u200da" in shown and chr(0x1F469) + chr(0x200D) + chr(0x1F4BB) in shown


def test_api_body_that_is_not_json_is_still_plain_text_on_a_terminal() -> None:
    """不是 JSON 的正文（下载的文件、解析不了的）按普通文字处理：去掉颜色，别的写成转义，
    文字都留着。"""
    for content_type, text in (
        ("text/plain", f"a{chr(0x9D)}b{ST8}c {ESC}[31m红"),
        ("application/json", f"{{不是 JSON {chr(0x9D)}中间{ST8}"),
        ("application/octet-stream", f'{{"a":"{chr(0x9D)}"}}'),
    ):
        terminal = _Terminal()
        api._copy_body(_session(terminal), _Response(text.encode(), content_type))
        shown = terminal.getvalue()
        assert _unsafe_in(shown) == [] and ESC not in shown, text
    terminal = _Terminal()
    api._copy_body(_session(terminal), _Response(f"a{chr(0x9D)}中间{ST8}c".encode(), "text/plain"))
    assert terminal.getvalue() == "a\\u009d中间\\u009cc"


def test_api_event_stream_json_on_a_terminal_keeps_every_field_between_openers() -> None:
    """事件流一行一个事件，`data:` 是一行 JSON：同一个事件里不同任务的字段之间同样不能被删。"""

    class _Lines:
        def __init__(self, lines: list[bytes]) -> None:
            self.lines = lines

        def readline(self) -> bytes:
            return self.lines.pop(0) if self.lines else b""

    event = {
        "tasks": [
            {"node": "a", "error": f"失败{chr(0x9D)}"},
            {"node": "b", "error": "别的节点的原因：磁盘满"},
            {"node": "c", "error": f"x{ST8}"},
            {"node": "d", "error": "最后"},
        ]
    }
    line = ("data: " + json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    terminal = _Terminal()
    api._copy_stream(_session(terminal), _Lines([line, b"event: x\x1b[31m\n", b"data:next\n"]), 5)
    first, second, third = terminal.getvalue().split("\n")[:3]
    assert first.startswith("data: ") and json.loads(first[len("data: ") :]) == event
    assert "别的节点的原因：磁盘满" in first and _unsafe_in(first) == []
    # 不是 `data:` 的行、`data:` 不是 JSON 的行：按普通文字处理。
    assert second == "event: x"
    assert third == "data:next"
    # 管道里原样。
    piped = io.StringIO()
    api._copy_stream(_session(piped), _Lines([line]), 5)
    assert piped.getvalue() == line.decode()


def test_string_sequences_are_never_removed_so_no_text_between_them_goes_missing() -> None:
    """OSC、DCS、SOS、PM、APC 的正文可以是任意文字：整段去掉（不论有没有结尾、跨不跨行）就能删掉
    夹在中间的别人的文字（#691 复审）。每一种开头 × 每一种结尾：开头和结尾写成看得见的转义，
    中间和前后的文字（包括隔几行的、隔很远的）都在。"""
    for opener in _OPENERS:
        for terminator in (BEL, ST8):
            for gap in ("", "标题", "\n第三行 ERROR\n别人的日志\n", "x" * 100_000):
                text = f"前{opener}{gap}{terminator}后\n继续读：sfly run logs"
                out = printable(text)
                assert _unsafe_in(out) == [] and ESC not in out, (opener, terminator)
                assert out.startswith("前") and out.endswith("后\n继续读：sfly run logs")
                assert gap.strip() in out, (opener, terminator)
                assert out.count("\n") == text.count("\n"), (opener, terminator)


def test_unterminated_string_sequences_keep_the_text_after_them() -> None:
    """没有结尾的开头单独出现在一行中间、后面隔几行才有结尾，后面的行都在（#670 复审）。"""
    for opener in _OPENERS:
        for terminator in (BEL, ST8, f"{ESC}\\"):
            text = (
                f"第一行\n中间{opener}标题\n第三行 ERROR\n第四行{terminator}\n"
                "第五行\n继续读：sfly run logs"
            )
            out = printable(text)
            for kept in (
                "第一行",
                "中间",
                "标题",
                "第三行 ERROR",
                "第四行",
                "第五行",
                "继续读：sfly run logs",
            ):
                assert kept in out, (opener, terminator, kept)
            assert out.count("\n") == 5, (opener, terminator)
            assert _unsafe_in(out) == [] and ESC not in out


def test_what_a_removed_escape_sequence_can_take_with_it_is_bounded() -> None:
    """整段去掉的只有 CSI 和两个字节的 ESC 序列，它们的参数只能是数字和标点：一个没写完的 CSI
    最多带走紧跟着的一小段数字和标点（含空格这类中间字节）再加一个字符，只在同一行里；
    两个字节的 ESC 序列只带走一个字符。别的文字（字母、汉字、换行之后的）不受影响。"""
    # 开头之后没有东西：只去掉开头。
    assert printable(f"前{ESC}[后") == "前后"
    assert printable(f"前{CSI8}后") == "前后"
    # 参数（数字、分号）和一个结尾字符。
    assert printable(f"a{ESC}[12;3xb45") == "ab45"
    # 没写完的：数字和标点的一段加一个字符，后面的字母都在。
    assert printable(f"{ESC}[1234567 ERROR failed") == "RROR failed"
    assert printable(f"{ESC}[1;2;3;4;5;6;7;8;9mtext") == "text"
    # 不跨行：换行之后的一个字都不动。
    assert printable(f"{ESC}[12\n34 ERROR") == "\n34 ERROR"
    assert printable(f"{ESC}[\n第二行") == "\n第二行"
    # 汉字、字母（不是参数也不是中间字节）：CSI 只带走开头和结尾那一个字符。
    assert printable(f"{ESC}[中文") == "中文"
    # 两个字节的 ESC 序列只带走一个字符。
    assert printable(f"a{ESC}cb") == "ab"
    assert printable(f"a{ESC}7bcd") == "abcd"


def test_printable_never_deletes_text_when_there_is_nothing_removable() -> None:
    """没有 ESC 和 U+009B（也就是没有能整段去掉的序列）的文字，过一遍之后把 `\\uXXXX` 还原回去和原文
    一模一样：什么都没有少。随机组合，种子固定。"""
    rng = random.Random(691)
    alphabet = (
        list("abc XYZ019;:[]P^_\n\t")
        + ["中", "文", chr(0x1F600), chr(0x7), chr(0x85)]
        + [chr(c) for c in (0x90, 0x98, 0x9C, 0x9D, 0x9E, 0x9F, 0x202E, 0x200B, 0x200C, 0x200D)]
        + [chr(c) for c in (0xFE0F, 0x2800, 0xE0067, 0xD800)]
    )
    for _ in range(20_000):
        text = "".join(rng.choice(alphabet) for _ in range(rng.randrange(1, 40)))
        out = printable(text)
        assert _unsafe_in(out) == [], repr(text)
        assert _unescape(out) == text, repr(text)
        assert printable(out) == out, repr(text)


def test_printable_leaves_nothing_unsafe_and_is_idempotent_on_random_text() -> None:
    """什么字符都可能有（含 ESC、CSI、串序列的各种开头）：输出里没有表里的字符和 ESC，
    再过一遍不变。"""
    rng = random.Random(692)
    alphabet = (
        list("ab [;0123456789]P\\^_X\n\t")
        + [ESC, CSI8, BEL, ST8, chr(0x90), chr(0x9D), chr(0x9E), chr(0x9F), chr(0x98)]
        + [chr(0x200D), chr(0x200C), chr(0xFE0F), RLO, ZWSP, "中", chr(0x1F600)]
    )
    for _ in range(20_000):
        text = "".join(rng.choice(alphabet) for _ in range(rng.randrange(1, 40)))
        out = printable(text)
        assert _unsafe_in(out) == [] and ESC not in out, repr(text)
        assert printable(out) == out, repr(text)


_UNICODE_ESCAPE = re.compile(r"\\u([0-9a-f]{4})|\\U([0-9a-f]{8})")


def _unescape(text: str) -> str:
    """`printable` 写出来的 `\\uXXXX`、`\\UXXXXXXXX` 还原成字符（测试用的字母表里没有反斜杠）。"""
    return _UNICODE_ESCAPE.sub(lambda m: chr(int(m.group(1) or m.group(2), 16)), text)


def test_printing_many_unterminated_openers_is_linear() -> None:
    """没有结尾的开头不会每个都扫到文字末尾（平方级）。"""
    out = printable(chr(0x9D) * 200_000 + "x")
    assert out.endswith("x") and "\\u009d" in out


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # 表情、波斯文、印地文：位置对的原样。
        (chr(0x1F469) + chr(0x200D) + chr(0x1F4BB), chr(0x1F469) + chr(0x200D) + chr(0x1F4BB)),
        (
            chr(0x1F3F3) + chr(0xFE0F) + chr(0x200D) + chr(0x1F308),
            chr(0x1F3F3) + chr(0xFE0F) + chr(0x200D) + chr(0x1F308),
        ),
        # 位置不对的写成转义：开头、连着出现、空白后面、变体选择符后面接零宽不连字符。
        (f"{chr(0x200D)}abc", "\\u200dabc"),
        (f"a{chr(0x200D)}{chr(0x200D)}b", f"a{chr(0x200D)}\\u200db"),
        (f"a {chr(0xFE0F)}", "a \\ufe0f"),
        (f"a{chr(0xFE0F)}{chr(0x200C)}b", f"a{chr(0xFE0F)}\\u200cb"),
        (f"a{chr(0xFE0F)}{chr(0xFE0F)}", f"a{chr(0xFE0F)}\\ufe0f"),
        # 零宽连接符接在位置不对的变体选择符后面（开头、连着、空白后）：不算表情序列，都转义。
        (f"{chr(0xFE0F)}{chr(0x200D)}a", "\\ufe0f\\u200da"),
        (f"a{chr(0xFE0F)}{chr(0xFE0F)}{chr(0x200D)}", f"a{chr(0xFE0F)}\\ufe0f\\u200d"),
        (f"a {chr(0xFE0F)}{chr(0x200D)}b", "a \\ufe0f\\u200db"),
        # 换行、制表符、回车之后和开头一样：零宽连接符这类不能挂在它们后面（每一行重新数）。
        (f"a\n{chr(0x200D)}b", "a\n\\u200db"),
        (f"a\t{chr(0x200D)}b", "a\t\\u200db"),
        (f"a\n{chr(0xFE0F)}", "a\n\\ufe0f"),
        (f"一行\n{chr(0x200C)}\n二行", "一行\n\\u200c\n二行"),
        # 结尾的零宽连接符照旧放行。
        (f"a{chr(0x200D)}", f"a{chr(0x200D)}"),
    ],
)
def test_exception_characters_follow_the_name_position_rule(text: str, expected: str) -> None:
    assert printable(text) == expected


def test_zero_width_characters_do_not_carry_a_binary_payload() -> None:
    """零宽字符不限位置、不限个数时能把一段二进制原样带出去（#670 复审）：
    连着的只留紧跟在看得见字符后面的那些。"""
    payload = "a" + "".join(
        chr(0x200D) if bit else chr(0x200C) for bit in [1, 0, 1, 1, 0, 0, 1, 0] * 10
    )
    out = printable(payload)
    invisible = [c for c in out if c in (chr(0x200C), chr(0x200D))]
    assert len(invisible) <= 1


def _fixture_cases() -> tuple[dict[str, int], list[dict[str, Any]]]:
    path = Path(__file__).resolve().parents[3] / "packages/schema/test/name-position-cases.json"
    fixture = json.loads(path.read_text(encoding="utf-8"))
    return fixture["legend"], fixture["cases"]


def test_position_rule_matches_the_typescript_name_problem_on_every_fixture_case() -> None:
    """`nameProblem`（TypeScript，出处）对 2000 多个名字得出的结果在 name-position-cases.json 里：
    这里照同一条规则得出的第一个位置不对的字符必须一样。两头的规则不会各改各的。"""
    legend, cases = _fixture_cases()
    assert len(cases) > 2000
    wrong = []
    for case in cases:
        text = "".join(chr(legend[symbol]) for symbol in case["t"])
        bad = misplaced_exceptions(text)
        first = bad[0] + 1 if bad else None
        if first != case["m"]:
            wrong.append((case["t"], first, case["m"]))
    assert wrong == []


def test_json_output_escapes_misplaced_exceptions_and_parses_back_unchanged() -> None:
    value = {
        "开头": chr(0x200D) + "abc",
        "表情": chr(0x1F469) + chr(0x200D) + chr(0x1F4BB),
        "空白后面": "a " + chr(0xFE0F),
        "列表": [chr(0x200C) + "x", "ok"],
        chr(0x200D) + "键": 1,
    }
    text = dump_json(value)
    assert json.loads(text) == value
    assert "\\u200dabc" in text and "\\ufe0f" in text and "\\u200c" in text
    # 位置对的原样（表情序列没有被转义）。
    assert chr(0x1F469) + chr(0x200D) + chr(0x1F4BB) in text
    assert "\n" not in text and _unsafe_in(text) == []


def test_json_output_escapes_keys_too_when_a_misplaced_exception_forces_the_slow_path() -> None:
    """有零宽连接符这类时自己写 JSON：键和值一样处理（表里的字符、位置不对的零宽连接符都转义）。"""
    value = {f"键{NEL}": chr(0x200D), chr(0x200D) + "头": 1, f"{RLO}名": {f"内{ZWSP}层": [1]}}
    text = dump_json(value)
    assert json.loads(text) == value
    assert text == '{"键\\u0085":"\\u200d","\\u200d头":1,"\\u202e名":{"内\\u200b层":[1]}}'
    assert _unsafe_in(text) == []


def test_json_slow_path_does_not_recurse() -> None:
    """位置不对的零宽连接符走自己写的那条路：嵌套很深也不抛 `RecursionError`
    （标准库那条路 5000 层都行）。"""
    deep: list[Any] = [chr(0x200D) + "x"]
    for _ in range(5000):
        deep = [deep]
    text = dump_json(deep)
    assert text.count("[") == 5001 and "\\u200dx" in text
    nested: Any = {"k": chr(0x200D)}
    for _ in range(3000):
        nested = {"a": nested}
    assert "\\u200d" in dump_json(nested)
    # 循环引用和标准库一样是 ValueError，不是死循环。
    loop: list[Any] = [chr(0x200D)]
    loop.append(loop)
    with pytest.raises(ValueError, match="Circular"):
        dump_json(loop)
    # 同一个对象出现两次（不是循环）照常写。
    shared = [chr(0x200D)]
    assert dump_json([shared, shared]) == '[["\\u200d"],["\\u200d"]]'


def test_json_output_keeps_chinese_and_emoji_unescaped() -> None:
    """`--json` 里中文和表情不被转义（精简、好读）。"""
    value = {
        "名称": "王小明",
        "标签": chr(0x1F600),
        "组合": chr(0x1F469) + chr(0x200D) + chr(0x1F4BB),
    }
    text = dump_json(value)
    assert text == dump_json_safe(value)
    assert "王小明" in text and chr(0x1F600) in text and "\\u" not in text
    assert json.loads(text) == value


def test_json_slow_path_agrees_with_the_standard_library_on_plain_values() -> None:
    """有零宽连接符这类时自己写 JSON：除了该转义的字符，和标准库写出来的一样。"""
    value = {"a": [1, 2.5, True, False, None, 'x\ny\t"z\\'], "b": {"c": chr(0x200D) + "d"}}
    standard = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    ours = dump_json(value)
    assert ours == standard.replace(chr(0x200D), "\\u200d")


def test_progress_line_is_filtered() -> None:
    """`sfly run` 的进度行里有服务端的文字（节点名）：过一遍。"""
    out, err = io.StringIO(), io.StringIO()
    session = cast(Session, SimpleNamespace(out=SimpleNamespace(stdout=out, stderr=err)))
    _progress(session, f"节点 a{ESC}[2J{NEL}{RLO} 进行中")
    assert err.getvalue() == "节点 a\\u0085\\u202e 进行中\n"


def test_version_mismatch_warning_is_filtered() -> None:
    """版本不一致的警告里有控制面回的版本号（服务端的文字）：过一遍。"""
    err = io.StringIO()
    client = Client("http://127.0.0.1:1", "小明", stderr=err)
    headers = Message()
    headers["x-sfly-version"] = "9.9.9"  # 请求头只能是 latin-1：8 位的控制字符能到这里
    headers.replace_header("x-sfly-version", "9.9.9" + chr(0x85) + chr(0xAD))
    client._observe(headers)  # noqa: SLF001
    text = err.getvalue()
    assert "警告：sfly 命令行" in text
    assert _unsafe_in(text) == [] and ESC not in text
    assert "\\u0085\\u00ad" in text


def test_run_logs_json_notes_are_filtered() -> None:
    """`run logs --json` 的提示写到 stderr，里面有节点名（服务端的文字）：过一遍。"""
    out, err = io.StringIO(), io.StringIO()
    print_notes(
        Output(json_mode=True, stdout=out, stderr=err), [f"节点 x{ESC}]0;t{BEL}y{NEL}", "第二条"]
    )
    assert err.getvalue() == "节点 x\\u001b]0;t\\u0007y\\u0085\n第二条\n"
    assert out.getvalue() == ""


def test_via_label_shows_unknown_for_the_placeholder_and_bad_values() -> None:
    """请求头里有 agent/ 但名称不合格时控制面存占位值 `?`（不可能是合格的名称），库里升级之前存下的
    不合格旧值也有：都显示「未知」；`unknown` 本身是合格的名称，原样显示。"""
    assert via_label("?") == "未知"
    assert via_label("unknown") == "unknown"
    assert via_label("claude-code") == "Claude Code"
    assert via_label("my_tool-1.2+b") == "my_tool-1.2+b"
    for bad in (f"codex{ESC}[2J", f"co{RLO}dex", "a" * 65, "<b>x</b>", "", chr(0xE9)):
        assert via_label(bad) == "未知", bad
    assert via_label(None) is None
    assert actor_label("小明", f"x{ESC}[31m") == "小明 经 未知"
