"""命令行摘要里每个失败任务的「错误：」那一行：失败原因的一行，之后是没有并进它的各行原文。"""

from __future__ import annotations

import argparse
import io
import json
from typing import Any

import pytest

from sfly.cli.client import ApiError, Client
from sfly.cli.errors import CliError
from sfly.cli.output import Output
from sfly.cli.run_query import _show, run_state
from sfly.cli.run_summary import (
    SECRETS_OVERSIZE_NOTE,
    SummaryUnavailable,
    fetch_report,
    minimal_summary,
    render_summary,
    summary_of,
    summary_unavailable_note,
)
from sfly.cli.session import Session

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
        "chains": [
            {"id": "c-1", "chain_id": "entry", "name": None},
            {"id": "c-2", "chain_id": "sub", "name": "回放"},
        ],
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
                    "missing": False,
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
                "location": None,
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
        "  main:a「下单」（第 1 次尝试）  扣库存（耗时 1.2s，2026-01-01T00:00:02.250Z 结束）",
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
        "    错误：node_error：ValueError: 库存不足\n    出错位置：shop.orders.place 第 42 行\n"
        in text
    )
    # `--json` 里 `error.location` 总是在：有位置是字符串，没有是 null（和运行视图的 error 一样）。
    assert summary_of(CLIENT, report(failed_tasks=[task]))["failed"][0]["error"]["location"] == (
        "shop.orders.place 第 42 行"
    )
    assert summary_of(CLIENT, report())["failed"][0]["error"]["location"] is None


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


def test_logs_the_control_plane_could_not_read_are_said_so_not_written_as_no_logs() -> None:
    task = report()["failed_tasks"][0]
    task["logs"] = {"lines": [], "earlier": False, "expired": False, "missing": True}
    summary = summary_of(CLIENT, report(failed_tasks=[task]))
    text = render_summary(summary)

    assert summary["failed"][0]["logs"] == []
    assert summary["failed"][0]["logs_note"] == (
        "没有读到日志：控制面记着这个任务写过日志，日志文件里却读不出来（可能被移走或清理了）"
    )
    assert "    （没有读到日志：控制面记着这个任务写过日志，日志文件里却读不出来" in text
    assert "    没有日志" not in text


def test_a_task_that_wrote_no_logs_is_still_written_as_no_logs() -> None:
    task = report()["failed_tasks"][0]
    task["logs"] = {"lines": [], "earlier": False, "expired": False, "missing": False}
    text = render_summary(summary_of(CLIENT, report(failed_tasks=[task])))

    assert "    没有日志" in text
    assert "没有读到日志" not in text


def test_a_failed_action_is_written_with_the_chain_so_the_node_can_be_passed_to_node() -> None:
    action = report()["failed_actions"][0]
    other = {**action, "chain_instance_id": "c-2", "node_id": "probe", "display_name": None}
    summary = summary_of(CLIENT, report(failed_actions=[action, other]))
    lines = render_summary(summary).split("\n")

    assert [(a["chain"], a["node"], a["attempt"]) for a in summary["failed_actions"]] == [
        ("main", "a", 1),
        ("回放", "probe", 1),
    ]
    # `链:节点` 和 `--node` 要的写法一样：sfly run actions <运行> --node main:a
    assert (
        "  main:a「下单」（第 1 次尝试）  扣库存（耗时 1.2s，2026-01-01T00:00:02.250Z 结束）"
        in lines
    )
    assert (
        "  回放:probe（第 1 次尝试）  扣库存（耗时 1.2s，2026-01-01T00:00:02.250Z 结束）" in lines
    )


class OldControlPlane:
    """比命令行旧的控制面：没有 `GET /runs/:id/summary`（404），运行本身读得到（或读不到）。"""

    def __init__(self, run: dict[str, Any] | None) -> None:
        self.run = run
        self.server = "http://cp"
        self.requests: list[str] = []

    def get(self, path: str, query: dict[str, Any] | None = None) -> Any:
        self.requests.append(path)
        if path.endswith("/summary") or self.run is None:
            raise ApiError(404, "not_found", f"route GET {path} not found")
        return self.run


RUN_VIEW: dict[str, Any] = {
    "id": "run-1",
    "status": "failed",
    "orchestration_id": "s-1",
    "orchestration_version": 3,
    "started_at": "2026-01-01T00:00:00.000Z",
    "ended_at": "2026-01-01T00:00:03.000Z",
    "cancel": None,
}


def test_a_404_for_the_summary_of_an_existing_run_says_the_control_plane_is_too_old() -> None:
    old = OldControlPlane(RUN_VIEW)

    with pytest.raises(SummaryUnavailable) as caught:
        fetch_report(old, "run-1")  # type: ignore[arg-type]

    error = caught.value
    assert error.code == "summary_unavailable"
    assert error.message == (
        "控制面没有运行摘要接口（它比这个命令行旧）：升级控制面，或用和控制面同版本的命令行"
    )
    assert "不存在" not in error.message
    assert old.requests == ["/runs/run-1/summary", "/runs/run-1"]


def test_a_404_for_a_run_that_does_not_exist_is_still_run_not_found() -> None:
    with pytest.raises(CliError) as caught:
        fetch_report(OldControlPlane(None), "run-9")  # type: ignore[arg-type]

    assert caught.value.code == "run_not_found"
    assert not isinstance(caught.value, SummaryUnavailable)


