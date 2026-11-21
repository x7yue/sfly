"""`sfly.testing.run_state`：用简写造一份合法的运行状态（`sfly.RunState`），给节点的单测和本地调试用。"""

from __future__ import annotations

import importlib
import json
import sys
import typing
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from run_state_shape import value_problems

import sfly
from sfly import RunState
from sfly.schemas import load_schema
from sfly.testing import run_node, run_state

RUN_STATE_DICT = typing.get_args(RunState)[0]


def checked(state: RunState) -> RunState:
    """造出的值通过导出的 JSON Schema，字段齐全、没有多余的键。"""
    errors = list(Draft202012Validator(load_schema("run-state")).iter_errors(state))
    assert errors == []
    assert value_problems(state, RUN_STATE_DICT) == []
    return state


def nodes_of(state: RunState) -> dict[str, Any]:
    return {n["node_id"]: n for chain in state["chains"] for n in chain["nodes"]}


def test_run_state_is_in_the_testing_module_and_not_at_the_package_root() -> None:
    assert "run_state" not in sfly.__all__
    assert not callable(getattr(sfly, "run_state", None))


def test_all_success_is_a_running_run_with_one_main_chain() -> None:
    state = checked(run_state(nodes={"a": "success", "b": "success"}))

    assert state["scenario"]["name"] == "测试场景"
    assert state["status"] == "running"
    assert state["result_so_far"] == "success"
    assert state["failures"] == []
    assert state["cancel"] is None
    assert state["self"] is None
    assert state["truncated"] is False
    assert state["ended_at"] is None
    [chain] = state["chains"]
    assert (chain["depth"], chain["name"], chain["parent_chain_instance_id"]) == (0, None, None)
    assert chain["async_node_id"] is None
    assert chain["status"] == "success"
    assert [(n["node_id"], n["status"], n["kind"], n["attempts"]) for n in chain["nodes"]] == [
        ("a", "success", "package", 1),
        ("b", "success", "package", 1),
    ]
    assert all(n["error"] is None for n in chain["nodes"])


def test_a_failed_node_carries_its_error_and_decides_the_result() -> None:
    state = checked(
        run_state(
            nodes={"a": "success", "b": ("failed", "ValueError: 余额不足"), "c": "skipped"},
            scenario="巡检",
        )
    )

    assert state["scenario"]["name"] == "巡检"
    assert state["failures"] == ["b"]
    assert state["result_so_far"] == "failed"
    assert state["status"] == "running"
    nodes = nodes_of(state)
    assert nodes["b"]["status"] == "failed"
    assert nodes["b"]["error"] == {
        "kind": "node_error",
        "headline": "ValueError: 余额不足",
        "message": "ValueError: 余额不足",
        "message_truncated": False,
        "location": None,
    }
    assert nodes["c"]["status"] == "skipped"
    assert (nodes["c"]["attempts"], nodes["c"]["started_at"], nodes["c"]["ended_at"]) == (
        0,
        None,
        None,
    )
    assert nodes["a"]["error"] is None


def test_failures_follow_the_order_of_the_nodes_on_the_chain() -> None:
    state = checked(
        run_state(nodes={"x": ("failed", "E: 一"), "y": "success", "z": ("failed", "E: 二")})
    )

    assert state["failures"] == ["x", "z"]


STACK = 'Traceback (most recent call last):\n  File "a.py", line 3, in f\nValueError: 余额不足'


def test_the_message_has_no_stack_and_the_headline_is_the_first_line_with_content() -> None:
    state = checked(
        run_state(nodes={"a": ("failed", f"\n  ValueError: 余额不足\n  账户 7\n\n{STACK}")})
    )

    error = nodes_of(state)["a"]["error"]
    assert error["headline"] == "ValueError: 余额不足"
    assert error["message"] == "\n  ValueError: 余额不足\n  账户 7"
    assert error["message_truncated"] is False


