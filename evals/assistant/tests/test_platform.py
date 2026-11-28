"""平台臂宿主机这一侧：三类结局的归类、`driver.json`、内存的取样、复制哪些文件、读驱动输出的时限、
`report` 里平台臂的输出。"""

from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import pytest
from aeval.classify import INFRA, PLATFORM_FAULT, UNCLASSIFIED
from aeval.platform import (
    DEADLINE_SLACK_SECONDS,
    ENVIRONMENT,
    PI_PROCESS_NAME,
    PLATFORM,
    PLATFORM_MAX_SECONDS,
    SESSION_FILES,
    PeakSampler,
    classify_platform,
    copy_session_files,
    driver_argv,
    driver_budget,
    driver_env,
    driver_pattern,
    driver_summary,
    exit_reason,
    parse_hwm,
    platform_record,
    read_driver,
    run_driver,
    summarize_platform,
)
from aeval.platform import UNCLASSIFIED as UNCLASSIFIED_KIND
from aeval.session import judge
from aeval.tasks import GOAL, Check

if TYPE_CHECKING:
    from aeval.env import Stack

END = {"type": "turn_end", "seq": 9}
OK: dict[str, Any] = {
    "precheck": "ok",
    "session": "s",
    "turn_end": {**END, "outcome": "completed"},
    "problems": [],
}


def told(*pairs: tuple[str, str]) -> dict[str, list[str]]:
    """驱动记下的问题：（种类，文字）。"""
    return {"problem_kinds": [k for k, _ in pairs], "problems": [t for _, t in pairs]}


SIGNAL = ("signal", "会话驱动被结束了（SIGTERM、SIGINT）")
DEADLINE = ("deadline", "在时限内没有等到 turn_end")


@pytest.mark.parametrize(
    ("platform", "want"),
    [
        ({}, (ENVIRONMENT, "会话驱动没有给出结果")),
        ({"precheck": "助手此刻不能用：工作台不在线"}, (ENVIRONMENT, "开始前的检查没过")),
        ({**OK, **told(SIGNAL)}, (ENVIRONMENT, "评测自己的问题：会话驱动被结束了")),
        # 管理员登录失败：开始前的检查里先判了环境故障。
        (
            {
                "precheck": "管理员登录失败：管理员登录返回 401：x",
                **told(("login", "管理员登录失败：管理员登录返回 401：x")),
            },
            (ENVIRONMENT, "开始前的检查没过：管理员登录失败"),
        ),
        # 驱动记下的登录失败（检查过了之后才出现的话）也认得出：环境故障。
        (
            {**OK, **told(("login", "管理员登录失败：x"))},
            (ENVIRONMENT, "管理员登录失败：管理员登录失败：x"),
        ),
        # 建会话被 503 拒绝、原因是环境没准备好（模型、助手服务的事件流）：环境故障，不是平台的错。
        (
            {
                **OK,
                "session": None,
                "turn_end": None,
                **told(("not_ready", "POST … 返回 503：model_unavailable")),
            },
            (ENVIRONMENT, "建会话时环境没有准备好：POST … 返回 503"),
        ),
        (
            {**OK, "turn_end": None, **told(("evaluator", "会话驱动出错：KeyError: 'x'"))},
            (ENVIRONMENT, "评测自己的问题：会话驱动出错"),
        ),
        (
            {**OK, **told(("evaluator", "写不进事件记录：磁盘满了"))},
            (ENVIRONMENT, "评测自己的问题：写不进事件记录"),
        ),
        (
            {**OK, "session": None, **told(("control_plane", "POST … 返回 503"))},
            (PLATFORM, "没有建成会话"),
        ),
        ({**OK, "deadline_passed": True, **told(DEADLINE)}, (PLATFORM, "评测停下了它")),
        # 「过了时限」先于「驱动被结束了」判：不被宿主机发的信号盖掉。
        (
            {**OK, "deadline_passed": True, **told(DEADLINE, SIGNAL)},
            (PLATFORM, "评测停下了它"),
        ),
        (
            {**OK, "turn_end": None, **told(("no_outcome_after_stop", "停止之后没有等到结局"))},
            (PLATFORM, "没有等到"),
        ),
        ({**OK, "turn_end": {**END, "outcome": "failed", "reason": "x"}}, (PLATFORM, "failed")),
        ({**OK, "turn_end": {**END, "outcome": "interrupted"}}, (PLATFORM, "interrupted")),
        ({**OK, "turn_end": {**END, "outcome": "stopped"}}, (PLATFORM, "评测没有让它停")),
        (
            {**OK, **told(("control_plane", "结束会话：… 返回 500"))},
            (PLATFORM, "结束会话"),
        ),
        ({**OK, "turn_end": {**END, "outcome": "paused"}}, (UNCLASSIFIED_KIND, "不是契约里的值")),
        ({**OK, **told(("disk", "别的问题"))}, (UNCLASSIFIED_KIND, "认不出的问题：别的问题")),
        # 有文字没有种类（旧的驱动）：认不出，不靠兜底归到平台。
        ({**OK, "problems": ["结束会话：… 返回 500"]}, (UNCLASSIFIED_KIND, "认不出的问题")),
    ],
)
def test_classify_platform_puts_each_case_in_its_class(
    platform: dict[str, Any], want: tuple[str, str]
) -> None:
    got = classify_platform(platform)
    assert got is not None and got[0] == want[0] and want[1] in got[1]


