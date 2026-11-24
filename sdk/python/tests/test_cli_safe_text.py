"""命令行打印服务端的文字之前先过一遍（#670）：转义序列去掉，不该到终端的字符写成看得见的转义，
JSON 里同样；表和控制面写入时拒绝名字的那张表（packages/schema/src/text-safety.ts）是同一张。

不该到终端的字符都用码位造出来，不把它们直接写在源码里。
"""

from __future__ import annotations

import io
import json
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from sfly.cli import api
from sfly.cli.errors import CliError
from sfly.cli.output import Output, actor_label, dump_json
from sfly.cli.safe_text import UNSAFE_RANGES, json_safe, printable
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


def test_table_is_the_one_the_control_plane_rejects_names_with() -> None:
    """表从 TypeScript 的源码里读出来逐个码位对照：写入时拒绝的和打印时转义的不会各改各的。"""
    source = (Path(__file__).resolve().parents[3] / "packages/schema/src/text-safety.ts").read_text(
        encoding="utf-8"
    )
    match = re.search(r"REJECTED_NAME_CHARACTER =\s*(?://[^\n]*\n\s*)*/\[(.+?)\]/u;", source, re.S)
    assert match, "text-safety.ts 里找不到 REJECTED_NAME_CHARACTER"
    expected: set[int] = set()
    for token in re.finditer(
        r"\\p\{Cc\}|\\u\{([0-9A-Fa-f]+)\}(?:-\\u\{([0-9A-Fa-f]+)\})?|\\u([0-9A-Fa-f]{4})(?:-\\u([0-9A-Fa-f]{4}))?",
        match.group(1),
    ):
        if token.group(0) == r"\p{Cc}":
            expected.update(range(0x00, 0x20))
            expected.update(range(0x7F, 0xA0))
            continue
        lo_text = token.group(1) or token.group(3)
        hi_text = token.group(2) or token.group(4) or lo_text
        expected.update(range(int(lo_text, 16), int(hi_text, 16) + 1))
    assert expected, "没有从 text-safety.ts 里读出任何码位"
    assert _UNSAFE_CODES == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # 完整的转义序列整段去掉：颜色、清屏、光标移动、改窗口标题、8 位的 CSI。
        (f"{ESC}[31m红{ESC}[0m字", "红字"),
        (f"前{ESC}[2J{ESC}[H后", "前后"),
        (f"前{ESC}[1;1H覆盖", "前覆盖"),
        (f"{ESC}]0;窗口标题{BEL}正文", "正文"),
        (f"{ESC}]8;;http://x{ESC}\\链接{ESC}]8;;{ESC}\\", "链接"),
        (f"{CSI8}31m红{CSI8}0m", "红"),
        (f"{ESC}P1$r{ESC}\\正文", "正文"),
        (f"{ESC}c正文", "正文"),
        # 没有结尾的：被它吃掉。
        (f"正文{ESC}]0;一直不结束", "正文"),
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


def _session(stdout: io.StringIO, stderr: io.StringIO | None = None) -> Session:
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
    assert "小明 经 codex\\u202e" in out.getvalue()


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