def test_the_stack_starts_at_the_first_traceback_line_like_the_control_plane() -> None:
    text = f"RuntimeError: 子进程失败\n\n{STACK}\n\n{STACK}"
    just_the_stack = STACK
    quoted = "见 Traceback (most recent call last): 之后的内容"
    # 执行器异常退出：标准错误里堆栈前面的一行警告留在异常信息里，堆栈从它自己的那一行起算。
    crashed = f"执行器异常退出（退出码 1），没有写出结果\n警告：内存不足\n{STACK}"
    group = (
        "ExceptionGroup: 两个任务失败\n\n"
        '  + Exception Group Traceback (most recent call last):\n  |  File "a.py", line 3'
    )

    state = checked(
        run_state(
            nodes={
                "a": ("failed", text),
                "b": ("failed", just_the_stack),
                "c": ("failed", quoted),
                "d": ("failed", crashed),
                "e": ("failed", group),
            }
        )
    )

    nodes = nodes_of(state)
    assert nodes["a"]["error"]["message"] == "RuntimeError: 子进程失败"
    assert nodes["b"]["error"]["message"] == ""
    assert nodes["b"]["error"]["headline"] == ""
    assert nodes["c"]["error"]["message"] == quoted
    assert nodes["d"]["error"]["message"] == (
        "执行器异常退出（退出码 1），没有写出结果\n警告：内存不足"
    )
    assert nodes["e"]["error"]["message"] == "ExceptionGroup: 两个任务失败"


CASES = json.loads(
    (Path(__file__).resolve().parents[3] / "testdata/run-state-cases.json").read_text("utf-8")
)["cases"]


def stored_errors(case: dict[str, Any]) -> dict[str, tuple[str, str, dict[str, Any]]]:
    """用例里每个失败节点：节点 ID → （最近一次尝试存下的错误信息、错误类型、期望的 `error`）。"""
    expected = {n["node_id"]: n for chain in case["expected"]["chains"] for n in chain["nodes"]}
    found: dict[str, tuple[str, str, dict[str, Any]]] = {}
    for chain in case["source"]["chains"]:
        for node in chain["nodes"]:
            error = node["attempts"][-1]["error"] if node["attempts"] else None
            want = expected[node["node_id"]]["error"]
            if node["status"] == "failed" and error and want:
                found[node["node_id"]] = (error["message"], error["kind"], want)
    return found


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_the_error_made_from_a_stored_text_is_what_the_control_plane_projects(
    case: dict[str, Any],
) -> None:
    """共用用例表（testdata/run-state-cases.json）里的错误信息交给 `run_state`，造出的 `error` 的
    类型、失败原因一行、异常信息和控制面投影出的一样（长度限制、出错位置不在这里比）。"""
    stored = stored_errors(case)
    limits = case.get("options", {}).get("limits")
    for node_id, (text, kind, want) in stored.items():
        if limits or want["message_truncated"]:
            continue
        error = nodes_of(run_state(nodes={node_id: ("failed", text, kind)}))[node_id]["error"]
        assert (error["kind"], error["headline"], error["message"]) == (
            want["kind"],
            want["headline"],
            want["message"],
        ), node_id


def test_the_headline_drops_the_exception_module_path_like_the_real_one() -> None:
    state = checked(
        run_state(nodes={"a": ("failed", "sfly_std.assert_.AssertionFailed: 总数不对")})
    )

    error = nodes_of(state)["a"]["error"]
    assert error["headline"] == "AssertionFailed: 总数不对"
    assert error["message"] == "sfly_std.assert_.AssertionFailed: 总数不对"


def test_a_failed_node_without_an_error_text_has_an_empty_one() -> None:
    state = checked(run_state(nodes={"a": ("failed", "")}))

    error = nodes_of(state)["a"]["error"]
    assert (error["headline"], error["message"]) == ("", "")


def test_the_error_kind_defaults_to_node_error_and_can_be_given() -> None:
    state = checked(
        run_state(
            nodes={
                "a": ("failed", "ValueError: x"),
                "b": ("failed", "任务执行超过 30 秒的超时时间，已被终止", "timeout"),
            }
        )
    )

    nodes = nodes_of(state)
    assert nodes["a"]["error"]["kind"] == "node_error"
    assert nodes["b"]["error"]["kind"] == "timeout"
    assert nodes["b"]["error"]["headline"] == "任务执行超过 30 秒的超时时间，已被终止"
    assert state["failures"] == ["a", "b"]