def test_the_minimal_summary_has_the_status_the_time_and_who_cancelled_but_no_failed_tasks() -> (
    None
):
    cancel = {
        "requested_by": "bob",
        "requested_via": None,
        "requested_at": "2026-01-01T00:00:02.000Z",
        "forced_at": None,
    }
    cancelled = minimal_summary(CLIENT, {**RUN_VIEW, "status": "cancelled", "cancel": cancel})

    assert minimal_summary(CLIENT, RUN_VIEW) == {
        "id": "run-1",
        "status": "failed",
        "scenario_id": "s-1",
        "scenario_version": 3,
        "started_at": "2026-01-01T00:00:00.000Z",
        "ended_at": "2026-01-01T00:00:03.000Z",
        "duration_seconds": 3.0,
        "url": "http://cp/runs/run-1",
        "cancelled_by": None,
        "failed": [],
        "failed_total": 0,
        "failed_actions": [],
        "attention_items": [],
    }
    assert cancelled["cancelled_by"] == {
        "nickname": "bob",
        "at": "2026-01-01T00:00:02.000Z",
        "forced": False,
    }
    assert render_summary(minimal_summary(CLIENT, RUN_VIEW)).split("\n") == [
        "运行 run-1：失败",
        "耗时：3.0s",
        "链接：http://cp/runs/run-1",
    ]
    note = summary_unavailable_note("run-1")
    assert "sfly run show run-1" in note and "sfly run logs run-1 --failed" in note
    assert "比这个命令行旧" in note


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


def test_a_run_whose_secret_values_are_too_many_says_why_everything_is_masked() -> None:
    """secret 值太多的运行（#657）：摘要的 JSON 多一个 `secrets_oversize`，文本里多一行提示，
    不含任何值；正常的摘要没有这个键、没有这一行，和以前一字不差。"""
    plain = summary_of(CLIENT, report())
    assert "secrets_oversize" not in plain
    oversize = summary_of(CLIENT, report(secrets_oversize=True))
    assert oversize.pop("secrets_oversize") is True
    assert oversize == plain
    text = render_summary(summary_of(CLIENT, report(secrets_oversize=True)))
    assert SECRETS_OVERSIZE_NOTE in text.split("\n")
    assert SECRETS_OVERSIZE_NOTE not in render_summary(plain)
    # 旧版本的控制面没有这个字段：读不到时当作没有
    assert "secrets_oversize" not in summary_of(CLIENT, report(secrets_oversize=False))


SHOW_RUN_ID = "00000000-0000-4000-8000-000000000001"


class ShowClient:
    """`sfly run show` 读的三个接口：运行视图、运行摘要、场景（取名称）。"""

    def __init__(self, rep: dict[str, Any]) -> None:
        self.rep = rep

    def get(self, path: str, query: dict[str, Any] | None = None) -> Any:
        if path == f"/runs/{SHOW_RUN_ID}":
            return {
                "id": SHOW_RUN_ID,
                "orchestration_id": "s-1",
                "orchestration_version": 3,
                "status": "failed",
                "triggered_by": "alice",
                "triggered_via": None,
                "preset": None,
                "params": {},
                "started_at": "2026-01-01T00:00:00.000Z",
                "ended_at": "2026-01-01T00:00:03.000Z",
                "cancel": None,
                "chains": [],
            }
        if path == f"/runs/{SHOW_RUN_ID}/summary":
            return self.rep
        if path == "/orchestrations/s-1":
            return {"name": "巡检"}
        raise AssertionError(path)


def run_show(rep: dict[str, Any], *, json_mode: bool) -> str:
    stdout = io.StringIO()
    session = Session(ShowClient(rep), Output(json_mode=json_mode, stdout=stdout))  # type: ignore[arg-type]
    args = argparse.Namespace(run=SHOW_RUN_ID, node=None, outputs=False, state=False)
    _show(session, args)
    return stdout.getvalue()


def test_run_show_says_why_everything_is_masked_only_for_a_run_with_too_many_secret_values() -> (
    None
):
    """`sfly run show`（#657）：提示一行、`--json` 里的 `secrets_oversize` 只在这样的运行上有；
    正常的运行和旧控制面（摘要里没有这个键）的输出里没有。"""
    text = run_show(report(secrets_oversize=True), json_mode=False)
    assert SECRETS_OVERSIZE_NOTE in text.split("\n")
    assert (
        json.loads(run_show(report(secrets_oversize=True), json_mode=True))["secrets_oversize"]
        is True
    )
    for rep in (report(), report(secrets_oversize=False)):
        assert SECRETS_OVERSIZE_NOTE not in run_show(rep, json_mode=False)
        assert "secrets_oversize" not in json.loads(run_show(rep, json_mode=True))
    # 其余的输出一字不差：去掉提示和它前面的空行，就是正常的运行的输出
    lines = run_show(report(secrets_oversize=True), json_mode=False).split("\n")
    at = lines.index(SECRETS_OVERSIZE_NOTE)
    assert "\n".join(lines[: at - 1] + lines[at + 1 :]) == run_show(report(), json_mode=False)
