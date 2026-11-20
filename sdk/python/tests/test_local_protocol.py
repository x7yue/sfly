"""本地协议（docs/ARCHITECTURE.md §5.4）的两个读取端之一：本地调试（`sfly.local`）。

另一个读取端是 Agent（agent/src/local_protocol_tests.rs）。两端各有一份读取实现，
跑同一份用例表 testdata/local-protocol-cases.json：事件管道的一行读成什么、退出码和 output.json
怎么判成结果、两边各抄一份的常量，以及两端认识的事件类型集合。用例让假执行器
（testdata/local-protocol-executor.sh）做执行器那一端的事，`sfly.local.execute` 读它留下的东西。
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from sfly import Cancelled, Metric, local
from sfly.context import Context, TaskInfo
from sfly.local import ActionRecord, Execution

TESTDATA = Path(__file__).resolve().parents[3] / "testdata"
EXECUTOR = TESTDATA / "local-protocol-executor.sh"


def expand(value: Any) -> Any:
    """用例里的字符串可以写成 {"$repeat": 单元, "times": 次数, ...}（见用例表的说明），先展开。"""
    if isinstance(value, list):
        return [expand(v) for v in value]
    if isinstance(value, dict):
        if "$repeat" in value:
            return (
                value.get("prefix", "")
                + value["$repeat"] * value["times"]
                + value.get("suffix", "")
            )
        return {k: expand(v) for k, v in value.items()}
    return value


FILE: dict[str, Any] = expand(
    json.loads((TESTDATA / "local-protocol-cases.json").read_text("utf-8"))
)
EVENT_CASES: list[dict[str, Any]] = FILE["event_cases"]
RESULT_CASES: list[dict[str, Any]] = FILE["result_cases"]
KNOWN_EVENT_CASES: list[dict[str, Any]] = FILE["known_differences"]["event_cases"]
KNOWN_RESULT_CASES: list[dict[str, Any]] = FILE["known_differences"]["result_cases"]
SECTIONS = ("logs", "progress", "metrics", "notifications", "actions", "action_summary")
DEFAULT_OUTPUT = '{"status":"success","outputs":{}}'
SUCCESS: dict[str, Any] = {"status": "success", "outputs": {}}
#: 执行器异常退出的上报文字：「<前缀><退出状态><分隔>标准错误尾部」，退出状态两端的写法不同。
ABNORMAL_EXIT = ("执行器异常退出（", "），没有写出结果\n\n")


def ids(cases: list[dict[str, Any]]) -> list[str]:
    return [case["name"] for case in cases]


@pytest.fixture(autouse=True)
def only_the_events_that_were_written(monkeypatch: pytest.MonkeyPatch) -> None:
    """执行器退出时还没结束的动作，本地调试（和控制面）记为 unfinished：那是读取端在事件之外加的，
    Agent 不做，由 test_actions.py 覆盖；这里只看写进管道的事件被读成了什么。"""
    monkeypatch.setattr(local._Pump, "_end_unfinished_actions", lambda self: None)


# ---- 跑一个用例 ----


class Observed:
    """本地调试读到的东西，已经整理成用例表里 expect 的形状。"""

    def __init__(self, execution: Execution, actions: list[ActionRecord]) -> None:
        self.execution = execution
        self.actions = actions

    def sections(self) -> dict[str, Any]:
        e = self.execution
        summary = e.action_summary
        return {
            "logs": [
                {"source": x.source, "level": x.level, "message": x.message, "ts": x.ts}
                for x in e.logs
            ],
            "progress": [
                {
                    "type": "progress",
                    "current": x.current,
                    "total": x.total,
                    "message": x.message,
                    "ts": x.ts,
                }
                for x in e.progress
            ],
            "metrics": [
                {
                    "type": "metric",
                    "name": x.name,
                    "kind": x.kind,
                    "value": x.value,
                    "labels": [[k, v] for k, v in sorted(x.labels.items())],
                    "ts_s": x.ts // 1000,
                }
                for x in e.metrics
            ],
            "notifications": [
                {"type": "notify", "bot": x.bot, "ts": x.ts} for x in e.notifications
            ],
            "actions": [action_item(x) for x in self.actions],
            "action_summary": (
                None
                if summary is None
                else {
                    "type": "action_summary",
                    "total": summary.total,
                    "marks": summary.marks,
                    "reported": summary.reported,
                    "ts": summary.ts,
                }
            ),
        }

    def result(self) -> dict[str, Any]:
        e = self.execution
        if e.status == "success":
            return {"status": "success", "outputs": e.outputs}
        assert e.error is not None, e
        # Agent 把 traceback 接在 message 后面一起上报；本地调试分开存，这里按同样的规则接起来。
        report = e.error.message
        if e.error.traceback:
            report += "\n\n" + e.error.traceback.rstrip()
        prefix, separator = ABNORMAL_EXIT
        if report.startswith(prefix) and separator in report:
            tail = report.partition(separator)[2]
            return {
                "status": "failed",
                "kind": e.error.kind,
                "abnormal_exit": {"stderr_tail": tail},
            }
        return {"status": "failed", "kind": e.error.kind, "report": report}


def action_item(record: ActionRecord) -> dict[str, Any]:
    """动作和标记每次变化时的记录，整理成 Agent 转发的明细事件的样子（读不出的键见 not_shown）。"""
    fields = [[k, v] for k, v in record.fields.items()]
    if record.kind == "mark":
        return {
            "type": "mark",
            "id": record.id,
            "parent": record.parent,
            "depth": record.depth,
            "name": record.name,
            "fields": fields,
            "ts": record.ts,
            "mono": record.mono,
        }
    if record.result is None:
        return {
            "type": "action_start",
            "id": record.id,
            "parent": record.parent,
            "depth": record.depth,
            "name": record.name,
            "fields": fields,
            "ts": record.ts,
            "mono": record.mono,
        }
    assert record.duration_ms is not None
    return {
        "type": "action_end",
        "id": record.id,
        "result": record.result,
        "reason": record.reason,
        "fields": fields,
        "ts": record.ts,
        "mono": record.mono + record.duration_ms,
    }


def run(case: dict[str, Any], tmp_path: Path) -> tuple[Observed, tuple[int, int]]:
    """让假执行器按 `case` 做一遍，返回读到的东西和这次执行前后的时间（Unix 毫秒）。"""
    root = tmp_path / "executor"
    (root / "bin").mkdir(parents=True)
    (root / "case").mkdir()
    (root / "bin" / "python").symlink_to(EXECUTOR)
    files = {
        "events.jsonl": "".join(line + "\n" for line in case["events"])
        if "events" in case
        else None,
        "stdout": case.get("stdout"),
        "stderr": case.get("stderr"),
        "output.json": case.get("output", DEFAULT_OUTPUT),
        "exit-code": str(case["exit_code"]) if "exit_code" in case else None,
    }
    for name, content in files.items():
        if content is not None:
            (root / "case" / name).write_text(content, encoding="utf-8", newline="")
    actions: list[ActionRecord] = []
    before = int(time.time() * 1000)
    execution = local.execute(
        "case:run",
        {},
        tmp_path / "work",
        python=str(root / "bin" / "python"),
        on_action=actions.append,
    )
    after = int(time.time() * 1000)
    return Observed(execution, actions), (before, after)


# ---- 比较 ----


def without_not_shown(expected: Any, hidden: list[str]) -> Any:
    """去掉 expect 里本端读不出的键（`not_shown`，写法：类型.键）。"""
    if isinstance(expected, list):
        return [without_not_shown(item, hidden) for item in expected]
    if isinstance(expected, dict) and "type" in expected:
        return {k: v for k, v in expected.items() if f"{expected['type']}.{k}" not in hidden}
    if isinstance(expected, dict):
        return {k: without_not_shown(v, hidden) for k, v in expected.items()}
    return expected


def entry_problems(
    expected: dict[str, Any], actual: dict[str, Any], window: tuple[int, int]
) -> list[str]:
    """条目里写了的键才比较；ts 是 "now"（ts_s 同理，单位秒）时看是否落在这次执行的前后之间。"""
    problems = []
    for key, want in expected.items():
        got = actual.get(key, "<没有>")
        if want == "now":
            low, high = window if key == "ts" else (window[0] // 1000, window[1] // 1000)
            if not isinstance(got, int) or not low <= got <= high:
                problems.append(f"{key}: 应在 {low}..{high} 之间，实际是 {got!r}")
        elif got != want:
            problems.append(f"{key}: 应为 {want!r}，实际是 {got!r}")
    return problems


def section_problems(name: str, expected: Any, actual: Any, window: tuple[int, int]) -> list[str]:
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return [f"{name}: 应有 {len(expected)} 条，实际 {len(actual)} 条：{actual!r}"]
        return [
            f"{name}[{i}] {problem}"
            for i, (want, got) in enumerate(zip(expected, actual, strict=True))
            for problem in entry_problems(want, got, window)
        ]
    if isinstance(expected, dict) and isinstance(actual, dict):
        return [f"{name} {p}" for p in entry_problems(expected, actual, window)]
    return [] if expected == actual else [f"{name}: 应为 {expected!r}，实际是 {actual!r}"]


def assert_events(case: dict[str, Any], expect: dict[str, Any], tmp_path: Path) -> None:
    observed, window = run(case, tmp_path)
    hidden = FILE["not_shown"]["local"]
    expected = without_not_shown(expect, hidden)
    actual = observed.sections()
    problems = [
        problem
        for section in SECTIONS
        for problem in section_problems(
            section,
            expected.get(section, None if section == "action_summary" else []),
            actual[section],
            window,
        )
    ]
    problems += section_problems("result", SUCCESS, observed.result(), window)
    assert not problems, "\n".join(problems)


def assert_result(case: dict[str, Any], expect: dict[str, Any], tmp_path: Path) -> None:
    observed, _ = run(case, tmp_path)
    assert observed.result() == expect


# ---- 用例 ----


@pytest.mark.parametrize("case", EVENT_CASES, ids=ids(EVENT_CASES))
def test_event_pipe_and_output_streams_are_read_as_the_shared_cases_say(
    case: dict[str, Any], tmp_path: Path
) -> None:
    assert_events(case, case["expect"], tmp_path)


@pytest.mark.parametrize("case", RESULT_CASES, ids=ids(RESULT_CASES))
def test_exit_code_and_output_json_are_judged_as_the_shared_cases_say(
    case: dict[str, Any], tmp_path: Path
) -> None:
    assert_result(case, case["expect"], tmp_path)


@pytest.mark.parametrize("case", KNOWN_EVENT_CASES, ids=ids(KNOWN_EVENT_CASES))
def test_known_event_differences_stay_as_the_case_file_pins_them(
    case: dict[str, Any], tmp_path: Path
) -> None:
    assert_events(case, case["local"], tmp_path)


@pytest.mark.parametrize("case", KNOWN_RESULT_CASES, ids=ids(KNOWN_RESULT_CASES))
def test_known_result_differences_stay_as_the_case_file_pins_them(
    case: dict[str, Any], tmp_path: Path
) -> None:
    assert_result(case, case["local"], tmp_path)


def test_the_event_types_this_end_reads_are_the_ones_in_the_case_file() -> None:
    assert local.EVENT_TYPES == set(FILE["event_types"])


def test_every_event_type_has_a_case() -> None:
    covered = {
        item["type"]
        for case in EVENT_CASES
        for name, section in case["expect"].items()
        if name != "logs"
        for item in (section if isinstance(section, list) else [section])
    }
    assert covered == set(FILE["event_types"]) - {"log"}
    assert any(
        item["source"] == "sdk" and item.get("ts") != "now"
        for case in EVENT_CASES
        for item in case["expect"].get("logs", [])
    )


def test_constants_shared_with_the_agent_are_the_ones_in_the_case_file() -> None:
    constants = FILE["constants"]
    assert {
        "max_line_bytes": local._MAX_LINE_BYTES,
        "drain_timeout_ms": round(local._DRAIN_TIMEOUT * 1000),
        "stderr_tail_bytes": local._STDERR_TAIL_BYTES,
        "terminate_grace_ms": round(local.DEFAULT_GRACE * 1000),
    } == constants


# ---- 写入端：SDK 写出来的行就是用例里的行 ----

#: 用例名 → 产生那些行的 SDK 调用。没有列在这里的用例是手写的变体（别名、缺字段、写错了的内容），
#: SDK 不会写出来。
WRITERS: dict[str, Callable[[Context], None]] = {}
#: 不逐行对的事件类型：动作摘要里是随时间变化的读数，没有一行能固定下来逐字段对。
NOT_WRITTEN = {"action_summary"}
#: 每次写入都不同的键，比较前去掉。
VOLATILE = ("ts", "mono")


def writes(name: str) -> Callable[[Callable[[Context], None]], Callable[[Context], None]]:
    def register(call: Callable[[Context], None]) -> Callable[[Context], None]:
        WRITERS[name] = call
        return call

    return register


@writes("log：四个级别各记成对应级别的 SDK 日志，按写的先后")
def _log_levels(ctx: Context) -> None:
    ctx.log.debug("d")
    ctx.log.info("i")
    ctx.log.warn("w")
    ctx.log.error("e")


@writes("progress：当前值、总数和说明")
def _progress(ctx: Context) -> None:
    ctx.progress(1, 3, "第一步")


@writes("progress：总数是 null 表示未知")
def _progress_without_total(ctx: Context) -> None:
    ctx.progress(2.5)


@writes("metric：gauge")
def _metric_gauge(ctx: Context) -> None:
    ctx.metric("tps", 1.5)


@writes("metric：counter")
def _metric_counter(ctx: Context) -> None:
    ctx.metric("requests", 7)


@writes("metric：标签按键排序")
def _metric_labels(ctx: Context) -> None:
    ctx.metric("rss", 10, labels={"pid": 1234, "host": "a"})


@writes("notify：文本通知")
def _notify_text(ctx: Context) -> None:
    ctx.notify("ops", "指标越界", at_all=True)


@writes("notify：原始消息")
def _notify_message(ctx: Context) -> None:
    ctx.notify("ops", message={"msg_type": "text", "content": {"text": "hi"}})


@writes("mark：一个标记")
def _mark(ctx: Context) -> None:
    ctx.mark("收到第一笔成交")
    ctx.action.flush()


@writes("action_end：动作成功结束")
def _action_success(ctx: Context) -> None:
    with ctx.action("下单", 订单="1001"):
        pass
    ctx.action.flush()


@writes("action_end：失败带原因和 note 补充的字段")
def _action_failed(ctx: Context) -> None:
    with ctx.action("下单", 订单="1001") as action:
        action.note(回报="rejected")
        action.fail("ValueError: 拒单")
    ctx.action.flush()


@writes("action_end：因取消离开 with 是 unfinished")
def _action_unfinished(ctx: Context) -> None:
    try:
        with ctx.action("下单", 订单="1001"):
            raise Cancelled("任务被终止")
    except Cancelled:
        pass
    ctx.action.flush()


def without_volatile(event: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in event.items() if k not in VOLATILE}


@pytest.mark.parametrize("name", list(WRITERS), ids=list(WRITERS))
def test_the_lines_the_sdk_writes_are_the_lines_of_the_shared_cases(
    name: str, tmp_path: Path
) -> None:
    case = next(c for c in EVENT_CASES if c["name"] == name)
    path = tmp_path / "events.jsonl"
    ctx = Context(
        events_path=path,
        cancel_path=None,
        artifacts_dir=None,
        artifacts_url=None,
        metrics=[
            Metric("tps"),
            Metric("requests", kind="counter"),
            Metric("rss", labels=["pid", "host"]),
        ],
        task=TaskInfo(),
        procs_dir=tmp_path / "procs",
    )
    WRITERS[name](ctx)
    written = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert [without_volatile(e) for e in written if e["type"] != "action_summary"] == [
        without_volatile(json.loads(line)) for line in case["events"]
    ]


def test_every_written_line_has_a_case_and_every_event_type_but_the_summary_is_written() -> None:
    names = {case["name"] for case in EVENT_CASES}
    assert set(WRITERS) <= names
    written = {
        json.loads(line)["type"]
        for name in WRITERS
        for line in next(c for c in EVENT_CASES if c["name"] == name)["events"]
    }
    assert written == set(FILE["event_types"]) - NOT_WRITTEN
