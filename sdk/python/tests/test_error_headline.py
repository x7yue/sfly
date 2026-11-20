"""失败原因的一行（命令行摘要用）：和网页、控制面（packages/schema 的 `errorHeadline`）共用用例表
testdata/error-headline-cases.json，两边各有一份实现，都要通过这里的全部用例。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from sfly.cli.error_headline import error_headline, error_location, split_error, with_location

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


def test_the_place_goes_after_the_reason_lines_and_before_the_traceback() -> None:
    lines = (
        "ValueError: 坏了\n\nTraceback (most recent call last):\n  File x\nValueError: 坏了".split(
            "\n"
        )
    )

    assert with_location(lines, "demo.work 第 12 行") == [
        "ValueError: 坏了",
        "出错位置：demo.work 第 12 行",
        "",
        "Traceback (most recent call last):",
        "  File x",
        "ValueError: 坏了",
    ]


def test_a_message_without_a_traceback_gets_the_place_at_the_end() -> None:
    assert with_location(["boom"], "demo.work 第 3 行") == ["boom", "出错位置：demo.work 第 3 行"]
    assert with_location([], "demo.work 第 3 行") == ["出错位置：demo.work 第 3 行"]


def test_without_a_place_the_lines_are_unchanged() -> None:
    lines = ["boom", "", "Traceback (most recent call last):"]

    assert with_location(lines, None) is lines


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (
            {"kind": "node_error", "message": "x", "location": "demo.work 第 1 行"},
            "demo.work 第 1 行",
        ),
        ({"kind": "node_error", "message": "x", "location": None}, None),
        ({"kind": "node_error", "message": "x", "location": ""}, None),
        ({"kind": "node_error", "message": "x"}, None),
    ],
    ids=["has-place", "null", "empty", "older-control-plane"],
)
def test_the_place_in_an_error_is_none_when_there_is_none(
    error: dict[str, Any], expected: str | None
) -> None:
    assert error_location(error) == expected
