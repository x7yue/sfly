"""`sfly_std.resources`：直接调用采样辅助函数；重点是进程重启后按名字重新找到它（`refind`）。"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from direct_context import DirectRun
from named_sleep import NamedSleep, named_sleep_fixture  # noqa: F401 -- fixture

from sfly_std.resources import (
    PROCESS_CHARTS,
    PROCESS_METRICS,
    SYSTEM_CHARTS,
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

    count = monitor_system(run.ctx, interval=0.2, duration=0.7).samples

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
    # 等待期间一个都不上报：既没有全是 0 的合计（活着的进程占用的内存不可能是 0），
    # 开始等待到重新出现之间也没有任何指标。
    assert all(value > 0 for value in run.metric("rss_bytes"))
    waiting = next(
        i for i, e in enumerate(events) if e["type"] == "log" and "最多再等 10 秒" in e["message"]
    )
    assert [e for e in events[waiting:found] if e["type"] == "metric"] == []
    # 按进程的指标：新进程是新的进程号，标签 pid 变了，是新的一条序列；合计接着原来的序列。
    pids = {
        e["labels"]["pid"]
        for e in events
        if e["type"] == "metric" and e["name"] == "rss_bytes_by_process"
    }
    assert len(pids) == 2


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


def test_system_metrics_are_declared_and_all_charted() -> None:
    # 每个指标都画在声明的图表里，不靠平台生成的默认图表。
    assert {m.name for m in SYSTEM_METRICS} == {
        "cpu_percent",
        "mem_used_percent",
        "mem_used_bytes",
        "load1",
        "disk_used_percent",
        "disk_read_bytes_per_s",
        "disk_write_bytes_per_s",
        "net_rx_bytes_per_s",
        "net_tx_bytes_per_s",
        "net_rx_bytes_per_s_by_nic",
        "net_tx_bytes_per_s_by_nic",
        "disk_read_bytes_per_s_by_disk",
        "disk_write_bytes_per_s_by_disk",
    }
    charted = {name for chart in SYSTEM_CHARTS for name in chart.metrics}
    assert charted == {m.name for m in SYSTEM_METRICS}


def test_process_metrics_are_declared_and_all_charted() -> None:
    charted = {name for chart in PROCESS_CHARTS for name in chart.metrics}
    assert charted == {m.name for m in PROCESS_METRICS}


def test_refind_finds_a_restarted_process_by_name(tmp_path: Path, named_sleep: NamedSleep) -> None:
    # 按 `name` 指定的目标重启后同样能找到新的（Linux：进程名要写 /proc/self/comm）。
    name = f"rf{uuid.uuid4().hex[:10]}"
    first = named_sleep.start(name, "300")
    run = DirectRun(tmp_path, metrics=PROCESS_METRICS)

    def restart() -> None:
        time.sleep(0.8)
        os.kill(first.pid, signal.SIGKILL)
        time.sleep(0.8)
        named_sleep.start(name, "300")

    restarter = threading.Thread(target=restart)
    restarter.start()
    try:
        result = monitor_processes(
            run.ctx, name=name, refind=10, interval=0.2, duration=4, wait_for_process=5
        )
    finally:
        restarter.join()

    assert result.samples >= 5
    messages = run.logs()
    assert any("最多再等 10 秒让它重新出现" in m and f'name "{name}"' in m for m in messages)
    assert any("重新出现" in m and "接着监控" in m for m in messages)
    assert all(value > 0 for value in run.metric("rss_bytes"))


def test_refind_keeps_sampling_the_other_target_while_one_of_two_is_restarting(
    tmp_path: Path, spawn: Callable[[str], subprocess.Popen[bytes]]
) -> None:
    tag_a, tag_b = f"tag-{uuid.uuid4().hex}", f"tag-{uuid.uuid4().hex}"
    first_a = spawn(tag_a)
    spawn(tag_b)
    run = DirectRun(tmp_path, metrics=PROCESS_METRICS)

    def restart_a() -> None:
        time.sleep(0.8)
        first_a.kill()
        first_a.wait()
        time.sleep(1.2)
        spawn(tag_a)

    restarter = threading.Thread(target=restart_a)
    restarter.start()
    try:
        # 一个目标在等待重新出现，另一个一直在：不失败，也不停止上报。
        result = monitor_processes(
            run.ctx, match=[tag_a, tag_b], refind=10, interval=0.2, duration=4, wait_for_process=5
        )
    finally:
        restarter.join()

    assert result.samples >= 5
    events = run.events()
    waiting = next(
        i for i, e in enumerate(events) if e["type"] == "log" and "最多再等 10 秒" in e["message"]
    )
    found = next(
        i
        for i, e in enumerate(events)
        if e["type"] == "log" and "重新出现" in e["message"] and "接着监控" in e["message"]
    )
    during = [
        e for e in events[waiting:found] if e["type"] == "metric" and e["name"] == "rss_bytes"
    ]
    assert during and all(e["value"] > 0 for e in during)  # 只有 B 的合计，不是 0


def test_the_duration_can_run_out_while_waiting_for_a_process_to_come_back(
    tmp_path: Path, spawn: Callable[[str], subprocess.Popen[bytes]]
) -> None:
    tag = f"tag-{uuid.uuid4().hex}"
    first = spawn(tag)
    run = DirectRun(tmp_path, metrics=PROCESS_METRICS)
    threading.Timer(0.6, first.kill).start()
    started = time.monotonic()

    # refind 比 duration 长：等待重新出现的时候 duration 到期，成功返回（不是 ProcessExited）。
    result = monitor_processes(
        run.ctx, match=tag, refind=30, interval=0.2, duration=2, wait_for_process=5
    )

    assert time.monotonic() - started < 10
    assert result.samples >= 5
    assert any("最多再等 30 秒" in m for m in run.logs())


def test_each_call_saves_its_own_processes_csv_unless_a_name_is_given(
    tmp_path: Path, spawn: Callable[[str], subprocess.Popen[bytes]]
) -> None:
    # 压测前、压测中各采一段：两次调用的明细互不覆盖。
    tag = f"tag-{uuid.uuid4().hex}"
    spawn(tag)
    run = DirectRun(tmp_path, metrics=PROCESS_METRICS)

    first = monitor_processes(run.ctx, match=tag, interval=0.2, duration=0.6)
    second = monitor_processes(run.ctx, match=tag, interval=0.2, duration=0.6)
    named = monitor_processes(
        run.ctx, match=tag, interval=0.2, duration=0.6, csv_artifact="压测/明细.csv"
    )

    assert [first.csv_artifact, second.csv_artifact, named.csv_artifact] == [
        "processes.csv",
        "processes-2.csv",
        "压测/明细.csv",
    ]
    assert len({first.processes_csv, second.processes_csv, named.processes_csv}) == 3
    artifacts = tmp_path / "artifacts"
    assert len((artifacts / "processes.csv").read_text().splitlines()) >= 2
    assert len((artifacts / "processes-2.csv").read_text().splitlines()) >= 2
    assert (artifacts / "压测" / "明细.csv").exists()
    # 第二次调用没有覆盖第一次：第一次的明细行数和采样次数一致（每次采样一个进程一行，外加表头）。
    assert len((artifacts / "processes.csv").read_text().splitlines()) == first.samples + 1
