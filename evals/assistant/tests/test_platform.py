"""平台臂宿主机这一侧：三类结局的归类、`driver.json`、内存的取样、复制哪些文件、读驱动输出的时限、
`report` 里平台臂的输出。"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any

import pytest
from aeval.classify import INFRA, PLATFORM_FAULT
from aeval.platform import (
    ENVIRONMENT,
    PI_PROCESS_NAME,
    PLATFORM,
    SESSION_FILES,
    PeakSampler,
    classify_platform,
    copy_session_files,
    driver_summary,
    exit_reason,
    parse_hwm,
    platform_record,
    read_driver,
)
from aeval.session import judge
from aeval.tasks import GOAL, Check

END = {"type": "turn_end", "seq": 9}
OK: dict[str, Any] = {
    "precheck": "ok",
    "session": "s",
    "turn_end": {**END, "outcome": "completed"},
    "problems": [],
}


@pytest.mark.parametrize(
    ("platform", "want"),
    [
        ({}, (ENVIRONMENT, "会话驱动没有给出结果")),
        ({"precheck": "助手此刻不能用：工作台不在线"}, (ENVIRONMENT, "开始前的检查没过")),
        ({**OK, "problems": ["会话驱动被结束了（SIGTERM、SIGINT）"]}, (ENVIRONMENT, "被结束了")),
        ({**OK, "session": None, "problems": ["POST … 返回 503"]}, (PLATFORM, "没有建成会话")),
        ({**OK, "deadline_passed": True}, (PLATFORM, "评测停下了它")),
        ({**OK, "turn_end": None, "problems": ["停止之后没有等到结局"]}, (PLATFORM, "没有等到")),
        ({**OK, "turn_end": {**END, "outcome": "failed", "reason": "x"}}, (PLATFORM, "failed")),
        ({**OK, "turn_end": {**END, "outcome": "interrupted"}}, (PLATFORM, "interrupted")),
        ({**OK, "problems": ["结束会话：… 返回 500"]}, (PLATFORM, "结束会话")),
    ],
)
def test_classify_platform_puts_each_case_in_its_class(
    platform: dict[str, Any], want: tuple[str, str]
) -> None:
    got = classify_platform(platform)
    assert got is not None and got[0] == want[0] and want[1] in got[1]


@pytest.mark.parametrize("outcome", ["completed", "limit", "stopped", "model_unavailable"])
def test_outcomes_the_platform_gives_itself_are_not_faults(outcome: str) -> None:
    assert classify_platform({**OK, "turn_end": {**END, "outcome": outcome}}) is None


@pytest.mark.parametrize(
    ("turn_end", "deadline_passed", "want"),
    [
        ({"outcome": "completed"}, False, "finished"),
        ({"outcome": "limit", "limit_kind": "model_calls"}, False, "turn_limit"),
        ({"outcome": "limit", "limit_kind": "duration"}, False, "time_limit"),
        # 评测这一侧停下的不是「超时」（classify 不把它算超时），是平台故障。
        ({"outcome": "stopped"}, True, "evaluator_stopped"),
        (None, True, "evaluator_stopped"),
        ({"outcome": "stopped"}, False, "stopped"),
        ({"outcome": "failed"}, False, "failed"),
        (None, False, "no_turn_end"),
    ],
)
def test_exit_reason(turn_end: dict[str, Any] | None, deadline_passed: bool, want: str) -> None:
    assert exit_reason(turn_end, deadline_passed) == want


GOAL_OK = [Check("做对了", True, "", GOAL)]
CLASSIFIED: dict[str, Any] = {"primary": "其他", "invalid": False, "signals": {}}


def test_judge_environment_faults_void_the_session() -> None:
    invalid, failure, checks = judge(CLASSIFIED, GOAL_OK, (ENVIRONMENT, "开始前的检查没过"))
    assert invalid is True and failure is not None and failure["primary"] == INFRA
    assert checks == GOAL_OK


def test_judge_platform_faults_are_valid_failures_even_when_the_task_was_done() -> None:
    invalid, failure, checks = judge(CLASSIFIED, GOAL_OK, (PLATFORM, "平台以 failed 结束"))
    assert invalid is False
    assert failure is not None and failure["primary"] == PLATFORM_FAULT
    assert checks[-1].name == "平台这一侧没有出问题" and checks[-1].passed is False
    assert "平台以 failed 结束" in checks[-1].detail


def test_judge_an_endpoint_failure_wins_over_a_platform_fault() -> None:
    endpoint = {**CLASSIFIED, "primary": INFRA, "invalid": True}
    invalid, failure, checks = judge(endpoint, GOAL_OK, (PLATFORM, "平台以 failed 结束"))
    assert invalid is True and failure is not None and failure["primary"] == INFRA
    assert checks == GOAL_OK


def test_judge_without_faults_is_the_usual_grading() -> None:
    assert judge(CLASSIFIED, GOAL_OK, None) == (False, None, GOAL_OK)
    failed = [Check("做对了", False, "", GOAL)]
    assert judge(CLASSIFIED, failed, None) == (False, CLASSIFIED, failed)


RAW: list[dict[str, Any]] = [
    {"type": "turn_start"},
    {"type": "message_end", "message": {"role": "user"}},
    {
        "type": "message_end",
        "message": {
            "role": "assistant",
            "stopReason": "toolUse",
            "usage": {"input": 10, "output": 5, "cacheRead": 100, "cacheWrite": 1},
        },
    },
    {"type": "tool_execution_end", "isError": True},
    {"type": "tool_execution_end"},
    {"type": "turn_start"},
    {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "usage": {}}},
]
MEMORY = {"peak_mib": 300.0, "processes": 1}


def test_driver_summary_uses_the_evaluator_time_and_keeps_the_platform_time_apart() -> None:
    turn_end = {
        "outcome": "completed",
        "model_calls": 7,
        "duration_ms": 12_345,
        "usage": {"input": 1, "output": 2, "cache_read": 3, "cache_write": 4},
    }
    summary = driver_summary(turn_end, RAW, MEMORY, deadline_passed=False, seconds=99.04)
    assert summary["exit_reason"] == "finished"
    assert summary["wall_seconds"] == 99.0
    assert summary["platform_duration_seconds"] == 12.3
    assert summary["turns"] == 7
    assert summary["tokens"] == {"input": 1, "output": 2, "cache_read": 3, "cache_write": 4}
    assert (summary["pi_peak_rss_mib"], summary["pi_processes"]) == (300.0, 1)
    assert (summary["tool_calls"], summary["tool_errors"]) == (2, 1)
    assert summary["stop_reasons"] == {"toolUse": 1, "stop": 1}
    assert summary["limits"] == {"max_turns": 40, "max_seconds": 1200.0}


def test_without_turn_end_the_numbers_come_from_pi_events_and_memory_can_be_missing() -> None:
    missing = {"peak_mib": None, "processes": 0}
    summary = driver_summary(None, RAW, missing, deadline_passed=True, seconds=1.0)
    assert summary["exit_reason"] == "evaluator_stopped"
    assert summary["turns"] == 2
    assert summary["tokens"] == {"input": 10, "output": 5, "cache_read": 100, "cache_write": 1}
    assert summary["pi_peak_rss_mib"] is None
    assert summary["platform_duration_seconds"] is None


def test_platform_record_of_a_good_session_has_no_problems() -> None:
    summary = driver_summary(OK["turn_end"], [], MEMORY, deadline_passed=False, seconds=1)
    assert platform_record(OK, summary)["problems"] == []
    assert platform_record({}, summary)["problems"] == ["会话驱动没有给出结果"]


def test_only_the_whitelisted_session_files_are_copied(tmp_path: Path) -> None:
    copied: list[tuple[str, str]] = []
    copy_session_files(lambda src, dest: copied.append((src, dest)), "s1", tmp_path)
    assert [src for src, _ in copied] == [f"/data/sessions/s1/{name}" for name in SESSION_FILES]
    # turn.json 是这一轮的配置，带着环境变量（含保密的）：结果目录里不能有它，也不整个目录复制。
    assert "turn.json" not in SESSION_FILES
    assert "/data/sessions/s1" not in [src for src, _ in copied]


def test_read_driver_stops_the_driver_when_the_total_time_is_up() -> None:
    stopped: list[float] = []

    def lines() -> Any:
        yield "starting\n"
        give_up = time.monotonic() + 3
        while not stopped and time.monotonic() < give_up:
            time.sleep(0.02)
        yield json.dumps({"event": "done", "session": "s1"}) + "\n"

    started = time.monotonic()
    found, log = read_driver(lines(), 0.3, lambda: stopped.append(time.monotonic()))
    assert stopped and stopped[0] - started < 1
    assert found["session"] == "s1" and log[0] == "starting\n"


def test_parse_hwm() -> None:
    assert parse_hwm("VmHWM:\t  123456 kB\n") == 123456
    assert parse_hwm("VmRSS:\t  5 kB") == 0
    assert parse_hwm("") == 0


def _bare_sampler() -> PeakSampler:
    sampler = PeakSampler.__new__(PeakSampler)
    sampler.peak_kib, sampler.pids = None, set()
    return sampler


def test_the_sampler_script_reads_only_processes_named_pi(tmp_path: Path) -> None:
    proc = tmp_path / "proc"
    rows = (("7", "node-MainThread", 999999), ("38", "pi", 187536), ("40", "pi", 200))
    for pid, name, kib in rows:
        (proc / pid).mkdir(parents=True)
        (proc / pid / "comm").write_text(f"{name}\n")
        (proc / pid / "status").write_text(f"Name:\t{name}\nVmHWM:\t  {kib} kB\n")
    stop = tmp_path / "stop"
    env = {"AEVAL_MATCH": PI_PROCESS_NAME, "AEVAL_STOP": str(stop), "AEVAL_PROC": str(proc)}
    run = subprocess.Popen(
        ["sh", "-c", PeakSampler.SCRIPT], env=env, stdout=subprocess.PIPE, text=True
    )
    time.sleep(1.5)
    stop.touch()
    output, _ = run.communicate(timeout=5)
    sampler = _bare_sampler()
    for line in output.splitlines():
        sampler.add(line)
    assert sampler.pids == {"38", "40"} and sampler.peak_kib == 187536


class _FakeSampling:
    """取样脚本的替身：输出给定的几行。"""

    def __init__(self, lines: list[str]) -> None:
        self.stdout = iter(lines)

    def wait(self, timeout: float | None = None) -> int:
        return 0

    def kill(self) -> None:
        pass


@pytest.mark.parametrize(
    ("lines", "want"),
    [
        ([], {"peak_mib": None, "processes": 0}),
        (["38 \n"], {"peak_mib": None, "processes": 0}),
        (["38 VmHWM:\t 2048 kB\n", "40 VmHWM:\t 1024 kB\n"], {"peak_mib": 2.0, "processes": 2}),
    ],
)
def test_the_sampler_reports_missing_memory_as_none_not_zero(
    lines: list[str], want: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    from aeval import docker

    monkeypatch.setattr(docker, "docker", lambda *a, **k: None)
    sampler = PeakSampler("c", start=lambda argv: _FakeSampling(lines))  # type: ignore[arg-type,return-value]
    assert sampler.stop() == want


def _session(arm: str, task: str, passed: bool, n: int, **extra: Any) -> dict[str, Any]:
    limits = {"max_turns": 40, "max_seconds": 1200.0}
    driver = {"turns": 3, "wall_seconds": 2.0, "limits": limits, **extra.pop("driver", {})}
    return {
        "session": f"{task}-{arm}-{n}",
        "model": "m",
        "arm": arm,
        "task": task,
        "category": "写",
        "grade": {"passed": passed, "score": 1.0 if passed else 0.0},
        "driver": driver,
        "failure": None,
        **extra,
    }


def test_report_shows_the_platform_decision_faults_limits_and_missing_memory(
    tmp_path: Path,
) -> None:
    from aeval.report import render

    fault = {"kind": "platform", "reason": "平台以 failed 结束了这一轮：连不上工作台"}
    short = {"limits": {"max_turns": 20, "max_seconds": 600}}
    records = [
        _session("a", "write", True, 1, driver=short),
        _session("a", "write", True, 2, driver=short),
        _session("p", "write", True, 1, driver={"pi_peak_rss_mib": None}),
        _session("p", "write", False, 2, platform_fault=fault, failure={"primary": PLATFORM_FAULT}),
    ]
    for record in records:
        (tmp_path / record["session"]).mkdir()
        (tmp_path / record["session"] / "session.json").write_text(json.dumps(record))
    text = render(tmp_path)
    assert "臂 A 对平台臂" in text
    # 两臂上限不一样：开头按臂写出各自的上限，判定那一行本身带着「只作参考」。
    assert "A 本地 20 轮、600 秒" in text and "平台 40 轮、1200.0 秒" in text
    verdict = next(line for line in text.splitlines() if "按事先定下的标准" in line)
    assert "只作参考" in verdict
    # 平台故障逐次列出，判定里写明其中几次是平台故障。
    assert "平台故障（算作做题失败" in text and "连不上工作台" in text
    assert "1 次是平台故障" in text
    # 一个 pi 进程都没认出来的不当成 0。
    row = next(line for line in text.splitlines() if "| 平台 |" in line)
    assert "| 0.0 |" not in row
