"""`sfly_std.processes`：直接调用起停后台进程、找进程的辅助函数。"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path

import psutil
import pytest
from direct_context import DirectRun

from sfly_std.processes import (
    ProcessFinder,
    StartFailed,
    background_exit_code,
    find_processes,
    start_background_process,
    stop_background_process,
)
from sfly_std.waiting import poll_until


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


def alive(pid: int) -> bool:
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def test_a_background_process_outlives_the_call_and_stop_ends_its_whole_process_group(
    tmp_path: Path, reap: Callable[[int], int]
) -> None:
    run = DirectRun(tmp_path)

    started = start_background_process(run.ctx, "echo 已启动; sleep 60 & exec sleep 60")
    reap(started.pid)

    assert alive(started.pid)
    poll_until(
        lambda: "已启动" in Path(started.log_file).read_text() or None,
        what="日志里有输出",
        wait=10,
        poll=0.05,
    )
    group = psutil.Process(started.pid).children()
    assert group, "命令还有一个后台子进程"

    stopped = stop_background_process(run.ctx, started.pid, grace=5)

    assert stopped.was_running is True
    assert stopped.exit_code == 143
    assert not alive(started.pid)
    assert not any(alive(child.pid) for child in group)


def test_the_exit_code_of_a_process_that_ended_on_its_own_is_recorded(
    tmp_path: Path, reap: Callable[[int], int]
) -> None:
    run = DirectRun(tmp_path)
    started = start_background_process(run.ctx, "exit 7")
    reap(started.pid)

    assert background_exit_code(run.ctx, started.pid, wait=10) == 7
    stopped = stop_background_process(run.ctx, started.pid)

    assert (stopped.was_running, stopped.exit_code) == (False, 7)


def test_stopping_nothing_succeeds_so_it_can_run_in_a_finally_block(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)

    assert stop_background_process(run.ctx, None).was_running is False
    with pytest.raises(ValueError, match="pid 必须是正整数"):
        stop_background_process(run.ctx, 0)


def test_a_process_that_ignores_sigterm_is_killed_after_the_grace_period(
    tmp_path: Path, reap: Callable[[int], int]
) -> None:
    run = DirectRun(tmp_path)
    started = start_background_process(
        run.ctx, "trap '' TERM; echo 就绪; while true; do sleep 0.1; done"
    )
    reap(started.pid)
    poll_until(
        lambda: "就绪" in Path(started.log_file).read_text() or None,
        what="日志里有输出",
        wait=10,
        poll=0.05,
    )

    stopped = stop_background_process(run.ctx, started.pid, grace=0.5)

    assert (stopped.was_running, stopped.exit_code) == (True, 137)
    # 被 SIGKILL 的进程在内核里清理完之前短暂还能查到（macOS 上更明显）。
    poll_until(lambda: True if not alive(started.pid) else None, what="进程消失", wait=5, poll=0.05)


def test_start_fails_for_a_missing_interpreter_or_directory(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)

    with pytest.raises(StartFailed):
        start_background_process(run.ctx, "true", shell="/no/such/shell")
    with pytest.raises(NotADirectoryError):
        start_background_process(run.ctx, "true", cwd=str(tmp_path / "missing"))


def test_the_log_file_is_relative_to_cwd_when_given(
    tmp_path: Path, reap: Callable[[int], int]
) -> None:
    run = DirectRun(tmp_path)
    work = tmp_path / "work"
    work.mkdir()

    started = start_background_process(
        run.ctx, "echo 写进指定的日志", cwd=str(work), log_file="a/b.log"
    )
    reap(started.pid)

    assert started.log_file == str(work / "a" / "b.log")
    poll_until(
        lambda: "写进指定的日志" in Path(started.log_file).read_text() or None,
        what="日志里有输出",
        wait=10,
        poll=0.05,
    )


@pytest.fixture
def tagged() -> Iterator[Callable[[], tuple[subprocess.Popen[bytes], str]]]:
    """启动命令行里带一个独特标记的睡眠进程，返回进程和标记（用 `match` 找它）。"""
    procs: list[subprocess.Popen[bytes]] = []

    def start() -> tuple[subprocess.Popen[bytes], str]:
        tag = f"tag-{uuid.uuid4().hex}"
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", tag])
        procs.append(proc)
        return proc, tag

    yield start
    for proc in procs:
        proc.kill()
        proc.wait()


def test_find_processes_by_pid_and_by_command_line(
    tagged: Callable[[], tuple[subprocess.Popen[bytes], str]],
) -> None:
    proc, tag = tagged()
    time.sleep(0.1)

    assert [p.pid for p in find_processes(pid=proc.pid)] == [proc.pid]
    assert [p.pid for p in find_processes(match=tag)] == [proc.pid]
    assert find_processes(match=tag + "-nope") == []
    with pytest.raises(ValueError):
        find_processes()


def test_the_finder_looks_again_every_time_so_a_restarted_process_is_found_by_name(
    tagged: Callable[[], tuple[subprocess.Popen[bytes], str]],
) -> None:
    first, tag = tagged()
    finder = ProcessFinder(match=tag)
    assert [p.pid for ps in finder.roots().values() for p in ps] == [first.pid]

    first.kill()
    first.wait()
    assert [p for ps in finder.roots().values() for p in ps] == []

    second = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", tag])
    try:
        found = [p.pid for ps in finder.roots().values() for p in ps]
        assert found == [second.pid]
    finally:
        second.kill()
        second.wait()
