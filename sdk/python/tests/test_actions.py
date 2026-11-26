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
    long_texts,
    many_names,
    nesting,
    outcomes,
    outlived,
    summary_while_running,
    truncation,
    wait_in_action,
)

from sfly import Context, TaskInfo
from sfly.actions import (
    _NAME_ENTRY_OVERHEAD,
    MAX_NAME_CHARS,
    MAX_REASON_CHARS,
    MAX_SUMMARY_BYTES,
    MAX_SUMMARY_NAMES,
    MAX_VALUE_CHARS,
    NAMES_BUDGET_BYTES,
    TRANSPORT_MARGIN_CHARS,
    Actions,
)
from sfly.context import _dumps
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


def test_a_task_that_outlives_its_with_does_not_nest_under_the_ended_action() -> None:
    result = run_node(outlived)

    assert result.status == "success", result.error
    named = by_name(result)
    # with 里起的任务复制了上下文：内层结束之后开始的动作挂到还没结束的外层下，
    # 外层也结束之后就在最外层。
    assert named["内层结束之后"].parent == named["外层"].id
    assert named["内层结束之后"].depth == 1
    assert named["外层结束之后"].parent is None
    assert named["外层结束之后"].depth == 0


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
    # 节点自己的日志只有调用之前的那一行；执行器在失败时另写的一行出错位置（#471）不算。
    own = [line.message for line in result.logs if line.source == "sdk"]
    assert [m for m in own if not m.startswith("出错位置：")] == ["调用之前"]


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


def test_a_very_long_failure_reason_is_cut_at_the_transport_limit(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)

    ctx.action.start("下单").fail("因" * 9000)

    [end] = only(events(), "action_end")
    sent = MAX_REASON_CHARS + TRANSPORT_MARGIN_CHARS
    assert len(end["reason"]) == sent and end["reason"].endswith("…")
    assert end["reason"][:-1] == "因" * (sent - 1)


# ---- 名称、字段值、失败原因的上限由控制面执行：
# SDK 只在比上限多 TRANSPORT_MARGIN_CHARS 个字符处截断 ----

SECRET = "ZEBRA-secret-token-0123456789"


def fragments(secret: str, size: int = 4) -> list[str]:
    """secret 值里每一段 `size` 个字符。"""
    return [secret[i : i + size] for i in range(len(secret) - size + 1)]


def test_names_values_and_reasons_are_sent_past_their_limits_up_to_the_transport_limit(
    tmp_path: Path,
) -> None:
    ctx, events = make_context(tmp_path)
    name = "名" * (MAX_NAME_CHARS + 30)
    value = "值" * (MAX_VALUE_CHARS + 30)

    ctx.action.start(name, 内容=value).fail("因" * (MAX_REASON_CHARS + 30))

    [start] = only(events(), "action_start")
    [end] = only(events(), "action_end")
    # 超过上限的部分也发出去，由控制面先打码、再截到上限
    assert start["name"] == name
    assert start["fields"] == {"内容": value}
    assert end["reason"] == "因" * (MAX_REASON_CHARS + 30)
    # 比上限多出的余量用完才截断
    longest = "名" * (MAX_NAME_CHARS + TRANSPORT_MARGIN_CHARS + 50)
    ctx.action.start(longest, 内容="值" * (MAX_VALUE_CHARS + TRANSPORT_MARGIN_CHARS + 50)).end()
    [_, start2] = only(events(), "action_start")
    assert len(start2["name"]) == MAX_NAME_CHARS + TRANSPORT_MARGIN_CHARS
    assert len(start2["fields"]["内容"]) == MAX_VALUE_CHARS + TRANSPORT_MARGIN_CHARS


def test_a_secret_across_the_documented_limit_is_sent_whole(tmp_path: Path) -> None:
    """secret 值正好跨在名称、字段值、失败原因的上限处：整个值都在发出的文字里，
    控制面才认得出来。"""
    ctx, events = make_context(tmp_path)

    ctx.action.start(
        "n" * (MAX_NAME_CHARS - 10) + SECRET,
        内容="v" * (MAX_VALUE_CHARS - 10) + SECRET,
    ).fail("r" * (MAX_REASON_CHARS - 10) + SECRET)

    [start] = only(events(), "action_start")
    [end] = only(events(), "action_end")
    assert SECRET in start["name"] and SECRET in start["fields"]["内容"] and SECRET in end["reason"]