def test_a_failed_node_may_be_written_without_an_error_as_a_bare_status() -> None:
    state = checked(run_state(nodes={"a": "failed"}))

    assert state["failures"] == ["a"]
    assert nodes_of(state)["a"]["error"] == {
        "kind": "node_error",
        "headline": "",
        "message": "",
        "message_truncated": False,
        "location": None,
    }


def test_a_requested_cancel_makes_the_result_cancelled_while_the_run_is_still_running() -> None:
    state = checked(
        run_state(nodes={"a": "running", "b": "cancelled"}, cancel="小红"),
    )

    assert state["status"] == "running"
    assert state["result_so_far"] == "cancelled"
    cancel = state["cancel"]
    assert cancel is not None
    assert cancel["requested_by"] == "小红"
    assert cancel["requested_via"] is None
    assert cancel["forced_at"] is None
    assert cancel["requested_at"].endswith("Z")
    assert nodes_of(state)["b"]["status"] == "cancelled"


def test_a_cancel_wins_over_a_failed_node() -> None:
    state = checked(run_state(nodes={"a": ("failed", "E: x"), "b": "running"}, cancel="小红"))

    assert state["result_so_far"] == "cancelled"
    assert state["failures"] == ["a"]


@pytest.mark.parametrize("final", ["success", "failed", "cancelled"])
def test_a_finished_run_has_its_status_as_the_result(final: str) -> None:
    cases: dict[str, dict[str, Any]] = {
        "success": {"a": "success"},
        "failed": {"a": ("failed", "E: x"), "b": "skipped"},
        "cancelled": {"a": "success", "b": "cancelled"},
    }

    state = checked(run_state(nodes=cases[final], status=final))

    assert state["status"] == final
    assert state["result_so_far"] == final
    assert state["ended_at"] is not None
    assert all(chain["ended_at"] is not None for chain in state["chains"])


def test_a_run_that_failed_without_a_failed_node_has_failed_as_the_result() -> None:
    # 链失败却没有失败的节点（例如入口参数校验失败）：运行结束时结果就是 status。
    state = checked(run_state(nodes={"a": "skipped"}, status="failed"))

    assert state["failures"] == []
    assert state["result_so_far"] == "failed"


def test_a_running_chain_while_the_run_goes_on_has_no_end_time() -> None:
    state = checked(run_state(nodes={"a": "success", "b": "running", "c": "pending"}))

    [chain] = state["chains"]
    assert chain["status"] == "running"
    assert chain["ended_at"] is None
    assert state["ended_at"] is None


def test_the_node_status_decides_attempts_and_times() -> None:
    names = ["success", "failed", "running", "waiting", "dispatched", "queued"]
    names += ["pending", "skipped", "cancelled", "stopped"]
    state = checked(run_state(nodes={name: name for name in names}))

    got = {
        n["node_id"]: (n["attempts"], n["started_at"] is not None, n["ended_at"] is not None)
        for n in state["chains"][0]["nodes"]
    }
    assert got == {
        "success": (1, True, True),
        "failed": (1, True, True),
        "running": (1, True, False),
        "waiting": (1, True, False),
        "dispatched": (1, False, False),
        "queued": (1, False, False),
        "pending": (0, False, False),
        "skipped": (0, False, False),
        # 没开始就被取消、被停止的占位：没有尝试、没有开始时间，结束时间是取消或停止的那一刻。
        "cancelled": (0, False, True),
        "stopped": (0, False, True),
    }


def test_times_are_fixed_iso_times_that_increase_with_the_nodes() -> None:
    first = run_state(nodes={"a": "success", "b": "success", "c": "running"})
    second = run_state(nodes={"a": "success", "b": "success", "c": "running"})

    assert first == second
    assert first["started_at"] == "2026-01-01T00:00:00.000Z"
    starts = [n["started_at"] or "" for n in first["chains"][0]["nodes"]]
    assert starts == sorted(starts)
    assert len(set(starts)) == len(starts)
    for node in first["chains"][0]["nodes"][:2]:
        assert node["started_at"] is not None and node["ended_at"] is not None
        assert node["started_at"] < node["ended_at"]


