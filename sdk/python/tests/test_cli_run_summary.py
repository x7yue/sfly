"""命令行摘要里每个失败任务的「错误：」那一行：失败原因的一行，之后是没有并进它的各行原文。"""

from __future__ import annotations

from typing import Any

from sfly.cli.client import Client
from sfly.cli.run_query import run_state
from sfly.cli.run_summary import render_summary, summary_of

ASSERTION = (
    "sfly_std.assert_.AssertionFailed: 1 条断言中 1 条不通过：\n"
    "第 1 条：$ 应 eq true，实际是 false\n\n"
    "Traceback (most recent call last):\n"
    '  File "assert_.py", line 40, in assert_\n'
    "sfly_std.assert_.AssertionFailed: 1 条断言中 1 条不通过：\n"
    "第 1 条：$ 应 eq true，实际是 false"
)


def summary(message: str | None) -> dict[str, Any]:
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
                "error": None if message is None else {"kind": "node_error", "message": message},
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


def report(**overrides: Any) -> dict[str, Any]:
    """摘要接口（`RunReport`）的一份返回：一个失败的任务、一个失败的动作、一个有异常的关注项。"""
    base: dict[str, Any] = {
        "run_id": "run-1",
        "scenario": {"id": "s-1", "name": "巡检", "version": 3},
        "status": "failed",
        "result_so_far": "failed",
        "triggered_by": "alice",
        "triggered_via": None,
        "started_at": "2026-01-01T00:00:00.000Z",
        "ended_at": "2026-01-01T00:00:03.000Z",
        "cancel": None,
        "failures": ["a"],
        "self": None,
        "truncated": False,
        "chains": [],
        "duration_ms": 3000,
        "failed_tasks": [
            {
                "chain_instance_id": "c-1",
                "chain": None,
                "node_id": "a",
                "display_name": "下单",
                "kind": "package",
                "node_type": "shop/place_order",
                "attempt": 1,
                "attempts": 1,
                "task_id": "t-1",
                "error": {
                    "kind": "node_error",
                    "headline": "ValueError: 库存不足",
                    "detail": "ValueError: 库存不足\n\nTraceback (most recent call last):\n  x",
                    "location": None,
                },
                "logs": {
                    "lines": [
                        {
                            "seq": 1,
                            "time": "2026-01-01T00:00:01.000Z",
                            "agent_time": None,
                            "source": "node",
                            "level": "info",
                            "text": "开始",
                        }
                    ],
                    "earlier": True,
                    "expired": False,
                },
            }
        ],
        "failed_tasks_total": 1,
        "failed_actions": [
            {
                "id": 2,
                "parent": None,
                "depth": 0,
                "name": "扣库存",
                "fields": {"订单": "1002", "数量": "3"},
                "started_at": "2026-01-01T00:00:01.000Z",
                "agent_started_at": "2026-01-01T00:00:01.000Z",
                "ended_at": "2026-01-01T00:00:02.250Z",
                "agent_ended_at": "2026-01-01T00:00:02.250Z",
                "duration_ms": 1250,
                "result": "failed",
                "reason": "库存不足\n剩余 0",
                "chain_instance_id": "c-1",
                "node_id": "a",
                "display_name": "下单",
                "attempt": 1,
                "task_id": "t-1",
            }
        ],
        "attention_items": [
            {
                "position": 2,
                "node_id": "a",
                "display_name": "下单",
                "chart": "TPS",
                "title": "下单 TPS",
                "unit": "req/s",
                "source": {
                    "status": "failed",
                    "attempt": 1,
                    "task_id": "t-1",
                    "chain_instance_id": "c-1",
                    "started_at": None,
                    "ended_at": None,
                },
                "latest": {
                    "value": 1500000.0,
                    "metric": "tps",
                    "labels": {},
                    "at": "2026-01-01T00:00:02.000Z",
                },
                "anomaly": {
                    "kind": "failed",
                    "at": "2026-01-01T00:00:03.000Z",
                    "message": "ValueError: 库存不足",
                },
            }
        ],
    }
    return {**base, **overrides}


CLIENT = Client("http://cp", "alice")