@pytest.mark.parametrize("outcome", ["completed", "limit", "model_unavailable"])
def test_outcomes_the_platform_gives_itself_are_not_faults(outcome: str) -> None:
    assert classify_platform({**OK, "turn_end": {**END, "outcome": outcome}}) is None


def test_a_stopped_outcome_the_evaluator_asked_for_is_not_a_fault_by_itself() -> None:
    stopped = {**OK, "stopped": True, "turn_end": {**END, "outcome": "stopped"}}
    assert classify_platform(stopped) is None


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


def test_judge_unclassified_sessions_are_void_and_say_so() -> None:
    invalid, failure, checks = judge(CLASSIFIED, GOAL_OK, (UNCLASSIFIED_KIND, "认不出的问题"))
    assert invalid is True and failure is not None and failure["primary"] == UNCLASSIFIED
    assert checks == GOAL_OK


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
    # turn.json 是这一轮的配置，带着环境变量（含 secret 环境变量）：
    # 结果目录里不能有它，也不整个目录复制。
    assert "turn.json" not in SESSION_FILES
    assert "/data/sessions/s1" not in [src for src, _ in copied]


def test_read_driver_stops_the_driver_when_the_total_time_is_up() -> None:
    stopped: list[float] = []

    def lines() -> Any:
        yield "starting\n"
        give_up = time.monotonic() + 3
        while not stopped and time.monotonic() < give_up:
            time.sleep(0.02)  # noqa: TID251 假的会话流：等被停下，最多 3 秒
        yield json.dumps({"event": "done", "session": "s1"}) + "\n"

    started = time.monotonic()
    found, log = read_driver(lines(), 0.3, lambda: stopped.append(time.monotonic()))
    assert stopped and stopped[0] - started < 1
    assert found["session"] == "s1" and log[0] == "starting\n"


def test_the_driver_pattern_finds_this_drivers_command_line_and_no_other() -> None:
    argv = driver_argv("mirror", "/r/run-7/prompt.md", "/r/run-7", 1260.0)
    pattern = re.compile(driver_pattern("/r/run-7"))

    # pkill -f 对着容器里驱动的命令行（`python3 <驱动> …`）匹配。
    def command(parts: list[str]) -> str:
        return " ".join(parts[parts.index("python3") :])

    assert pattern.search(command(argv))
    assert not pattern.search(command(driver_argv("mirror", "/r/run-8/p.md", "/r/run-8", 1)))
    # 发 pkill 的那个 shell 自己的命令行里有这个模式本身，不能匹配上。
    assert not pattern.search(f"sh -c pkill -TERM -f '{driver_pattern('/r/run-7')}'")


class _Driver:
    """会话驱动的替身：输出给定的几行，或者读的时候被打断。"""

    def __init__(self, lines: Any) -> None:
        self.stdout = lines
        self.waited = False

    def wait(self, timeout: float | None = None) -> int:
        self.waited = True
        return 0

    def kill(self) -> None:
        pass


def test_run_driver_ends_the_driver_in_the_container_when_the_host_is_interrupted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from aeval import platform

    def interrupted(*args: Any) -> Any:
        raise KeyboardInterrupt  # 宿主机这边 Ctrl-C，正在等驱动的输出

    monkeypatch.setattr(platform, "read_driver", interrupted)
    ended: list[bool] = []
    driver = _Driver(iter([]))
    start = lambda argv: driver  # noqa: E731
    with pytest.raises(KeyboardInterrupt):
        run_driver(["x"], 5, lambda: ended.append(True), start=start)  # type: ignore[arg-type]
    assert ended == [True] and driver.waited


def test_run_driver_returns_what_the_driver_said() -> None:
    done = json.dumps({"event": "done", "session": "s1"}) + "\n"
    ended: list[bool] = []
    found, log = run_driver(
        ["x"],
        5,
        lambda: ended.append(True),
        start=lambda argv: _Driver(iter([done])),  # type: ignore[arg-type,return-value]
    )
    assert found["session"] == "s1" and ended == []


class _AdminOnly:
    """`driver_env` 只读 `admin_password`。"""

    def __init__(self, admin_password: str | None) -> None:
        self.admin_password = admin_password