def test_a_subflow_is_a_deeper_chain_triggered_by_an_async_node_of_the_main_chain() -> None:
    state = checked(
        run_state(
            nodes={"verify": ("failed", "AssertionError: 总数不对")},
            subflows={"回放": {"probe": ("failed", "ConnectionError: 连不上"), "after": "skipped"}},
            status="failed",
        )
    )

    main, sub = state["chains"]
    assert main["depth"] == 0 and sub["depth"] == 1
    assert sub["name"] == "回放"
    assert sub["parent_chain_instance_id"] == main["id"]
    assert sub["chain_id"] == "probe"
    assert sub["id"] != main["id"]
    trigger = [n for n in main["nodes"] if n["node_id"] == sub["async_node_id"]]
    assert [(n["kind"], n["status"], n["attempts"]) for n in trigger] == [("async", "success", 1)]
    assert [n["node_id"] for n in main["nodes"] if n["kind"] == "package"] == ["verify"]
    assert [n["node_id"] for n in sub["nodes"]] == ["probe", "after"]
    assert sub["status"] == "failed"
    assert state["failures"] == ["verify", "probe"]
    assert state["result_so_far"] == "failed"


def test_a_running_subflow_keeps_the_chain_status_of_its_nodes() -> None:
    state = checked(
        run_state(
            nodes={"summary": "dispatched"},
            subflows={"回放": {"slow": "running", "after": "pending"}, "巡检": {"ok": "success"}},
        )
    )

    main, replay, patrol = state["chains"]
    assert [c["name"] for c in (replay, patrol)] == ["回放", "巡检"]
    assert (main["status"], replay["status"], patrol["status"]) == ("running", "running", "success")
    assert main["async_node_id"] is None
    assert replay["async_node_id"] != patrol["async_node_id"]
    assert replay["ended_at"] is None
    assert patrol["ended_at"] is not None
    assert replay["parent_chain_instance_id"] == patrol["parent_chain_instance_id"] == main["id"]
    assert len({c["id"] for c in state["chains"]}) == 3


def test_a_stopped_subflow_node_is_not_a_failure() -> None:
    state = checked(run_state(nodes={"stop": "success"}, subflows={"回放": {"slow": "stopped"}}))

    assert state["failures"] == []
    assert state["result_so_far"] == "success"
    assert state["chains"][1]["status"] == "success"


def test_the_referencing_node_is_dispatched_and_marked_in_self() -> None:
    state = checked(
        run_state(
            nodes={"fetch": "success", "summary": "dispatched", "after": "pending"},
            self_node="summary",
        )
    )

    assert state["self"] == {"chain_instance_id": state["chains"][0]["id"], "node_id": "summary"}
    node = nodes_of(state)["summary"]
    assert node["status"] == "dispatched"
    assert (node["attempts"], node["started_at"], node["ended_at"]) == (1, None, None)
    assert nodes_of(state)["after"]["status"] == "pending"


def test_the_referencing_node_is_dispatched_even_if_written_as_pending() -> None:
    state = checked(run_state(nodes={"summary": "pending"}, self_node="summary"))

    assert nodes_of(state)["summary"]["status"] == "dispatched"


def test_the_referencing_node_may_be_in_a_subflow() -> None:
    state = checked(
        run_state(
            nodes={"a": "success"},
            subflows={"回放": {"summary": "pending"}},
            self_node="summary",
        )
    )

    assert state["self"] == {"chain_instance_id": state["chains"][1]["id"], "node_id": "summary"}