def test_names_that_differ_only_after_the_limit_are_counted_as_one_name(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)
    head = "接口" * (MAX_NAME_CHARS // 2)

    ctx.action.start(head + "A").end()
    ctx.action.start(head + "B").end()

    # 计数和每种名称的上限按名称的前 MAX_NAME_CHARS 个字符（和控制面一致）；
    # 摘要里写第一次出现的完整名称
    ctx.action.start("别的").end()
    wait_for(lambda: only(events(), "action_summary")[-1]["total"] == 3)
    names = only(events(), "action_summary")[-1]["names"]
    assert [(n["name"], n["total"]) for n in names] == [(head + "A", 2), ("别的", 1)]
    assert len(only(events(), "action_start")) == 3


def test_the_summary_lists_only_the_first_1000_names_and_the_names_table_stops_growing(
    tmp_path: Path,
) -> None:
    """名称的种类不设上限的话，摘要（每秒一份）和 SDK 进程里记名称的表都随种类数一直涨（#694）：
    摘要只列前 MAX_SUMMARY_NAMES 种（和控制面存下的一致），记名称的表也不再增长；
    没列出的名称合在一起
    写成 `unlisted`，名称表不是全部（`names_complete` 为 false）。"""
    ctx, events = make_context(tmp_path)
    count = MAX_SUMMARY_NAMES + 1500
    tail = "名" * 50  # 名称不太长：名称表放得下 1000 种，停下来的是种类数
    for i in range(count):
        ctx.mark(f"{i:05d}-{tail}")

    # 记名称的表停在上限，不随种类数涨
    assert len(ctx.action._names) == MAX_SUMMARY_NAMES
    wait_for(lambda: only(events(), "action_summary")[-1]["total"] == count)
    summary = only(events(), "action_summary")[-1]
    names = summary["names"]
    assert len(names) == MAX_SUMMARY_NAMES
    # 按第一次出现的先后：前 MAX_SUMMARY_NAMES 种
    assert names[0]["name"].startswith("00000-")
    assert names[-1]["name"].startswith(f"{MAX_SUMMARY_NAMES - 1:05d}-")
    assert all(n["total"] == 1 for n in names)
    # 合计、标记的个数、有明细的个数照常准确；每个标记都有明细（没有超过合计的上限）
    assert (summary["total"], summary["marks"], summary["reported"]) == (count, count, count)
    assert len(only(events(), "mark")) == count
    # 没列出的名称：个数、失败数、有明细的个数合在一起；名称表不是全部
    assert summary["names_complete"] is False
    assert summary["unlisted"] == {"total": 1500, "failed": 0, "reported": 1500}
    assert summary["failed"] == 0
    # 每一份摘要的大小都在字节预算以内
    assert all(
        len(_dumps(e).encode()) + 1 <= MAX_SUMMARY_BYTES for e in only(events(), "action_summary")
    )
    # 警告（名称超过文档里的上限的那一条不算）：第 101 种一次，第 1001 种一次，
    # 写明从这一种起不进名称表
    warnings = [
        e["message"] for e in only(events(), "log") if e["level"] == "warn" and "种" in e["message"]
    ]
    assert len(warnings) == 2, warnings
    assert "100" in warnings[0] and "字段" in warnings[0]
    assert str(MAX_SUMMARY_NAMES) in warnings[1] and "名称表" in warnings[1]


def test_a_summary_with_every_name_listed_says_so(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)
    ctx.action.start("甲").fail("拒单")
    ctx.action.flush()  # 第一份是动作开始时发的；失败的变化不满一秒，靠这里再发一次
    summary = only(events(), "action_summary")[-1]
    assert (summary["failed"], summary["names_complete"], summary["unlisted"]) == (1, True, None)
    assert (summary["running_complete"], summary["lists_trimmed"]) == (True, False)


def test_names_over_the_summary_cap_are_one_name_under_the_per_name_cap_and_failures_backfill(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """进不了名称表的名称共用一份计数，当作一种名称：同样受每种名称的上限，之后只计数；失败的动作
    照常补发明细（带 `late`），直到合计的上限（#726）。"""
    monkeypatch.setattr("sfly.actions.MAX_SUMMARY_NAMES", 3)
    monkeypatch.setattr("sfly.actions.MAX_PER_NAME", 2)
    ctx, events = make_context(tmp_path)

    for name in ("甲", "乙", "丙"):
        ctx.action.start(name).end()
    for _ in range(4):  # 在表里的名称：每种名称的上限（2 个）
        ctx.action.start("甲").end()
    for name in ("丁", "戊", "丁", "戊", "丁", "戊"):  # 不在表里的：合在一起也只上报 2 个
        ctx.action.start(name).end()
    ctx.action.start("己").fail("拒单")  # 超过上限之后失败：补发明细

    wait_for(lambda: only(events(), "action_summary")[-1]["total"] == 14)
    summary = only(events(), "action_summary")[-1]
    assert [(n["name"], n["total"], n["reported"]) for n in summary["names"]] == [
        ("甲", 5, 2),
        ("乙", 1, 1),
        ("丙", 1, 1),
    ]
    assert summary["unlisted"] == {"total": 7, "failed": 1, "reported": 3}  # 2 个加上补发的 1 个
    assert summary["failed"] == 1 and summary["names_complete"] is False
    assert summary["reported"] == 3 + 2 + 1 + 1  # 表里 1+1+1，甲多的 1，没列出的 2 加补发的 1
    starts = only(events(), "action_start")
    assert [e["name"] for e in starts if e["name"] in ("丁", "戊", "己")] == ["丁", "戊", "己"]
    late = [e for e in starts if e.get("late")]
    assert [e["name"] for e in late] == ["己"]
    ends = only(events(), "action_end")
    assert ends[-1]["result"] == "failed" and ends[-1]["reason"] == "拒单"
    assert [r["name"] for r in summary["recent_failed"]] == ["己"]
    # 警告：没有列出的名称合在一起写一次，不指名称
    warnings = [e["message"] for e in only(events(), "log") if e["level"] == "warn"]
    shared = [w for w in warnings if "没有列出的名称" in w and "已上报 2 个" in w]
    assert len(shared) == 1, warnings
    assert not any("丁" in w or "戊" in w or "己" in w for w in warnings), warnings


def test_names_over_the_summary_cap_are_still_limited_by_the_total_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """合计的上限照旧约束它们；只计数时的警告写的是合计，不是「某种名称超过每种名称的上限」。"""
    monkeypatch.setattr("sfly.actions.MAX_SUMMARY_NAMES", 2)
    monkeypatch.setattr("sfly.actions.MAX_PER_NAME", 100)
    monkeypatch.setattr("sfly.actions.MAX_TOTAL", 6)
    ctx, events = make_context(tmp_path)

    ctx.action.start("甲").end()
    ctx.action.start("乙").end()
    for _ in range(4):  # 丙起不在表里：到合计的上限（6）为止
        ctx.action.start("丙").end()
    ctx.action.start("丁").end()  # 合计已满：只计数
    ctx.action.start("己").fail("拒单")  # 失败的动作也只计数，不抛错

    wait_for(lambda: only(events(), "action_summary")[-1]["total"] == 8)
    summary = only(events(), "action_summary")[-1]
    assert summary["reported"] == 6 and summary["capped_ts"] is not None
    assert [e["name"] for e in only(events(), "action_start")] == [
        "甲",
        "乙",
        "丙",
        "丙",
        "丙",
        "丙",
    ]
    assert summary["unlisted"] == {"total": 6, "failed": 1, "reported": 4}
    assert [r["name"] for r in summary["recent_failed"]] == ["己"]
    warnings = [e["message"] for e in only(events(), "log") if e["level"] == "warn"]
    assert sum("已上报 6 个" in w for w in warnings) == 1, warnings  # 合计的上限：整个任务一次
    assert not any("没有列出的名称" in w and "已上报 100 个" in w for w in warnings), warnings


def test_the_failed_total_counts_failures_of_names_that_are_not_in_the_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """控制台的失败数用 `failed`：只数名称表里各项会少算没进表的名称的失败（#726）。"""
    monkeypatch.setattr("sfly.actions.MAX_SUMMARY_NAMES", 2)
    ctx, events = make_context(tmp_path)
    ctx.action.start("甲").fail("一")
    ctx.action.start("乙").end()
    for name in ("丙", "丁", "丙"):  # 没进表
        ctx.action.start(name).fail("二")

    wait_for(lambda: only(events(), "action_summary")[-1]["total"] == 5)
    summary = only(events(), "action_summary")[-1]
    assert [n["failed"] for n in summary["names"]] == [1, 0]  # 表里的只有 1 个
    assert summary["unlisted"]["failed"] == 3
    assert summary["failed"] == 4  # 全部名称合计
    assert len(summary["recent_failed"]) == 4


# ---- 一份摘要的字节上界（#726）----


class _Sink:
    """记下每份摘要序列化之后的字节数（含换行）和最后一份摘要；别的事件丢掉。"""

    def __init__(self) -> None:
        self.last: dict[str, Any] | None = None
        self.sizes: list[int] = []

    def write(self, event: dict[str, Any]) -> None:
        if event["type"] == "action_summary":
            self.last = event
            self.sizes.append(len(_dumps(event).encode()) + 1)


def sink_actions() -> tuple[Actions, _Sink]:
    sink = _Sink()
    seen: set[tuple[str, str]] = set()

    def warn(reason: str, name: str, message: str) -> None:
        seen.add((reason, name))

    actions = Actions(sink, warn)  # type: ignore[arg-type]
    actions.warned = seen  # type: ignore[attr-defined]
    return actions, sink


def fill_with_the_longest_texts(actions: Actions, char: str, *, names: int) -> None:
    """名称、字段的键和值、失败原因都取 SDK 能发出的最长：正在做的 60 个（超过列表的 50 个）、
    结束的 25 个（其中 6 个失败，超过最近失败的 5 个）、`names` 种名称各一个标记。"""
    name = char * (MAX_NAME_CHARS + TRANSPORT_MARGIN_CHARS - 8)
    fields = {
        f"{k}{char * (MAX_NAME_CHARS + TRANSPORT_MARGIN_CHARS - 1)}": char
        * (MAX_VALUE_CHARS + TRANSPORT_MARGIN_CHARS)
        for k in range(8)
    }
    reason = char * (MAX_REASON_CHARS + TRANSPORT_MARGIN_CHARS + 100)
    for i in range(60):
        actions.start(f"进行中{i:02d}{name}", **fields)  # type: ignore[arg-type]
    for i in range(25):
        handle = actions.start(f"结束{i:02d}{name}", **fields)  # type: ignore[arg-type]
        handle.fail(reason) if i < 6 else handle.end()
    for i in range(names):
        actions.mark(f"{i:05d}{name}")
    actions.flush()


@pytest.mark.parametrize(
    "char", ["名", "\U00020000", "\x01"], ids=["三字节", "四字节", "要转义的控制字符"]
)
def test_a_summary_never_exceeds_the_byte_budget_whatever_the_texts_are(char: str) -> None:
    """名称、字段、失败原因在传输时各自可以比显示的上限多四千多个字符（3 字节、4 字节、转义成 6
    字节的
    字符各有各的写出来的大小）：1000 种名称加三个列表列满，不设字节预算时是几十 MiB。
    按写出去的字节算。"""
    actions, sink = sink_actions()
    fill_with_the_longest_texts(actions, char, names=MAX_SUMMARY_NAMES + 200)

    assert sink.last is not None
    assert max(sink.sizes) <= MAX_SUMMARY_BYTES
    summary = sink.last
    # 名称表放不下：按第一次出现的先后进，进了就不出；剩下的合并成 unlisted
    assert summary["names_complete"] is False
    assert 0 < len(summary["names"]) < MAX_SUMMARY_NAMES
    assert (
        summary["unlisted"]["total"] + sum(n["total"] for n in summary["names"]) == summary["total"]
    )
    names_bytes = sum(len(_dumps(n).encode()) + 2 for n in summary["names"])
    assert names_bytes <= NAMES_BUDGET_BYTES
    # 最近失败的最后省：名称表放不下三个列表时，它们里至少还留着最近失败的
    assert summary["failed"] == 6
    assert summary["recent_failed"], "最近失败的先留"
    # 列表装不下时标明
    if len(summary["running"]) < 50 or len(summary["recent"]) < 20:
        assert summary["lists_trimmed"] is True
    if len(summary["running"]) < 60:
        assert summary["running_complete"] is False


def test_normal_names_and_full_lists_fit_far_below_the_budget_and_nothing_is_trimmed() -> None:
    """名称几十个字符的正常用法：1000 种名称加三个列表列满，远小于预算，行为不变。"""
    actions, sink = sink_actions()
    for i in range(920):  # 加上下面的 75 个，名称一共不超过 1000 种
        actions.mark(f"订单{i:04d}的处理与回报流程节点名称")
    for i in range(50):
        actions.start(f"进行中{i}", 订单=i, 价格="1.5", 账户="acc-1")
    for i in range(25):
        h = actions.start(f"结束{i}", 订单=i)
        h.fail("拒单：余额不足") if i < 8 else h.end()
    actions.flush()

    assert sink.last is not None
    summary = sink.last
    assert (summary["names_complete"], summary["unlisted"]) == (True, None)
    assert (len(summary["running"]), len(summary["recent"]), len(summary["recent_failed"])) == (
        50,
        20,
        5,
    )
    assert (summary["running_complete"], summary["lists_trimmed"]) == (True, False)
    assert sink.sizes[-1] < MAX_SUMMARY_BYTES // 2  # 量到的约 0.3 MiB


def test_when_the_lists_do_not_fit_the_lowest_priority_is_dropped_first_and_it_is_marked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """三个列表按「最近失败的、正在做的、最近结束的」的先后留；一项装不下就停，后面的列表不再装。"""
    actions, sink = sink_actions()
    actions.mark("m")
    for i in range(3):
        actions.start(f"进行中{i}", 说明="x" * 100)
    for i in range(4):
        actions.start(f"结束{i}", 说明="x" * 100).end()
    for i in range(2):
        actions.start(f"失败{i}", 说明="x" * 100).fail("拒单")
    actions.flush()
    assert sink.last is not None
    full = sink.last

    def cost(entries: list[dict[str, Any]]) -> list[int]:
        return [len(_dumps(e).encode()) + 2 for e in entries]

    failed, running, recent = (
        cost(full["recent_failed"]),
        cost(full["running"]),
        cost(full["recent"]),
    )
    assert (len(failed), len(running), len(recent)) == (2, 3, 6)  # 结束的 4 个加失败的 2 个
    # 装列表之前的大小（两个标记都按最长的写：`false`）
    empty = {**full, "running": [], "recent": [], "recent_failed": [], "running_complete": False}
    base = len(_dumps(empty).encode()) + 1

    def with_room(room: int) -> dict[str, Any]:
        monkeypatch.setattr("sfly.actions.MAX_SUMMARY_BYTES", base + room)
        actions._dirty = True
        actions.flush()
        assert sink.last is not None
        assert sink.sizes[-1] <= base + room  # 实际的大小不超过预算，差一个字节也不行
        return sink.last

    # 差一个字节：最近结束的少最后一项（最老的），别的都在
    a = with_room(sum(failed) + sum(running) + sum(recent) - 1)
    assert (len(a["recent_failed"]), len(a["running"]), len(a["recent"])) == (2, 3, 5)
    assert (a["lists_trimmed"], a["running_complete"]) == (True, True)
    # 少到正在做的最后一个装不下：最近结束的一项也不留（优先级低的先省），最近失败的都在
    b = with_room(sum(failed) + sum(running) - 1)
    assert (len(b["recent_failed"]), len(b["running"]), len(b["recent"])) == (2, 2, 0)
    assert (b["lists_trimmed"], b["running_complete"]) == (True, False)
    # 只装得下最近失败的第一项（最近的）
    c = with_room(failed[0])
    assert [e["name"] for e in c["recent_failed"]] == ["失败1"]
    assert (c["running"], c["recent"]) == ([], [])
    assert (c["lists_trimmed"], c["running_complete"]) == (True, False)
    # 什么都装不下：三个列表都空，摘要的其余部分照旧
    d = with_room(0)
    assert (d["recent_failed"], d["running"], d["recent"]) == ([], [], [])
    assert (d["total"], d["failed"]) == (full["total"], 2)


def test_running_complete_says_whether_every_running_action_is_listed() -> None:
    actions, sink = sink_actions()
    for i in range(50):
        actions.start(f"a{i}")
    actions.flush()
    assert sink.last is not None and sink.last["running_complete"] is True  # 正好 50 个：全部
    actions.start("a50")
    actions._dirty = True
    actions.flush()
    assert sink.last["running_complete"] is False and len(sink.last["running"]) == 50


def test_a_name_that_does_not_fit_the_names_budget_goes_to_the_shared_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """名称太长、名称表的字节预算放不下时，这一种并进共用的一份（警告一次）；后面放得下的名称照常进表。"""
    monkeypatch.setattr("sfly.actions.NAMES_BUDGET_BYTES", 1200)
    actions, sink = sink_actions()
    actions.mark("短")
    actions.mark("长" * 900)  # 放不下
    actions.mark("长" * 901)  # 放不下，另一种
    actions.mark("又短")
    actions.mark("长" * 900)  # 同一种名称再来：还是共用的那一份
    actions.flush()
    assert sink.last is not None
    assert [n["name"] for n in sink.last["names"]] == ["短", "又短"]
    assert sink.last["unlisted"] == {"total": 3, "failed": 0, "reported": 3}
    assert sink.last["names_complete"] is False
    warned = actions.warned  # type: ignore[attr-defined]
    assert [r for r, _ in warned if r == "names-over-bytes"] == ["names-over-bytes"]
    assert len(actions._names) == 2  # 记名称的表也没有记它们


def test_the_names_budget_bounds_every_table_entry_even_with_the_biggest_counters() -> None:
    """名称表一项最多占的字节（计数取最大的位数）：进表时按它记账，所以名称表的大小有上界。"""
    entry = {
        "name": "",
        "total": 10**15 - 1,
        "failed": 10**15 - 1,
        "reported": 10**15 - 1,
        "capped_ts": 10**15 - 1,
        "capped_mono": 10**15 - 1,
    }
    assert len(_dumps(entry).encode()) - 2 + 2 <= _NAME_ENTRY_OVERHEAD


def test_warnings_never_quote_the_cut_text(tmp_path: Path) -> None:
    """警告里不写名称、字段值被截断后的内容：截断会把里面的 secret 值切成两半，
    前半截控制面认不出来。"""
    ctx, events = make_context(tmp_path)
    long_name = "n" * (MAX_NAME_CHARS - 10) + SECRET
    long_value = "v" * (MAX_VALUE_CHARS - 10) + SECRET

    long_key = "k" * (MAX_NAME_CHARS - 10) + SECRET
    with ctx.action(long_name, **{long_key: long_value}):
        pass
    ctx.mark(long_name, 内容=long_value)
    handle = ctx.action.start(long_name)
    handle.end()
    handle.end()  # 再结束一次：警告里引用动作的名称

    warnings = [e["message"] for e in only(events(), "log") if e["level"] == "warn"]
    assert any("名称" in w for w in warnings) and any("字段值" in w for w in warnings), warnings
    assert any("已经结束" in w for w in warnings), warnings
    for warning in warnings:
        assert not any(piece in warning for piece in fragments(SECRET)), warning
    # 写的是长度和上限
    assert any(str(len(long_name)) in w and str(MAX_NAME_CHARS) in w for w in warnings), warnings
    assert any(str(len(long_value)) in w and str(MAX_VALUE_CHARS) in w for w in warnings), warnings


def test_the_summary_carries_the_full_name_not_the_one_used_for_counting(tmp_path: Path) -> None:
    """摘要里正在做的、最近结束的、最近失败的动作，名称是发出去的完整的那个（控制面按它先打码再截到上限）；
    计数用的前 MAX_NAME_CHARS 个字符只在 SDK 内部。"""
    ctx, events = make_context(tmp_path)
    name = "名" * (MAX_NAME_CHARS + 30)
    running = ctx.action.start(name + "-进行中")
    ctx.action.start(name + "-结束").end()
    ctx.action.start(name + "-失败").fail("原因")
    wait_for(lambda: bool(only(events(), "action_summary")))
    running.end()
    last = only(events(), "action_summary")[-1]
    entries = [*last["running"], *last["recent"], *last["recent_failed"]]
    assert entries, last
    for entry in entries:
        assert len(entry["name"]) == MAX_NAME_CHARS + 30 + len("-进行中"), entry["name"][-8:]
    assert last["names"][0]["name"] == name + "-进行中"


def test_a_field_key_is_cut_only_at_the_transport_limit_and_the_warning_does_not_quote_it(
    tmp_path: Path,
) -> None:
    ctx, events = make_context(tmp_path)
    key = "键" * (MAX_NAME_CHARS + TRANSPORT_MARGIN_CHARS + 50)
    secret_key = "k" * (MAX_NAME_CHARS - 10) + SECRET

    # 字段的键是任意字符串：mypy 担心某个键恰好叫 parent，这里的键不是
    ctx.action.start("动作", **{key: "值", secret_key: "值"}).end()  # type: ignore[arg-type]

    [start] = only(events(), "action_start")
    assert "键" * (MAX_NAME_CHARS + TRANSPORT_MARGIN_CHARS) in start["fields"]
    assert secret_key in start["fields"]  # 比上限长但没有到传输上限：整个发出去
    warnings = [e["message"] for e in only(events(), "log") if e["level"] == "warn"]
    assert len(warnings) == 1 and "字段名" in warnings[0], warnings  # 同一种原因只警告一次
    assert not any(piece in warnings[0] for piece in fragments(SECRET)), warnings[0]
    assert str(len(key)) in warnings[0] or str(len(secret_key)) in warnings[0], warnings[0]


def test_local_execution_records_the_texts_cut_at_the_limits_like_the_control_plane() -> None:
    result = run_node(long_texts)

    assert result.status == "success", result.error
    [action] = result.actions
    assert action.name == "名" * MAX_NAME_CHARS
    assert action.fields == {"键" * MAX_NAME_CHARS: "值" * MAX_VALUE_CHARS}
    assert action.reason == "因" * (MAX_REASON_CHARS - 1) + "…"
    summary = result.action_summary
    assert summary is not None
    for entry in [*summary.running, *summary.recent, *summary.recent_failed]:
        assert len(entry.name) <= MAX_NAME_CHARS
        assert all(len(k) <= MAX_NAME_CHARS for k in entry.fields)
        assert all(len(v) <= MAX_VALUE_CHARS for v in entry.fields.values())
        assert entry.reason is None or len(entry.reason) <= MAX_REASON_CHARS


def test_a_warning_about_a_short_name_still_quotes_it(tmp_path: Path) -> None:
    ctx, events = make_context(tmp_path)

    handle = ctx.action.start("下单")
    handle.end()
    handle.end()

    [warning] = [e["message"] for e in only(events(), "log") if e["level"] == "warn"]
    assert "'下单'" in warning


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
        "failed": 0,
        "names_complete": True,
        "unlisted": None,
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
        "running_complete": True,
        "lists_trimmed": False,
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