def test_the_admin_password_goes_to_the_driver_through_the_environment_not_the_arguments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from aeval.env import ADMIN_LOGIN, ADMIN_PASSWORD_ENV

    password = "pw-0123456789abcdef-should-not-appear-in-arguments"
    env = driver_env(cast("Stack", _AdminOnly(password)))
    assert env == {ADMIN_PASSWORD_ENV: password}
    argv = driver_argv("mirror", "/r/p.md", "/r/run", 1200.0)
    # `docker exec -e 名字`：参数里只有名字，没有值；登录名（不是秘密）是参数。
    assert argv[argv.index("-e") + 1] == ADMIN_PASSWORD_ENV
    assert password not in " ".join(argv)
    assert argv[argv.index("--login-name") + 1] == ADMIN_LOGIN
    # 起 docker exec 进程时把它放进这个进程的环境（`ps` 看得到的是参数，不是环境）。
    seen: dict[str, Any] = {}

    class Popen:
        def __init__(self, argv: list[str], **kwargs: Any) -> None:
            seen["argv"], seen["env"] = argv, kwargs.get("env")
            self.stdout = iter([json.dumps({"event": "done"}) + "\n"])

        def wait(self, timeout: float | None = None) -> int:
            return 0

    monkeypatch.setattr(subprocess, "Popen", Popen)
    run_driver(argv, 5, lambda: None, env=env)
    assert seen["env"][ADMIN_PASSWORD_ENV] == password
    assert password not in " ".join(seen["argv"])


def test_run_session_driver_hands_the_password_environment_to_the_driver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from aeval import platform as platform_module
    from aeval.env import ADMIN_PASSWORD_ENV
    from aeval.platform import run_session_driver

    password = "pw-for-the-run-session-driver-test"
    seen: dict[str, Any] = {}

    def fake_run_driver(argv: list[str], timeout: float, end: Any, **kwargs: Any) -> Any:
        seen["argv"], seen["timeout"], seen["env"] = argv, timeout, kwargs.get("env")
        return {}, []

    monkeypatch.setattr(platform_module, "run_driver", fake_run_driver)
    run_session_driver(cast("Stack", _AdminOnly(password)), "mirror", "/p.md", "/r", lambda: None)
    # 宿主机起驱动的那一步把密码经环境交给 `docker exec`（不在参数里）：去掉 `env=` 这条就红。
    assert seen["env"] == {ADMIN_PASSWORD_ENV: password}
    assert password not in " ".join(seen["argv"])
    assert seen["timeout"] > driver_budget()


def test_without_the_admin_password_the_host_stops_before_starting_the_driver() -> None:
    from aeval import docker as d

    with pytest.raises(d.DockerError, match="初始管理员的密码"):
        driver_env(cast("Stack", _AdminOnly(None)))


def test_the_driver_waits_past_the_platforms_own_limit() -> None:
    assert DEADLINE_SLACK_SECONDS > 0
    assert driver_budget() == PLATFORM_MAX_SECONDS + DEADLINE_SLACK_SECONDS
    argv = driver_argv("mirror", "p", "r", driver_budget())
    assert argv[argv.index("--max-seconds") + 1] == str(
        PLATFORM_MAX_SECONDS + DEADLINE_SLACK_SECONDS
    )


def test_the_time_is_the_drivers_from_asking_to_the_outcome_not_the_hosts() -> None:
    platform = {**OK, "seconds": 2.5}
    assert summarize_platform(platform, [], MEMORY, host_seconds=40.0)["wall_seconds"] == 2.5
    # 驱动没给出用时（没走到建会话、或者没有结果）时才用宿主机量的。
    no_time = {**OK, "seconds": None}
    assert summarize_platform(no_time, [], MEMORY, host_seconds=40.0)["wall_seconds"] == 40.0
    assert summarize_platform({}, [], MEMORY, host_seconds=41.0)["wall_seconds"] == 41.0


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
    time.sleep(1.5)  # noqa: TID251 让采样脚本跑上几轮再叫它停
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


def test_report_lists_unclassified_sessions_and_the_verdict_is_only_a_reference(
    tmp_path: Path,
) -> None:
    from aeval.report import render

    odd = {"kind": "unclassified", "reason": "结局不是契约里的值：'paused'"}
    records = [
        _session("a", "write", True, 1),
        _session("p", "write", True, 1),
        _session("p", "write", True, 2, invalid=True, platform_fault=odd),
    ]
    records[-1]["failure"] = {"primary": UNCLASSIFIED}
    for record in records:
        (tmp_path / record["session"]).mkdir()
        (tmp_path / record["session"] / "session.json").write_text(json.dumps(record))
    text = render(tmp_path)
    assert "未归类（认不出是平台还是评测环境的问题" in text and "'paused'" in text
    verdict = next(line for line in text.splitlines() if "按事先定下的标准" in line)
    assert "只作参考" in verdict and "1 次会话未归类" in verdict