class TestInvalidArguments:
    def test_an_unknown_node_status_is_named_with_the_choices(self) -> None:
        with pytest.raises(ValueError) as error:
            run_state(nodes={"a": "sucess"})

        message = str(error.value)
        assert "节点 a 的状态 'sucess' 不认识" in message
        assert "success" in message and "dispatched" in message

    def test_an_unknown_status_in_a_subflow_names_the_subflow(self) -> None:
        with pytest.raises(ValueError, match="子流程 回放 的节点 b 的状态 'done' 不认识"):
            run_state(nodes={"a": "success"}, subflows={"回放": {"b": "done"}})

    def test_an_unknown_run_status_is_named(self) -> None:
        with pytest.raises(ValueError, match="运行的状态 'done' 不认识.*running"):
            run_state(nodes={"a": "success"}, status="done")

    @pytest.mark.parametrize("status", ["success", "running", "skipped", "cancelled"])
    def test_only_a_failed_node_may_carry_an_error(self, status: str) -> None:
        with pytest.raises(ValueError, match=f"节点 a 的状态是 {status}.*只有 failed"):
            run_state(nodes={"a": (status, "boom")})

    @pytest.mark.parametrize(
        "spec", [(), ("failed",), ("failed", "x", "timeout", "extra"), ("failed", 3), 7, None]
    )
    def test_a_malformed_node_spec_is_rejected(self, spec: Any) -> None:
        with pytest.raises(ValueError, match="节点 a 要写成"):
            run_state(nodes={"a": spec})

    def test_a_chain_needs_at_least_one_node(self) -> None:
        with pytest.raises(ValueError, match="nodes 里至少要有一个节点"):
            run_state(nodes={})
        with pytest.raises(ValueError, match="子流程 回放 里至少要有一个节点"):
            run_state(nodes={"a": "success"}, subflows={"回放": {}})
        with pytest.raises(ValueError, match="nodes 里至少要有一个节点"):
            run_state(nodes={}, subflows={"回放": {"a": "success"}})

    def test_node_ids_are_not_repeated_in_a_run(self) -> None:
        with pytest.raises(ValueError, match="节点 ID a 重复"):
            run_state(nodes={"a": "success"}, subflows={"回放": {"a": "success"}})

    def test_the_referencing_node_must_exist(self) -> None:
        with pytest.raises(ValueError, match="self_node 'nope' 不是任何一个节点的 ID"):
            run_state(nodes={"a": "success"}, self_node="nope")

    def test_the_referencing_node_cannot_carry_an_error(self) -> None:
        with pytest.raises(ValueError, match="self_node a.*dispatched.*不能带错误信息"):
            run_state(nodes={"a": ("failed", "x")}, self_node="a")

    def test_a_finished_run_has_no_nodes_in_progress(self) -> None:
        with pytest.raises(ValueError, match="运行已经是 success.*节点 a 的状态是 running"):
            run_state(nodes={"a": "running"}, status="success")

    def test_a_successful_run_has_no_failed_node_and_no_cancel(self) -> None:
        with pytest.raises(ValueError, match="status 是 success.*不能有失败的节点"):
            run_state(nodes={"a": ("failed", "x")}, status="success")
        with pytest.raises(ValueError, match="status 是 success.*不能有 cancel"):
            run_state(nodes={"a": "success"}, status="success", cancel="小红")


NODE_MODULE = """\
from __future__ import annotations

from sfly import Context, RunState, node


@node(title="运行汇总")
def run_summary(ctx: Context, run: RunState, label: str = "") -> dict:
    nodes = {n["node_id"]: n for chain in run["chains"] for n in chain["nodes"]}
    lines = [
        f"{nodes[i]['display_name'] or i}：{nodes[i]['error']['headline']}"
        for i in run["failures"]
    ]
    return {
        "scenario": run["scenario"]["name"],
        "result": run["result_so_far"],
        "self": run["self"]["node_id"] if run["self"] else None,
        "lines": lines,
    }
"""


def test_a_node_reading_the_run_state_runs_on_a_made_up_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "state_summary_node.py").write_text(NODE_MODULE, encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    try:
        module = importlib.import_module("state_summary_node")
        state = run_state(
            nodes={
                "fetch": ("failed", "ValueError: 余额不足"),
                "summary": "dispatched",
            },
            subflows={"回放": {"probe": ("failed", "ConnectionError: 连不上")}},
            scenario="巡检",
            self_node="summary",
        )

        result = run_node(module.run_summary, {"run": state}, work_dir=tmp_path)
    finally:
        sys.modules.pop("state_summary_node", None)

    assert result.status == "success", result.error
    assert result.outputs == {
        "scenario": "巡检",
        "result": "failed",
        "self": "summary",
        "lines": ["fetch：ValueError: 余额不足", "probe：ConnectionError: 连不上"],
    }