def test_the_summary_keeps_the_keys_the_json_output_always_had() -> None:
    summary = summary_of(CLIENT, report())

    assert {
        key: summary[key]
        for key in (
            "id",
            "status",
            "scenario_id",
            "scenario_version",
            "started_at",
            "ended_at",
            "duration_seconds",
            "url",
            "cancelled_by",
        )
    } == {
        "id": "run-1",
        "status": "failed",
        "scenario_id": "s-1",
        "scenario_version": 3,
        "started_at": "2026-01-01T00:00:00.000Z",
        "ended_at": "2026-01-01T00:00:03.000Z",
        "duration_seconds": 3.0,
        "url": "http://cp/runs/run-1",
        "cancelled_by": None,
    }
    assert summary["failed"] == [
        {
            "chain": "main",
            "node": "a",
            "display_name": "下单",
            "type": "shop/place_order",
            "attempt": 1,
            "attempts": 1,
            "task": "t-1",
            "error": {
                "kind": "node_error",
                "message": "ValueError: 库存不足\n\nTraceback (most recent call last):\n  x",
            },
            "logs": [
                {
                    "time": "2026-01-01T00:00:01.000Z",
                    "level": "info",
                    "source": "node",
                    "text": "开始",
                }
            ],
            "logs_note": "前面还有更早的日志，用 sfly run logs run-1 --node main:a 查看",
        }
    ]


def test_the_text_gains_only_the_two_new_sections_after_the_failed_tasks() -> None:
    with_sections = render_summary(summary_of(CLIENT, report())).split("\n")
    bare = render_summary(summary_of(CLIENT, report(failed_actions=[], attention_items=[]))).split(
        "\n"
    )

    # 没有这两样时的文本就是以前的文本；有时，前面一字不差，后面接两段。
    assert with_sections[: len(bare)] == bare
    assert with_sections[len(bare) :] == [
        "",
        "失败的动作（1 个，最近结束的在前）：",
        "  a#1「下单」  扣库存（耗时 1.2s，2026-01-01T00:00:02.250Z 结束）",
        "    订单=1002，数量=3",
        "    原因：库存不足",
        "      剩余 0",
        "",
        "有异常的关注项（1 个）：",
        "  2. 下单 TPS  a「下单」，最新值 1500000 req/s",
        "     异常：来源节点失败（2026-01-01T00:00:03.000Z）：ValueError: 库存不足",
    ]
    assert bare[:7] == [
        "运行 run-1：失败",
        "耗时：3.0s",
        "链接：http://cp/runs/run-1",
        "",
        "失败的任务（1 个）：",
        "  main:a「下单」（shop/place_order，第 1 次尝试）",
        "    错误：node_error：ValueError: 库存不足",
    ]


def test_the_error_location_is_written_under_the_reason_when_there_is_one() -> None:
    task = report()["failed_tasks"][0]
    task["error"]["location"] = "shop.orders.place 第 42 行"
    text = render_summary(summary_of(CLIENT, report(failed_tasks=[task])))

    assert (
        "    错误：node_error：ValueError: 库存不足\n    位置：shop.orders.place 第 42 行\n" in text
    )
    without = summary_of(CLIENT, report())["failed"][0]["error"]
    assert "location" not in without


def test_more_failed_tasks_than_listed_say_how_many_and_how_to_read_them() -> None:
    text = render_summary(summary_of(CLIENT, report(failed_tasks_total=25)))

    assert "失败的任务（共 25 个，列出前 1 个）：" in text
    assert (
        "  （还有 24 个失败的任务没有列出，sfly run logs run-1 --failed 读它们的日志，"
        "sfly run show run-1 看每个节点的每次尝试）"
    ) in text


def test_a_cancelled_run_says_who_cancelled_it() -> None:
    cancel = {
        "requested_by": "bob",
        "requested_via": None,
        "requested_at": "2026-01-01T00:00:02.000Z",
        "forced_at": "2026-01-01T00:00:03.000Z",
    }
    summary = summary_of(CLIENT, report(status="cancelled", cancel=cancel, failed_tasks=[]))

    assert summary["cancelled_by"] == {
        "nickname": "bob",
        "at": "2026-01-01T00:00:02.000Z",
        "forced": True,
    }
    assert "由 bob 强制取消（2026-01-01T00:00:02.000Z）" in render_summary(summary)


def test_the_run_state_is_the_part_of_the_report_the_schema_names() -> None:
    state = run_state(report())

    assert list(state) == [
        "run_id",
        "scenario",
        "status",
        "result_so_far",
        "triggered_by",
        "triggered_via",
        "started_at",
        "ended_at",
        "cancel",
        "failures",
        "self",
        "truncated",
        "chains",
    ]
    assert "failed_tasks" not in state
    assert "duration_ms" not in state
