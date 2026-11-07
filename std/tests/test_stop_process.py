"""`stop_process`：停止 `start_process` 启动的后台进程（`sfly.testing.run_node`，真实的进程）。

`start_process` 与 `stop_process` 用同一个 `work_dir`，相当于同一次运行里的两个节点
（后台进程目录相同）。
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import psutil
import pytest

from sfly.testing import Execution, run_node
from sfly_std.start_process import start_process
from sfly_std.stop_process import stop_process


def alive(pid: int) -> bool:
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def kill(pid: int) -> None:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def wait_for(what: str, check: Callable[[], bool], timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < deadline, f"等待超时：{what}"
        time.sleep(0.05)


@pytest.fixture
def start(tmp_path: Path) -> Iterator[Callable[[str], int]]:
    """用 start_process 启动后台进程（工作目录 tmp_path），返回 pid；测试结束时杀掉留下的进程组。"""
    groups: list[int] = []

    def run(command: str) -> int:
        result = run_node(
            start_process, {"command": command, "cwd": str(tmp_path)}, work_dir=tmp_path
        )
        assert result.status == "success", result.error
        assert result.outputs is not None
        pid: int = result.outputs["pid"]
        try:
            groups.append(os.getpgid(pid))
        except ProcessLookupError:
            pass  # 已经退出
        return pid

    yield run
    for pgid in groups:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def stop(tmp_path: Path, pid: int | None, **inputs: object) -> Execution:
    return run_node(stop_process, {"pid": pid, **inputs}, work_dir=tmp_path)


def test_terminates_the_process_gracefully(tmp_path: Path, start: Callable[[str], int]) -> None:
    pid = start("trap 'echo 收到 TERM; exit 5' TERM; while :; do sleep 0.1; done")
    log = tmp_path / "procs" / "start_process.log"

    result = stop(tmp_path, pid)

    assert result.status == "success", result.error
    assert result.outputs == {"was_running": True, "exit_code": 5}
    assert not alive(pid)
    assert "收到 TERM" in log.read_text(encoding="utf-8")


def test_kills_a_process_that_ignores_sigterm_once_the_grace_period_ends(
    tmp_path: Path, start: Callable[[str], int]
) -> None:
    pid = start("trap '' TERM; while :; do sleep 0.1; done")

    started = time.monotonic()
    result = stop(tmp_path, pid, grace=1)

    assert result.status == "success", result.error
    assert result.outputs == {"was_running": True, "exit_code": 137}
    assert time.monotonic() - started >= 1
    assert not alive(pid)
    assert any("SIGKILL" in line.message for line in result.logs)


def test_the_whole_process_group_is_terminated(tmp_path: Path, start: Callable[[str], int]) -> None:
    pid = start("sleep 30 & sleep 30 & wait")
    wait_for("两个子进程", lambda: len(psutil.Process(pid).children()) == 2)
    children = [child.pid for child in psutil.Process(pid).children()]

    result = stop(tmp_path, pid)

    assert result.status == "success", result.error
    assert result.outputs is not None and result.outputs["was_running"] is True
    # 信号是异步生效的：节点等到组长退出就返回，同组的子进程可能还要片刻才退出。
    wait_for("整组进程退出", lambda: not any(alive(p) for p in [pid, *children]))


def test_a_process_that_already_exited_succeeds_with_its_exit_code(
    tmp_path: Path, start: Callable[[str], int]
) -> None:
    pid = start("exit 3")
    wait_for("进程退出", lambda: not alive(pid))

    result = stop(tmp_path, pid)

    assert result.status == "success", result.error
    assert result.outputs == {"was_running": False, "exit_code": 3}


def test_background_processes_left_by_an_exited_process_are_terminated(
    tmp_path: Path, start: Callable[[str], int], request: pytest.FixtureRequest
) -> None:
    pid = start("sleep 30 & echo $! > child.pid")
    child_file = tmp_path / "child.pid"
    wait_for("子进程 pid", lambda: child_file.exists() and child_file.read_text().strip() != "")
    child = int(child_file.read_text())
    request.addfinalizer(lambda: kill(child))
    wait_for("进程退出", lambda: not alive(pid))
    assert alive(child)

    result = stop(tmp_path, pid)

    assert result.status == "success", result.error
    assert result.outputs == {"was_running": False, "exit_code": 0}
    assert not alive(child)


def test_an_unknown_or_missing_pid_succeeds_without_an_exit_code(tmp_path: Path) -> None:
    gone = subprocess.Popen(["true"])
    gone.wait()

    for pid in [gone.pid, None]:
        result = stop(tmp_path, pid)

        assert result.status == "success", result.error
        assert result.outputs == {"was_running": False, "exit_code": None}
