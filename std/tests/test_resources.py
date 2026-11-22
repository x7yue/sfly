"""`sfly_std.resources`：直接调用采样辅助函数；重点是进程重启后按名字重新找到它（`refind`）。"""

from __future__ import annotations

import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from direct_context import DirectRun

from sfly_std.resources import (
    PROCESS_METRICS,
    SYSTEM_METRICS,
    ProcessExited,
    ProcessNotFound,
    monitor_processes,
    monitor_system,
)

#: 命令行里带一个标记的睡眠进程；`match` 标记就能找到它，不依赖 Linux 才有的改进程名。
SLEEP = "import time; time.sleep(60)"


@pytest.fixture
def spawn() -> Iterator[Callable[[str], subprocess.Popen[bytes]]]:
    procs: list[subprocess.Popen[bytes]] = []

    def start(tag: str) -> subprocess.Popen[bytes]:
        proc = subprocess.Popen([sys.executable, "-c", SLEEP, tag])
        procs.append(proc)
        return proc

    yield start
    for proc in procs:
        proc.kill()
        proc.wait()


def test_monitor_system_reports_the_declared_metrics_and_returns_the_sample_count(
    tmp_path: Path,
) -> None:
    run = DirectRun(tmp_path, metrics=SYSTEM_METRICS)

    count = monitor_system(run.ctx, interval=0.2, duration=0.7)

    assert count >= 2
    assert len(run.metric("cpu_percent")) == count
    assert all(0 <= v <= 100 for v in run.metric("mem_used_percent"))


def test_a_restarted_process_is_found_again_by_name_within_refind_seconds(
    tmp_path: Path, spawn: Callable[[str], subprocess.Popen[bytes]]
) -> None:
    # 原来的 process_monitor 在进程重启后失败：给了 refind 就按名字找到新进程、接着监控。
    tag = f"tag-{uuid.uuid4().hex}"
    first = spawn(tag)
    run = DirectRun(tmp_path, metrics=PROCESS_METRICS)

    def restart() -> None:
        time.sleep(0.8)
        first.kill()
        first.wait()
        time.sleep(0.8)
        spawn(tag)

    restarter = threading.Thread(target=restart)
    restarter.start()
    try:
        result = monitor_processes(
            run.ctx, match=tag, refind=10, interval=0.2, duration=4, wait_for_process=5
        )
    finally:
        restarter.join()

    assert result.samples >= 5
    assert any("最多再等 10 秒让它重新出现" in message for message in run.logs())
    # 等待期间不上报指标（没有进程可统计）；重新出现之后又有了资源数据。
    events = run.events()
    found = next(
        i
        for i, e in enumerate(events)
        if e["type"] == "log" and "重新出现" in e["message"] and "接着监控" in e["message"]
    )
    assert any(e["type"] == "metric" and e["name"] == "rss_bytes" for e in events[found:])
    assert [e for e in events[found:] if e["type"] == "log" and "新增" in e["message"]]


def test_without_refind_a_restart_ends_the_monitoring_with_process_exited(
    tmp_path: Path, spawn: Callable[[str], subprocess.Popen[bytes]]
) -> None:
    tag = f"tag-{uuid.uuid4().hex}"
    first = spawn(tag)
    run = DirectRun(tmp_path, metrics=PROCESS_METRICS)
    threading.Timer(0.6, first.kill).start()

    with pytest.raises(ProcessExited, match="目标进程已退出"):
        monitor_processes(run.ctx, match=tag, interval=0.2, duration=10, wait_for_process=5)


def test_a_process_that_does_not_come_back_within_refind_seconds_counts_as_exited(
    tmp_path: Path, spawn: Callable[[str], subprocess.Popen[bytes]]
) -> None:
    tag = f"tag-{uuid.uuid4().hex}"
    first = spawn(tag)
    run = DirectRun(tmp_path, metrics=PROCESS_METRICS)
    threading.Timer(0.6, first.kill).start()
    started = time.monotonic()

    with pytest.raises(ProcessExited):
        monitor_processes(
            run.ctx, match=tag, refind=1, interval=0.2, duration=20, wait_for_process=5
        )

    assert time.monotonic() - started >= 1.6  # 先监控了约 0.6 秒，再等满 refind 的 1 秒


def test_on_exit_succeed_ends_quietly_after_refind_runs_out(
    tmp_path: Path, spawn: Callable[[str], subprocess.Popen[bytes]]
) -> None:
    tag = f"tag-{uuid.uuid4().hex}"
    first = spawn(tag)
    run = DirectRun(tmp_path, metrics=PROCESS_METRICS)
    threading.Timer(0.6, first.kill).start()

    result = monitor_processes(
        run.ctx, match=tag, refind=0.5, on_exit="succeed", interval=0.2, duration=20
    )

    assert result.samples >= 2


def test_refind_does_not_apply_to_targets_given_by_pid(
    tmp_path: Path, spawn: Callable[[str], subprocess.Popen[bytes]]
) -> None:
    # 进程号是一次性的：退出了就是退出了，不会等一个「同样的」进程号。
    first = spawn(f"tag-{uuid.uuid4().hex}")
    run = DirectRun(tmp_path, metrics=PROCESS_METRICS)
    threading.Timer(0.6, first.kill).start()
    started = time.monotonic()

    with pytest.raises(ProcessExited):
        monitor_processes(run.ctx, pid=first.pid, refind=30, interval=0.2, duration=20)

    assert time.monotonic() - started < 10


def test_a_negative_refind_or_a_target_that_never_appears_is_an_error(tmp_path: Path) -> None:
    run = DirectRun(tmp_path, metrics=PROCESS_METRICS)

    with pytest.raises(ValueError, match="refind 不能为负数"):
        monitor_processes(run.ctx, match="x", refind=-1)
    with pytest.raises(ProcessNotFound, match="没有找到目标进程"):
        monitor_processes(
            run.ctx, match=f"no-such-{uuid.uuid4().hex}", wait_for_process=0.5, duration=1
        )
