"""命令行摘要里每个失败任务的「错误：」那一行：失败原因的一行，之后是没有并进它的各行原文。"""

from __future__ import annotations

from typing import Any

from sfly.cli.run_summary import render_summary

ASSERTION = (
    "sfly_std.assert_.AssertionFailed: 1 条断言中 1 条不通过：\n"
    "第 1 条：$ 应 eq true，实际是 false\n\n"
    "Traceback (most recent call last):\n"
    '  File "assert_.py", line 40, in assert_\n'
    "sfly_std.assert_.AssertionFailed: 1 条断言中 1 条不通过：\n"
    "第 1 条：$ 应 eq true，实际是 false"
)


def summary(message: str | None, location: str | None = None) -> dict[str, Any]:
    return {
        "id": "run-1",
        "status": "failed",
        "cancelled_by": None,
        "duration_seconds": 3.0,
        "url": "http://cp/runs/run-1",
        "failed": [
            {
                "chain": "main",
                "node": "assert_1",
                "attempt": 1,
                "attempts": 1,
                "display_name": None,
                "type": "sfly-std/assert",
                "task": "t-1",
                "error": None
                if message is None
                else {"kind": "node_error", "message": message}
                | ({} if location is None else {"location": location}),
                "logs": [],
                "logs_note": None,
            }
        ],
    }


def test_the_error_line_has_no_module_path_and_carries_the_second_line_after_a_colon() -> None:
    lines = render_summary(summary(ASSERTION)).split("\n")

    headline = "AssertionFailed: 1 条断言中 1 条不通过：第 1 条：$ 应 eq true，实际是 false"
    at = lines.index(f"    错误：node_error：{headline}")
    # 并进第一行的那一行不再重复；堆栈和末尾完整的异常行（带模块路径）照旧显示在下面。
    assert lines[at + 1 : at + 5] == [
        "",
        "      Traceback (most recent call last):",
        '        File "assert_.py", line 40, in assert_',
        "      sfly_std.assert_.AssertionFailed: 1 条断言中 1 条不通过：",
    ]
    assert lines[at + 5] == "      第 1 条：$ 应 eq true，实际是 false"


def test_a_single_line_error_is_unchanged() -> None:
    text = render_summary(
        summary("RuntimeError: 桩节点失败\n\nTraceback (most recent call last):\n  x")
    )

    assert (
        "    错误：node_error：RuntimeError: 桩节点失败\n\n      Traceback (most recent call last):"
        in text
    )


def test_no_error_message_is_still_said_so() -> None:
    assert "    错误：没有错误信息" in render_summary(summary(None))


def test_the_place_the_node_failed_follows_the_reason_line_before_the_traceback() -> None:
    text = render_summary(
        summary(
            "RuntimeError: 桩节点失败\n\nTraceback (most recent call last):\n  x",
            "demo.work 第 12 行",
        )
    )

    assert (
        "    错误：node_error：RuntimeError: 桩节点失败\n"
        "    出错位置：demo.work 第 12 行\n"
        "\n      Traceback (most recent call last):"
    ) in text


def test_an_error_from_an_older_control_plane_has_no_location_and_looks_as_before() -> None:
    # 旧版本的控制面的错误里没有 location 这个键；新版本里没有位置时是 null：都不多出一行。
    older = render_summary(summary("RuntimeError: 桩节点失败"))
    null = summary("RuntimeError: 桩节点失败")
    null["failed"][0]["error"]["location"] = None

    assert "出错位置" not in older
    assert render_summary(null) == older
