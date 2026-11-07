"""`system_monitor`：在本机真实采样（`sfly.testing.run_node`）。"""

from __future__ import annotations

import os
import socket
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import psutil
import pytest

from sfly.local import Execution
from sfly.testing import run_node
from sfly_std.system_monitor import system_monitor

METRICS = {
    "cpu_percent",
    "mem_used_percent",
    "mem_used_bytes",
    "load1",
    "disk_used_percent",
    "disk_read_bytes_per_s",
    "disk_write_bytes_per_s",
    "net_rx_bytes_per_s",
    "net_tx_bytes_per_s",
}


def test_samples_every_metric_each_interval_and_succeeds_when_duration_ends(
    tmp_path: Path,
) -> None:
    result = run_node(system_monitor, {"interval": 0.2, "duration": 1}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert {point.name for point in result.metrics} == METRICS
    for name in METRICS:
        samples = [point for point in result.metrics if point.name == name]
        assert 3 <= len(samples) <= 6, (name, len(samples))
        assert all(point.kind == "gauge" for point in samples)


def values(result: Execution, name: str) -> list[float]:
    return [point.value for point in result.metrics if point.name == name]


def used_percent(path: str) -> float:
    """与 df 相同的口径：已用 /（已用 + 普通用户可用）。"""
    st = os.statvfs(path)
    used = (st.f_blocks - st.f_bfree) * st.f_frsize
    return 100 * used / (used + st.f_bavail * st.f_frsize)


def test_values_are_plausible_for_this_machine(tmp_path: Path) -> None:
    result = run_node(system_monitor, {"interval": 0.2, "duration": 0.6}, work_dir=tmp_path)

    assert result.status == "success", result.error
    total_memory = psutil.virtual_memory().total
    assert all(0 <= v <= 100 for v in values(result, "cpu_percent"))
    assert all(0 < v < 100 for v in values(result, "mem_used_percent"))
    assert all(0 < v < total_memory for v in values(result, "mem_used_bytes"))
    assert all(v >= 0 for v in values(result, "load1"))
    disk_used = values(result, "disk_used_percent")
    assert all(v == pytest.approx(used_percent("/"), abs=1) for v in disk_used)
    for name in (
        "disk_read_bytes_per_s",
        "disk_write_bytes_per_s",
        "net_rx_bytes_per_s",
        "net_tx_bytes_per_s",
    ):
        assert all(v >= 0 for v in values(result, name)), name


def test_disk_path_selects_the_file_system(tmp_path: Path) -> None:
    path = "/dev/shm"
    result = run_node(
        system_monitor, {"interval": 0.2, "duration": 0.4, "disk_path": path}, work_dir=tmp_path
    )

    assert result.status == "success", result.error
    assert values(result, "disk_used_percent")
    assert all(
        v == pytest.approx(used_percent(path), abs=1) for v in values(result, "disk_used_percent")
    )


@pytest.fixture
def loopback_traffic() -> Iterator[None]:
    """在回环网卡上尽快收发，直到测试结束。"""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen()
    stop = threading.Event()

    def sink() -> None:
        conn, _ = server.accept()
        with conn:
            while conn.recv(1 << 20):
                pass

    def source() -> None:
        with socket.create_connection(server.getsockname()) as client:
            chunk = b"x" * (1 << 16)
            while not stop.is_set():
                client.sendall(chunk)

    threads = [threading.Thread(target=sink), threading.Thread(target=source)]
    for thread in threads:
        thread.start()
    yield
    stop.set()
    for thread in threads:
        thread.join()
    server.close()


def test_nic_selects_one_network_interface(tmp_path: Path, loopback_traffic: None) -> None:
    lo = run_node(
        system_monitor, {"interval": 0.2, "duration": 0.6, "nic": "lo"}, work_dir=tmp_path / "lo"
    )

    assert lo.status == "success", lo.error
    # 回环网卡上的流量收发各算一次：每次采样都远超 1 MB/s。
    assert all(v > 1e6 for v in values(lo, "net_rx_bytes_per_s")), values(lo, "net_rx_bytes_per_s")
    assert all(v > 1e6 for v in values(lo, "net_tx_bytes_per_s"))

    others = [name for name in psutil.net_io_counters(pernic=True) if name != "lo"]
    if not others:
        pytest.skip("本机只有回环网卡")
    other = run_node(
        system_monitor,
        {"interval": 0.2, "duration": 0.6, "nic": others[0]},
        work_dir=tmp_path / "other",
    )
    assert other.status == "success", other.error
    assert max(values(other, "net_rx_bytes_per_s")) < min(values(lo, "net_rx_bytes_per_s")) / 10


def file_system_type(path: Path) -> str:
    mounts = psutil.disk_partitions(all=True)
    mount = max(
        (m for m in mounts if path.is_relative_to(m.mountpoint)), key=lambda m: len(m.mountpoint)
    )
    return mount.fstype


def test_disk_rates_cover_writes_to_disk(tmp_path: Path) -> None:
    if file_system_type(tmp_path) in ("tmpfs", "ramfs"):
        pytest.skip(f"{tmp_path} 在内存文件系统上，写入不经过磁盘（用 --basetemp 指到磁盘上）")
    written = 32 << 20
    done = threading.Event()

    def write_and_sync() -> None:
        with open(tmp_path / "data.bin", "wb") as f:
            for _ in range(written >> 20):
                f.write(os.urandom(1 << 20))
            f.flush()
            os.fsync(f.fileno())
        done.set()

    writer = threading.Timer(0.3, write_and_sync)
    writer.start()
    result = run_node(system_monitor, {"interval": 0.2, "duration": 2}, work_dir=tmp_path / "run")
    writer.join()

    assert result.status == "success", result.error
    assert done.is_set()
    # 速率 × 间隔 ≈ 这段时间里写入的字节数；合计还包括其他进程的写入，所以只要求不少于。
    assert sum(values(result, "disk_write_bytes_per_s")) * 0.2 >= written * 0.9


@pytest.mark.parametrize(
    ("inputs", "message"),
    [
        ({"nic": "eth-不存在"}, "ValueError: 网卡 'eth-不存在' 不存在，本机的网卡有："),
        ({"disk": "/dev/sdz9"}, "ValueError: 磁盘 '/dev/sdz9' 不存在，本机的磁盘有："),
        ({"disk_path": "/不存在/目录"}, "ValueError: disk_path 不存在：/不存在/目录"),
        ({"interval": 0}, "ValueError: interval 必须大于 0，实际为 0"),
        # 与 process_monitor、follow_log 的校验相同：duration 为 0 没有意义，也拒绝。
        ({"duration": 0}, "ValueError: duration 必须大于 0，实际为 0"),
        ({"duration": -1}, "ValueError: duration 必须大于 0，实际为 -1"),
    ],
)
def test_fails_clearly_before_sampling_when_inputs_are_wrong(
    tmp_path: Path, inputs: dict[str, object], message: str
) -> None:
    result = run_node(system_monitor, inputs, work_dir=tmp_path)

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message.startswith(message), result.error.message
    assert result.metrics == []


def test_lists_the_existing_network_interfaces_when_nic_does_not_exist(tmp_path: Path) -> None:
    result = run_node(system_monitor, {"nic": "eth-不存在"}, work_dir=tmp_path)

    assert result.error is not None
    listed = result.error.message.splitlines()[0].split("本机的网卡有：")[1]
    assert "lo" in listed.split(", ")


def test_disk_accepts_a_device_name_with_or_without_dev(tmp_path: Path) -> None:
    disk = next(iter(psutil.disk_io_counters(perdisk=True) or {}), None)
    if disk is None:
        pytest.skip("读不到本机的磁盘计数")
    for name in (disk, f"/dev/{disk}"):
        result = run_node(
            system_monitor, {"interval": 0.2, "duration": 0.2, "disk": name}, work_dir=tmp_path
        )

        assert result.status == "success", result.error
        assert len(values(result, "disk_read_bytes_per_s")) == 1


def test_runs_until_cancelled_without_duration_and_keeps_the_samples(tmp_path: Path) -> None:
    started = time.monotonic()
    result = run_node(
        system_monitor,
        {"interval": 0.2},
        cancel_when=lambda partial: len(values(partial, "cpu_percent")) >= 3,
        grace=5,
        work_dir=tmp_path,
    )

    assert result.status == "cancelled"
    assert time.monotonic() - started < 4  # 收到 SIGTERM 立即结束，不等宽限期
    assert len(values(result, "cpu_percent")) >= 3
    samples = len(values(result, "cpu_percent"))
    assert [line.message for line in result.logs if line.source == "sdk"] == [
        "开始监控：每 0.2 秒采样一次，空间使用率统计 / 所在的文件系统，网卡取合计，磁盘取合计；"
        "一直运行到被停止或取消",
        f"监控结束，共采样 {samples} 次",
    ]
