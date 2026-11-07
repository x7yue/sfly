"""`start_process`：在真实的执行器进程里启动后台进程（`sfly.testing.run_node`）。"""

from __future__ import annotations

import os
import signal
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import psutil
import pytest

from sfly.testing import run_node
from sfly_std.start_process import start_process


def alive(pid: int) -> bool:
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def wait_for(what: str, check: Callable[[], bool], timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < deadline, f"等待超时：{what}"
        time.sleep(0.05)


@pytest.fixture
def reap() -> Iterator[Callable[[int], int]]:
    """登记测试启动的后台进程，测试结束时杀掉它所在的进程组。"""
    pids: list[int] = []

    def register(pid: int) -> int:
        pids.append(pid)
        return pid

    yield register
    for pid in pids:
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except ProcessLookupError:
            pass


def test_process_keeps_running_after_the_node_ends_and_logs_to_the_procs_dir(
    tmp_path: Path, reap: Callable[[int], int]
) -> None:
    command = "echo 已启动; echo 出错了 >&2; exec sleep 30"

    result = run_node(start_process, {"command": command}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert result.outputs is not None
    pid = reap(result.outputs["pid"])
    log = tmp_path / "procs" / "start_process.log"
    assert result.outputs == {"pid": pid, "log_file": str(log)}
    assert alive(pid)
    wait_for("日志", lambda: log.exists() and "出错了" in log.read_text(encoding="utf-8"))
    assert log.read_text(encoding="utf-8") == "已启动\n出错了\n"


def test_log_file_relative_to_cwd_is_created_and_appended_to(
    tmp_path: Path, reap: Callable[[int], int]
) -> None:
    app = tmp_path / "app"
    app.mkdir()
    (app / "logs").mkdir()
    (app / "logs" / "server.log").write_text("上一次\n", encoding="utf-8")
    inputs = {
        "command": 'echo "$GREETING from $(pwd)"',
        "cwd": str(app),
        "env": {"GREETING": "你好"},
        "log_file": "logs/server.log",
    }

    result = run_node(start_process, inputs, work_dir=tmp_path / "work")

    assert result.status == "success", result.error
    assert result.outputs is not None
    reap(result.outputs["pid"])
    log = app / "logs" / "server.log"
    assert result.outputs["log_file"] == str(log)
    expected = f"上一次\n你好 from {app}\n"
    wait_for("日志", lambda: log.read_text(encoding="utf-8") == expected)


def test_process_runs_in_its_own_session_outside_the_task_process_tree(
    tmp_path: Path, reap: Callable[[int], int]
) -> None:
    result = run_node(start_process, {"command": "exec sleep 30"}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert result.outputs is not None
    pid = reap(result.outputs["pid"])
    # 会话和进程组都不是执行器的：平台终止任务的进程组时不会波及它。
    assert os.getsid(pid) == os.getpgid(pid) != os.getsid(0)
    assert os.getpgid(pid) != os.getpgid(0)


def test_fails_when_the_interpreter_does_not_exist(tmp_path: Path) -> None:
    result = run_node(
        start_process, {"command": "true", "shell": "/nonexistent/sh"}, work_dir=tmp_path
    )

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message.startswith("sfly_std.start_process.StartFailed: 无法启动后台进程")
    assert "/nonexistent/sh" in result.error.message
