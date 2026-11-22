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

from sfly_std import processes
from sfly_std._finder import ProcessFinder
from sfly_std.logs import wait_for_log_line
from sfly_std.processes import (
    StartFailed,
    StopFailed,
    background_exit_status,
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
        lambda: "已启动" in Path(started.log_path).read_text() or None,
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

    exited = background_exit_status(run.ctx, started.pid, wait=10)
    assert (exited.supervised, exited.running, exited.exit_code) == (True, False, 7)
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
        lambda: "就绪" in Path(started.log_path).read_text() or None,
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

    started = start_background_process(run.ctx, "echo 写进指定的日志", cwd=work, log_path="a/b.log")
    reap(started.pid)

    assert started.log_path == work / "a" / "b.log"  # 返回的是 Path
    poll_until(
        lambda: "写进指定的日志" in Path(started.log_path).read_text() or None,
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


def test_a_second_process_in_the_same_node_gets_its_own_default_log_file(
    tmp_path: Path, reap: Callable[[int], int]
) -> None:
    # 起两个服务（数据库加被测服务）：日志不能混在一起，否则等第二个服务就绪时会匹配到第一个打的行。
    run = DirectRun(tmp_path, node_id="setup")
    first = start_background_process(run.ctx, "echo A-ready; sleep 60")
    second = start_background_process(run.ctx, "echo B-ready; sleep 60")
    third = start_background_process(run.ctx, "echo C-ready; sleep 60")
    for started in (first, second, third):
        reap(started.pid)

    assert [p.log_path.name for p in (first, second, third)] == [
        "setup.log",
        "setup-2.log",
        "setup-3.log",
    ]
    assert all(p.log_path.parent == run.ctx.procs_dir for p in (first, second, third))
    found = wait_for_log_line(run.ctx, second.log_path, "ready", read_from="start", wait=10)
    assert found.line == "B-ready"
    assert wait_for_log_line(run.ctx, first.log_path, "ready", read_from="start", wait=10).line == (
        "A-ready"
    )
    # 自己指定日志文件时直接用它（同一个文件接着写）。
    own = tmp_path / "own.log"
    again = start_background_process(run.ctx, "echo 又一个", log_path=own)
    reap(again.pid)
    assert again.log_path == own


#: 忽略 SIGTERM 的服务：停它只能靠 SIGKILL。
STUBBORN = "trap '' TERM; echo 就绪; while true; do sleep 0.1; done"


def start_stubborn(run: DirectRun, reap: Callable[[int], int]) -> int:
    started = start_background_process(run.ctx, STUBBORN)
    reap(started.pid)
    poll_until(
        lambda: "就绪" in started.log_path.read_text() or None,
        what="日志里有输出",
        wait=10,
        poll=0.05,
    )
    return started.pid


def test_the_default_grace_leaves_time_to_kill_before_the_platform_does(
    tmp_path: Path, reap: Callable[[int], int]
) -> None:
    # 平台终止任务时只给节点 10 秒：在 finally 里停进程，默认的宽限期要明显短于它。
    run = DirectRun(tmp_path)
    pid = start_stubborn(run, reap)
    started = time.monotonic()

    stopped = stop_background_process(run.ctx, pid)

    elapsed = time.monotonic() - started
    assert (stopped.was_running, stopped.exit_code) == (True, 137)
    assert 4 <= elapsed < 8, f"默认宽限期应该约 5 秒，实际 {elapsed:.1f} 秒"


def test_a_cancelled_task_shortens_the_grace_period_to_what_the_platform_leaves(
    tmp_path: Path, reap: Callable[[int], int]
) -> None:
    run = DirectRun(tmp_path)
    pid = start_stubborn(run, reap)
    run.cancel()  # 平台取消任务：写取消标记，同时发 SIGTERM；留给收尾的时间已经不多
    started = time.monotonic()

    stopped = stop_background_process(run.ctx, pid, grace=30)

    elapsed = time.monotonic() - started
    assert (stopped.was_running, stopped.exit_code) == (True, 137)
    assert 2.5 <= elapsed < 5, f"取消时宽限期最多 3 秒，实际 {elapsed:.1f} 秒"
    assert any("宽限期从 30 秒缩短为 3 秒" in m for m in run.logs("info"))


def test_a_grace_period_shorter_than_the_cap_is_kept_when_cancelled(
    tmp_path: Path, reap: Callable[[int], int]
) -> None:
    run = DirectRun(tmp_path)
    pid = start_stubborn(run, reap)
    run.cancel()
    started = time.monotonic()

    stop_background_process(run.ctx, pid, grace=0.5)

    assert time.monotonic() - started < 2.5


def test_find_processes_includes_children_by_default_like_the_finder_and_the_monitor() -> None:
    tag = f"tag-{uuid.uuid4().hex}"
    code = "import subprocess, time; subprocess.Popen(['sleep', '60']); time.sleep(60)"
    parent = subprocess.Popen([sys.executable, "-c", code, tag])
    try:
        children = {
            c.pid
            for c in poll_until(
                lambda: psutil.Process(parent.pid).children(recursive=True) or None,
                what="父进程启动了子进程",
                wait=10,
                poll=0.05,
            ).value
        }
        finder = ProcessFinder(match=tag)
        by_default = {p.pid for p in find_processes(match=tag)}
        only_matched = {p.pid for p in find_processes(match=tag, include_children=False)}
        by_finder = {p.pid for p in finder.processes(finder.roots()).values()}
    finally:
        for child in psutil.Process(parent.pid).children(recursive=True):
            child.kill()
        parent.kill()
        parent.wait()

    assert only_matched == {parent.pid}
    assert by_default == by_finder == {parent.pid} | children


def test_background_exit_status_tells_a_process_that_is_not_ours_from_one_still_running(
    tmp_path: Path, reap: Callable[[int], int]
) -> None:
    # 以前返回 `int | None`：None 混了「还在运行」和「不是后台进程启动的，查不到」。
    run = DirectRun(tmp_path)
    started = start_background_process(run.ctx, "sleep 60")
    reap(started.pid)

    running = background_exit_status(run.ctx, started.pid, wait=0.3)
    stranger = background_exit_status(run.ctx, os.getpid(), wait=0)
    stop_background_process(run.ctx, started.pid, grace=2)
    exited = background_exit_status(run.ctx, started.pid, wait=5)

    assert (running.supervised, running.running, running.exit_code) == (True, True, None)
    assert (stranger.supervised, stranger.running, stranger.exit_code) == (False, False, None)
    assert (exited.supervised, exited.running, exited.exit_code) == (True, False, 143)


def test_seconds_parameters_reject_booleans(tmp_path: Path) -> None:
    # `True` 是 1：`grace=True` 之类不报错，会被当成 1 秒。
    run = DirectRun(tmp_path)

    with pytest.raises(ValueError, match="grace 是秒数，不能是布尔值"):
        stop_background_process(run.ctx, 1, grace=True)
    with pytest.raises(ValueError, match="wait 是秒数，不能是布尔值"):
        background_exit_status(run.ctx, 1, wait=True)


@pytest.mark.parametrize(("cancelled", "expected"), [(False, 5), (True, 2)])
def test_the_wait_after_sigkill_is_shorter_once_the_task_is_cancelled(
    tmp_path: Path,
    reap: Callable[[int], int],
    monkeypatch: pytest.MonkeyPatch,
    cancelled: bool,
    expected: int,
) -> None:
    # 卡在不可中断的磁盘读写里的进程造不出来：用桩让「等进程消失」总是等不到，看等了多久。
    run = DirectRun(tmp_path)
    pid = start_stubborn(run, reap)
    if cancelled:
        run.cancel()
    waits: list[float] = []

    def never_gone(targets: Callable[[], list[int]], timeout: float) -> bool:
        waits.append(timeout)
        return False

    monkeypatch.setattr(processes, "_wait_gone", never_gone)

    with pytest.raises(StopFailed, match=f"发送 SIGKILL 后 {expected} 秒"):
        stop_background_process(run.ctx, pid, grace=0.2)

    assert waits == [0.2, expected]
