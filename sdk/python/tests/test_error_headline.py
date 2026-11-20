"""失败原因的一行（命令行摘要用）：和网页、控制面（packages/schema 的 `errorHeadline`）共用用例表
testdata/error-headline-cases.json，两边各有一份实现，都要通过这里的全部用例。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from sfly.cli.error_headline import error_headline, split_error

CASES: list[dict[str, Any]] = json.loads(
    (Path(__file__).resolve().parents[3] / "testdata" / "error-headline-cases.json").read_text(
        encoding="utf-8"
    )
)["cases"]


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_the_headline_is_what_the_shared_cases_say(case: dict[str, Any]) -> None:
    assert error_headline(case["message"]) == case["headline"]


def test_the_lines_folded_into_the_headline_are_not_repeated_in_the_rest() -> None:
    message = (
        "sfly_std.assert_.AssertionFailed: 1 条断言中 1 条不通过：\n"
        "第 1 条：$ 应 eq true，实际是 false\n\n"
        "Traceback (most recent call last):\n"
        '  File "a.py", line 1, in <module>\n'
        "sfly_std.assert_.AssertionFailed: 1 条断言中 1 条不通过："
    )

    headline, rest = split_error(message)

    assert headline == "AssertionFailed: 1 条断言中 1 条不通过：第 1 条：$ 应 eq true，实际是 false"
    # 其余各行原样：空行、堆栈的缩进、末尾的完整异常行（带模块路径）都保留。
    assert rest == [
        "",
        "Traceback (most recent call last):",
        '  File "a.py", line 1, in <module>',
        "sfly_std.assert_.AssertionFailed: 1 条断言中 1 条不通过：",
    ]


def test_without_folding_only_the_first_line_is_taken_and_the_rest_keeps_its_indentation() -> None:
    headline, rest = split_error("ValueError: boom\n\nTraceback (most recent call last):\n  frame")

    assert headline == "ValueError: boom"
    assert rest == ["", "Traceback (most recent call last):", "  frame"]


def test_an_empty_message_has_no_headline_and_nothing_left() -> None:
    assert split_error("") == ("", [])
    assert split_error("\n  \n") == ("", [])
