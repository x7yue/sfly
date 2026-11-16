"""`ctx.action` 与 `ctx.mark`（规格 #345 的 SDK 部分）。

- 通过 `sfly.testing.run_node` 看节点记录下来的 `Execution.actions` 和 `action_summary`：
  结果、嵌套、字段、校验和警告、摘要；节点定义在 `action_nodes.py`；
- 直接构造 `Context`、读它写的事件文件：事件的格式（#356、#357 按它解析）、时间、
  每秒最多一次的摘要、超出上限以后的行为。
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from action_nodes import (
    annotate,
    concurrency,
    ended_twice,
    fail_then_wait,
    invalid_name,
    invalid_parent,
    leave_unfinished,
    many_names,
    nesting,
    outcomes,
    summary_while_running,
    truncation,
    wait_in_action,
)

from sfly import Context, TaskInfo
from sfly.testing import ActionRecord, ActionSummary, Execution, run_node


def wait_for(check: Callable[[], bool], timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)


def by_name(result: Execution) -> dict[str, ActionRecord]:
    """按名称取记录（用例里每个名称只出现一次）。"""
    names = [a.name for a in result.actions]
    assert len(names) == len(set(names)), names
    return {a.name: a for a in result.actions}


def warnings_of(result: Execution) -> list[str]:
    return [line.message for line in result.logs if line.level == "warn" and line.source == "sdk"]


# ---- 结果 ----


def test_actions_end_with_success_failure_or_the_exception_they_leave_with() -> None:
    result = run_node(outcomes)

    assert result.status == "success", result.error
    assert [a.name for a in result.actions] == [
        "成功",
        "业务失败",
        "抛异常",
        "无消息的异常",
        "手动成功",
        "手动失败",
    ]
    assert [(a.result, a.reason) for a in result.actions] == [
        ("success", None),
        ("failed", "拒单：余额不足"),
        ("failed", "ValueError: 价格不能为负"),
        ("failed", "KeyError"),
        ("success", None),
        ("failed", "网关超时"),
    ]
    assert all(a.kind == "action" and a.duration_ms is not None for a in result.actions)
    assert by_name(result)["成功"].fields == {"订单": "1001"}
    # fail() 不抛异常，动作也不因此结束；异常离开 with 以后照常往外抛，节点自己接住了它。
    messages = [line.message for line in result.logs if line.source == "sdk"]
    assert messages == ["fail 之后动作还在进行", "异常照常往外抛"]


def test_cancelled_leaves_an_action_unfinished_but_not_a_failure() -> None:
    result = run_node(
        wait_in_action,
        cancel_when=lambda partial: any(a.name == "等待回报" for a in partial.actions),
    )

    assert result.status == "cancelled"
    [action] = result.actions
    assert (action.name, action.result, action.reason) == ("等待回报", "unfinished", None)
    assert action.duration_ms is not None


def test_an_action_that_already_failed_stays_failed_when_cancelled() -> None:
    result = run_node(
        fail_then_wait,
        cancel_when=lambda partial: any(a.name == "先失败再取消" for a in partial.actions),
    )

    assert result.status == "cancelled"
    [action] = result.actions
    assert (action.result, action.reason) == ("failed", "已经拒单")


def test_actions_still_running_when_the_node_ends_are_unfinished() -> None:
    result = run_node(leave_unfinished)

    assert result.status == "success", result.error
    assert [(a.name, a.result) for a in result.actions] == [
        ("从不结束", "unfinished"),
        ("正常结束", "success"),
    ]
    never = by_name(result)["从不结束"]
    assert never.duration_ms is not None and never.duration_ms >= 0
    # 任务结束，摘要里没有正在做的动作了；没有摘要之外的日志混进来。
    assert result.action_summary is not None
    assert result.action_summary.running == []


# ---- 嵌套、父动作、标记、note ----


def test_nested_actions_marks_and_explicit_parents() -> None:
    result = run_node(nesting)

    assert result.status == "success", result.error
    named = by_name(result)

    def parent_of(name: str) -> tuple[str | None, int]:
        record = named[name]
        parent = next((a.name for a in result.actions if a.id == record.parent), None)
        return parent, record.depth

    assert parent_of("外层") == (None, 0)
    assert parent_of("中层") == ("外层", 1)
    assert parent_of("内层") == ("中层", 2)
    assert parent_of("深处的标记") == ("内层", 3)
    # start() 在 with 里开始的动作，父动作是最内层的 with 动作；它自己不会成为后面动作的父动作。
    assert parent_of("手动开始") == ("中层", 2)
    assert parent_of("中层的另一个孩子") == ("中层", 2)
    assert parent_of("挂在句柄下") == ("手动开始", 3)
    # 内层已经结束，仍然可以用 parent= 把标记挂在它下面。
    assert parent_of("挂在内层下") == ("内层", 3)
    assert parent_of("外层的标记") == ("外层", 1)
    assert parent_of("第二个最外层") == (None, 0)
    assert named["深处的标记"].kind == "mark"
    assert (named["深处的标记"].result, named["深处的标记"].duration_ms) == (None, None)
    # 动作和标记共用一个 ID 序列。
    assert [a.id for a in result.actions] == list(range(1, len(result.actions) + 1))


def test_asyncio_tasks_nest_automatically_and_new_threads_start_at_the_top() -> None:
    result = run_node(concurrency)

    assert result.status == "success", result.error
    by_id = {a.id: a for a in result.actions}

    def parent_name(record: ActionRecord) -> str | None:
        return by_id[record.parent].name if record.parent is not None else None

    orders = [a for a in result.actions if a.name == "下单"]
    checks = [a for a in result.actions if a.name == "风控"]
    assert sorted(a.fields["编号"] for a in orders) == ["1", "2"]
    # 两个并发的 asyncio 任务各自嵌套、互不串。
    assert {parent_name(a) for a in orders} == {"并发下单"}
    for check in checks:
        assert by_id[check.parent or 0].fields["编号"] == check.fields["编号"]
    named = by_name_unique(result, ["并发下单", "保持", "线程里没有指定父动作", "线程里"])
    assert named["并发下单"].parent is None
    # 新线程从最外层开始，即使它是在 with 里启动的；parent= 能挂回去。
    assert named["线程里没有指定父动作"].parent is None
    assert named["线程里"].parent is None
    assert named["线程里"].fields == {"线程": "t"}
    [attached] = [a for a in result.actions if a.name == "线程里指定了父动作"]
    assert attached.parent == named["保持"].id and attached.depth == 1


def by_name_unique(result: Execution, names: list[str]) -> dict[str, ActionRecord]:
    return {a.name: a for a in result.actions if a.name in names}


def test_note_adds_fields_and_overrides_the_same_key() -> None:
    result = run_node(annotate)

    assert result.status == "success", result.error
    named = by_name(result)
    assert named["下单"].fields == {"订单": "1001", "价格": "10.5", "回报": "已成交"}
    assert named["手动"].fields == {"甲": "1", "乙": "2"}
    # 字段值一律是字符串。
    assert named["标记"].fields == {"数量": "3", "比例": "0.5", "备注": "None"}


# ---- 校验 ----


@pytest.mark.parametrize("how", ["action", "start", "mark"])
@pytest.mark.parametrize(
    ("name", "error"),
    [("", "ValueError"), ("   ", "ValueError"), (7, "TypeError"), (None, "TypeError")],
)
def test_an_empty_or_non_string_name_fails_the_call_immediately(
    how: str, name: object, error: str
) -> None:
    result = run_node(invalid_name, {"how": how, "name": name})

    assert result.status == "failed"
    assert result.error is not None and result.error.type == error
    assert result.actions == []
    assert [line.message for line in result.logs if line.source == "sdk"] == ["调用之前"]


def test_a_parent_that_is_not_an_action_is_a_type_error() -> None:
    result = run_node(invalid_parent)

    assert result.status == "failed"
    assert result.error is not None and result.error.type == "TypeError"


def test_a_parent_from_another_context_or_not_started_is_a_value_error(tmp_path: Path) -> None:
    ctx, _ = make_context(tmp_path)
    (tmp_path / "other").mkdir()
    other, _ = make_context(tmp_path / "other")
    foreign = other.action.start("别处的动作")

    with pytest.raises(ValueError, match="另一个"):
        ctx.mark("标记", parent=foreign)
    with pytest.raises(ValueError, match="还没有开始"):
        ctx.mark("标记", parent=ctx.action("没有进入"))


def test_overlong_names_extra_fields_and_long_values_are_cut_with_one_warning_each() -> None:
    result = run_node(truncation)

    assert result.status == "success", result.error
    first, second, marker = result.actions
    assert first.name == second.name == "名" * 64
    # 前 8 个字段留下，多出的丢弃；值超过 256 个字符的截断。
    assert list(first.fields) == ["内容", *[f"字段{i}" for i in range(7)]]
    assert first.fields["内容"] == "长" * 256
    assert marker.name == "长" * 64 and marker.fields == {"长值": "值" * 256}
    # 做了两次、又有标记，每种原因仍然只警告一次。
    warnings = warnings_of(result)
    assert len(warnings) == 3, warnings
    assert "动作的名称" in warnings[0] and "64" in warnings[0]
    assert "动作的字段值" in warnings[1] and "256" in warnings[1]
    assert "动作的字段" in warnings[2] and "超过 8 个" in warnings[2]


def test_warnings_about_a_mark_say_mark_and_not_action(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)

    many: dict[str, Any] = {f"字段{i}": i for i in range(9)}
    ctx.mark("长" * 65, 长值="值" * 257, **many)

    warnings = [e["message"] for e in only(events(), "log")]
    assert len(warnings) == 3, warnings
    assert "标记的名称" in warnings[0] and "64" in warnings[0]
    assert "标记的字段值" in warnings[1] and "256" in warnings[1]
    assert "标记的字段" in warnings[2] and "超过 8 个" in warnings[2]
    assert not any("动作" in warning for warning in warnings), warnings


def test_ending_a_handle_twice_is_ignored_with_one_warning() -> None:
    result = run_node(ended_twice)

    assert result.status == "success", result.error
    named = by_name(result)
    assert (named["重复结束"].result, named["重复结束"].reason) == ("success", None)
    assert (named["with 里的动作"].result, named["with 里的动作"].reason) == ("success", None)
    warnings = warnings_of(result)
    # 每个动作一条：前一个动作被多次调用，仍然只有一条。
    assert len(warnings) == 2, warnings
    assert "重复结束" in warnings[0] and "已经结束" in warnings[0]
    assert "with 里的动作" in warnings[1]


@pytest.mark.parametrize(("count", "warned"), [(100, False), (101, True), (150, True)])
def test_more_than_100_distinct_names_warns_once_and_suggests_fields(
    count: int, warned: bool
) -> None:
    result = run_node(many_names, {"count": count})

    assert result.status == "success", result.error
    assert len(result.actions) == count
    warnings = warnings_of(result)
    if warned:
        assert len(warnings) == 1, warnings
        # 这里记的都是标记：名称种数是动作和标记合计的。
        assert "动作和标记的名称" in warnings[0] and "100" in warnings[0] and "字段" in warnings[0]
    else:
        assert warnings == []


# ---- 摘要 ----


def test_summary_has_what_is_running_the_recent_ones_and_the_counts() -> None:
    seen: list[ActionSummary] = []

    def cancel_when(partial: Execution) -> bool:
        summary = partial.action_summary
        if summary is not None and {r.name for r in summary.running} == {"保持", "等回报"}:
            seen.append(summary)
        return bool(seen)

    result = run_node(summary_while_running, cancel_when=cancel_when)

    assert result.status == "cancelled"
    summary = seen[0]
    assert [(n.name, n.total, n.failed) for n in summary.names] == [
        ("下单", 4, 1),
        ("保持", 1, 0),
        ("进入保持", 1, 0),
        ("等回报", 1, 0),
    ]
    assert [(n.name, n.reported) for n in summary.names] == [
        ("下单", 4),
        ("保持", 1),
        ("进入保持", 1),
        ("等回报", 1),
    ]
    assert (summary.total, summary.reported, summary.capped_ts) == (7, 7, None)
    assert all(n.capped_ts is None for n in summary.names)
    hold, waiting = summary.running
    assert (hold.name, hold.parent, hold.depth, hold.result) == ("保持", None, 0, None)
    assert hold.fields == {"时长": "4h", "阶段": "加压"}
    assert (waiting.parent, waiting.depth, waiting.fields) == (hold.id, 1, {"订单": "4"})
    # 最近结束的在前。
    assert [(r.fields["订单"], r.result) for r in summary.recent] == [
        ("3", "failed"),
        ("2", "success"),
        ("1", "success"),
        ("0", "success"),
    ]
    [failed] = summary.recent_failed
    assert (failed.fields["订单"], failed.reason) == ("3", "拒单")
    assert failed.duration_ms is not None


def test_a_change_made_just_before_the_node_ends_is_still_in_the_final_summary() -> None:
    result = run_node(leave_unfinished)

    # 第一个动作开始时就发了一份摘要，第二个动作的变化不满一秒，靠退出时再发一次才到。
    assert result.action_summary is not None
    assert result.action_summary.total == 2
    assert [r.name for r in result.action_summary.recent] == ["正常结束"]


# ---- 事件的格式（直接读事件文件，#356、#357 按它解析）----


def make_context(tmp_path: Path) -> tuple[Context, Callable[[], list[dict[str, Any]]]]:
    """一个把事件写进文件的 `Context`，和读出到目前为止所有事件的函数（每次只解析新增的部分）。"""
    path = tmp_path / "events.jsonl"
    ctx = Context(
        events_path=path, cancel_path=None, artifacts_dir=None, artifacts_url=None, task=TaskInfo()
    )
    parsed: list[dict[str, Any]] = []
    offset = 0

    def events() -> list[dict[str, Any]]:
        nonlocal offset
        if path.exists():
            with path.open("rb") as f:
                f.seek(offset)
                data = f.read()
            complete = data[: data.rfind(b"\n") + 1]
            offset += len(complete)
            parsed.extend(json.loads(line) for line in complete.splitlines())
        return parsed

    return ctx, events


def without_times(event: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in event.items() if k not in ("ts", "mono")}


def only(events: list[dict[str, Any]], *types: str) -> list[dict[str, Any]]:
    return [e for e in events if e["type"] in types]


def test_events_carry_ids_parents_depths_fields_and_both_clocks(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)
    before = time.time() * 1000
    with ctx.action("下单", 订单=1001) as order:
        ctx.mark("收到第一笔成交", 订单=1001)
        order.note(回报="已成交")
    after = time.time() * 1000

    start, mark, end = only(events(), "action_start", "mark", "action_end")
    assert without_times(start) == {
        "type": "action_start",
        "id": 1,
        "parent": None,
        "depth": 0,
        "name": "下单",
        "fields": {"订单": "1001"},
    }
    assert without_times(mark) == {
        "type": "mark",
        "id": 2,
        "parent": 1,
        "depth": 1,
        "name": "收到第一笔成交",
        "fields": {"订单": "1001"},
    }
    assert without_times(end) == {
        "type": "action_end",
        "id": 1,
        "result": "success",
        "reason": None,
        "fields": {"回报": "已成交"},
    }
    for event in (start, mark, end):
        assert isinstance(event["ts"], int) and before - 1 <= event["ts"] <= after + 1
        assert isinstance(event["mono"], int) and event["mono"] > 0
    assert start["mono"] <= mark["mono"] <= end["mono"]


def test_mono_is_the_system_monotonic_clock_the_agent_reads(tmp_path: Path) -> None:
    # Linux 上是 CLOCK_BOOTTIME，其他系统是 CLOCK_MONOTONIC（agent/src/clock.rs）。
    clock = getattr(time, "CLOCK_BOOTTIME", getattr(time, "CLOCK_MONOTONIC", None))
    assert clock is not None
    ctx, events = make_context(tmp_path)

    low = time.clock_gettime_ns(clock) // 1_000_000
    ctx.mark("一个时刻")
    high = time.clock_gettime_ns(clock) // 1_000_000

    [mark] = only(events(), "mark")
    assert low <= mark["mono"] <= high


def test_durations_come_from_mono_so_changing_the_system_time_does_not_matter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx, events = make_context(tmp_path)
    clock = {"now": 1_700_000_000.0}
    monkeypatch.setattr(time, "time", lambda: clock["now"])

    handle = ctx.action.start("改系统时间")
    time.sleep(0.05)
    clock["now"] -= 3600  # 测试把 Agent 的系统时间往回改了一小时
    handle.end()

    start, end = only(events(), "action_start", "action_end")
    assert end["ts"] < start["ts"]
    assert end["mono"] - start["mono"] >= 50


def test_a_failure_event_has_the_exception_type_and_message(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)

    with pytest.raises(ValueError, match="价格"):
        with ctx.action("下单"):
            raise ValueError("价格不能为负")

    [end] = only(events(), "action_end")
    assert (end["result"], end["reason"]) == ("failed", "ValueError: 价格不能为负")


def test_a_very_long_failure_reason_is_cut(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)

    ctx.action.start("下单").fail("因" * 5000)

    [end] = only(events(), "action_end")
    assert len(end["reason"]) == 4096 and end["reason"].endswith("…")


def test_a_handle_is_ended_once_even_when_called_again(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)

    handle = ctx.action.start("下单")
    handle.end()
    handle.fail("晚了")
    handle.end()

    assert len(only(events(), "action_end")) == 1
    assert [e["message"] for e in only(events(), "log")] == [
        "动作 '下单' 已经结束，再次结束（或 note、fail）被忽略"
    ]


def test_the_summary_event_lists_names_running_recent_and_recent_failed(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)

    ctx.action.start("等回报", 订单=1)

    # 第一个动作开始时立即发出摘要。
    [summary] = only(events(), "action_summary")
    assert isinstance(summary["ts"], int) and isinstance(summary["mono"], int)
    [running] = summary["running"]
    assert without_times(summary) == {
        "type": "action_summary",
        "total": 1,
        "marks": 0,
        "reported": 1,
        "capped_ts": None,
        "capped_mono": None,
        "names": [
            {
                "name": "等回报",
                "total": 1,
                "failed": 0,
                "reported": 1,
                "capped_ts": None,
                "capped_mono": None,
            }
        ],
        "running": [
            {"id": 1, "parent": None, "depth": 0, "name": "等回报", "fields": {"订单": "1"}}
            | {"ts": running["ts"], "mono": running["mono"]}
        ],
        "recent": [],
        "recent_failed": [],
    }


def test_the_summary_counts_marks_apart_from_actions(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)

    with ctx.action("下单"):
        ctx.mark("收到第一笔成交")
    ctx.mark("收到第一笔成交")
    ctx.action.start("等回报")

    wait_for(lambda: only(events(), "action_summary")[-1]["total"] == 4)
    assert only(events(), "action_summary")[-1]["marks"] == 2


def test_the_summary_keeps_at_most_50_running_the_shallowest_first(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)

    outer = ctx.action.start("最外层")
    for i in range(60):
        ctx.action.start("并发", parent=outer, 编号=i)
    ctx.action.start("很晚才开始的最外层")

    # 62 个正在做：最外层 2 个，加上层级浅的、开始早的 48 个；列表按 ID 排列。
    wait_for(lambda: only(events(), "action_summary")[-1]["total"] == 62)
    running = only(events(), "action_summary")[-1]["running"]
    assert [r["id"] for r in running] == [*range(1, 50), 62]
    assert [r["depth"] for r in running][:2] == [0, 1] and running[-1]["depth"] == 0


def test_recent_keeps_20_and_recent_failed_5_newest_first(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)

    for i in range(30):
        handle = ctx.action.start("下单", 订单=i)
        if i % 2:
            handle.fail("拒单")
        else:
            handle.end()

    wait_for(lambda: only(events(), "action_summary")[-1]["total"] == 30)
    final = only(events(), "action_summary")[-1]
    assert [r["fields"]["订单"] for r in final["recent"]] == [str(i) for i in range(29, 9, -1)]
    assert [r["fields"]["订单"] for r in final["recent_failed"]] == ["29", "27", "25", "23", "21"]
    assert {r["result"] for r in final["recent_failed"]} == {"failed"}
    assert final["names"][0]["failed"] == 15


def test_summaries_are_sent_at_most_once_a_second_and_a_late_change_still_arrives(
    tmp_path: Path,
) -> None:
    ctx, events = make_context(tmp_path)

    started = time.monotonic()
    count = 0
    while time.monotonic() - started < 1.5:
        with ctx.action("下单"):
            time.sleep(0.002)
        count += 1
    elapsed = time.monotonic() - started

    # 第一个动作开始时发一份，之后每满一秒最多发一份。
    assert len(only(events(), "action_summary")) <= int(elapsed) + 1
    # 节点之后再没有动作，最后的变化也会在满一秒时发出，不会一直停在旧的状态。
    wait_for(lambda: only(events(), "action_summary")[-1]["total"] == count)
    wait_for(lambda: only(events(), "action_summary")[-1]["running"] == [])
    assert len(only(events(), "action_summary")) <= int(time.monotonic() - started) + 1


def test_nothing_is_sent_until_an_action_or_mark_is_used(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)

    ctx.log.info("只有日志")

    assert [e["type"] for e in events()] == ["log"]


# ---- 上限（用真实的数字：每种名称 5 万个，合计 10 万个）----


def test_after_50000_of_a_name_only_counts_but_failures_still_get_a_detail(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)

    for _ in range(50_000):
        ctx.action.start("下单").end()
    assert len(only(events(), "action_start")) == 50_000
    ctx.action.start("下单").end()
    ctx.action.start("下单").end()
    late_failure = ctx.action.start("下单", 订单="late")
    late_failure.fail("拒单")
    ctx.action.start("别的名称").end()

    starts = only(events(), "action_start")
    ends = only(events(), "action_end")
    # 第 50001、50002 个动作成功了，没有任何明细；失败的补上了开始和结束；别的名称不受影响。
    assert [e["name"] for e in starts[-2:]] == ["下单", "别的名称"]
    assert [e["id"] for e in starts[-2:]] == [50_003, 50_004]
    assert starts[-2]["fields"] == {"订单": "late"}
    # 只有补发的开始带 late：读取方据此知道这个动作超过了每种名称的上限、是失败的。
    assert [e["id"] for e in starts if e.get("late")] == [50_003]
    assert starts[-2]["late"] is True and "late" not in starts[-1] and "late" not in starts[0]
    assert [(e["id"], e["result"], e["reason"]) for e in ends[-2:]] == [
        (50_003, "failed", "拒单"),
        (50_004, "success", None),
    ]
    assert len(starts) == 50_002 and len(ends) == 50_002
    # 补发的开始带着动作真正开始的时刻，早于结束。
    assert starts[-2]["mono"] <= ends[-2]["mono"]
    warnings = [e["message"] for e in only(events(), "log")]
    assert len(warnings) == 1 and "'下单'" in warnings[0] and "50000" in warnings[0]
    assert "指标" in warnings[0]

    wait_for(lambda: only(events(), "action_summary")[-1]["total"] == 50_004)
    summary = only(events(), "action_summary")[-1]
    by_name_ = {n["name"]: n for n in summary["names"]}
    assert (by_name_["下单"]["total"], by_name_["下单"]["failed"]) == (50_003, 1)
    # 已上报的明细包括补发的那一个：只计数的动作是 total 减 reported，即 2 个。
    assert by_name_["下单"]["reported"] == 50_001
    assert by_name_["别的名称"]["reported"] == 1
    assert by_name_["下单"]["capped_ts"] is not None and by_name_["下单"]["capped_mono"] is not None
    assert by_name_["别的名称"]["capped_ts"] is None
    assert (summary["reported"], summary["capped_ts"]) == (50_002, None)
    assert sum(n["reported"] for n in summary["names"]) == summary["reported"]
    # 超过上限的动作也在最近的动作里，失败的在最近失败里。
    assert summary["recent"][0]["name"] == "别的名称"
    assert [r["fields"] for r in summary["recent_failed"]] == [{"订单": "late"}]


def test_the_per_name_cap_warning_for_marks_says_mark_and_has_no_failure_backfill(
    tmp_path: Path,
) -> None:
    ctx, events = make_context(tmp_path)

    for _ in range(50_001):
        ctx.mark("收到成交")

    assert len(only(events(), "mark")) == 50_000
    warnings = [e["message"] for e in only(events(), "log")]
    assert len(warnings) == 1, warnings
    assert "'收到成交'" in warnings[0] and "50000" in warnings[0]
    assert "标记" in warnings[0] and "按批记录标记" in warnings[0]
    assert "动作" not in warnings[0] and "失败" not in warnings[0], warnings[0]


def test_after_100000_in_all_nothing_more_is_reported_not_even_failures(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)

    for _ in range(50_000):
        ctx.action.start("甲").end()
    for _ in range(49_999):
        ctx.action.start("乙").end()
    assert len(only(events(), "action_start")) == 99_999
    # 甲已经超过每种名称的上限：失败的补上明细，直到合计 10 万个，这是最后一个。
    ctx.action.start("甲").fail("补上了")
    assert len(only(events(), "action_start")) == 100_000
    ctx.action.start("甲").fail("合计到了，不再补")
    ctx.action.start("丙").end()
    ctx.action.start("丙").fail("新的名称也不再上报")
    ctx.mark("丁")

    starts = only(events(), "action_start", "mark")
    assert len(starts) == 100_000
    assert [e["type"] for e in only(events(), "action_end")[-1:]] == ["action_end"]
    assert only(events(), "action_end")[-1]["reason"] == "补上了"
    warnings = [e["message"] for e in only(events(), "log")]
    assert len(warnings) == 2, warnings
    assert "'甲'" in warnings[0] and "50000" in warnings[0]
    assert "100000" in warnings[1] and "指标" in warnings[1]

    wait_for(lambda: only(events(), "action_summary")[-1]["total"] == 100_004)
    summary = only(events(), "action_summary")[-1]
    assert (summary["total"], summary["reported"]) == (100_004, 100_000)
    assert summary["capped_ts"] is not None and summary["capped_mono"] is not None
    by_name_ = {n["name"]: n for n in summary["names"]}
    assert (by_name_["甲"]["total"], by_name_["甲"]["failed"]) == (50_002, 2)
    assert (by_name_["丙"]["total"], by_name_["丙"]["failed"]) == (2, 1)
    assert [by_name_[name]["reported"] for name in ("甲", "乙", "丙", "丁")] == [
        50_001,
        49_999,
        0,
        0,
    ]
    assert sum(n["reported"] for n in summary["names"]) == summary["reported"]
    assert by_name_["丙"]["capped_ts"] is not None
    assert by_name_["乙"]["capped_ts"] is None
    assert [r["reason"] for r in summary["recent_failed"]] == [
        "新的名称也不再上报",
        "合计到了，不再补",
        "补上了",
    ]


def test_the_total_cap_warning_names_both_actions_and_marks_whichever_hits_it(
    tmp_path: Path,
) -> None:
    ctx, events = make_context(tmp_path)

    for _ in range(50_000):
        ctx.action.start("甲").end()
    for _ in range(49_999):
        ctx.mark("乙")
    ctx.mark("丙")
    assert len(only(events(), "action_start", "mark")) == 100_000
    assert only(events(), "log") == []

    ctx.mark("丁")
    ctx.action.start("戊").end()
    ctx.mark("己")

    assert len(only(events(), "action_start", "mark")) == 100_000
    warnings = [e["message"] for e in only(events(), "log")]
    assert len(warnings) == 1, warnings
    assert "100000" in warnings[0] and "标记" in warnings[0] and "动作" in warnings[0]
    assert "按批记录动作和标记" in warnings[0] and "指标" in warnings[0]


def test_a_failure_whose_detail_the_total_cap_drops_after_a_late_one_still_warns(
    tmp_path: Path,
) -> None:
    ctx, events = make_context(tmp_path)

    for _ in range(50_000):
        ctx.action.start("甲").end()
    for _ in range(49_999):
        ctx.action.start("乙").end()
    # 这两个甲开始时合计还差一个才到 10 万，但甲已经超过每种名称的上限，所以都没有上报开始。
    first = ctx.action.start("甲", 序号=1)
    second = ctx.action.start("甲", 序号=2)
    assert len(only(events(), "action_start")) == 99_999
    assert len(only(events(), "log")) == 1

    first.fail("补上明细，合计正好 10 万")
    assert [e["fields"] for e in only(events(), "action_start")[-1:]] == [{"序号": "1"}]
    assert len(only(events(), "action_start")) == 100_000
    second.fail("明细被丢弃")

    assert len(only(events(), "action_start")) == 100_000
    warnings = [e["message"] for e in only(events(), "log")]
    assert len(warnings) == 2, warnings
    assert "'甲'" in warnings[0] and "50000" in warnings[0]
    assert "100000" in warnings[1] and "指标" in warnings[1]

    # 失败的动作都在最近失败里，丢弃明细的也在；等两个都失败以后的那一份摘要。
    wait_for(lambda: len(only(events(), "action_summary")[-1]["recent_failed"]) == 2)
    summary = only(events(), "action_summary")[-1]
    assert [r["reason"] for r in summary["recent_failed"]] == [
        "明细被丢弃",
        "补上明细，合计正好 10 万",
    ]
    assert (summary["total"], summary["reported"]) == (100_001, 100_000)
    assert summary["capped_ts"] is not None and summary["capped_mono"] is not None
