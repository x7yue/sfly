"""`system_monitor`：按采样间隔上报本机的 CPU、内存、负载、磁盘和网络指标。

磁盘和网络的速率除了合计（或参数 `disk`、`nic` 指定的那一块），
还按每块整块磁盘、每块网卡各上报一个序列。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `system_monitor` 一节。
"""

from __future__ import annotations

import os
import sys
import time
from collections.abc import Iterable
from typing import NamedTuple

import psutil

from sfly import Chart, Context, Metric, node
from sfly_std._sampling import rate, validate_duration, validate_interval


class Counters(NamedTuple):
    """某一时刻的累计字节数，两次之差除以间隔就是 `RATE_METRICS` 里对应的速率。"""

    disk_read: int
    disk_write: int
    net_rx: int
    net_tx: int


RATE_METRICS = (
    "disk_read_bytes_per_s",
    "disk_write_bytes_per_s",
    "net_rx_bytes_per_s",
    "net_tx_bytes_per_s",
)
#: 按网卡的指标（接收、发送），标签 `nic`。
NIC_METRICS = ("net_rx_bytes_per_s_by_nic", "net_tx_bytes_per_s_by_nic")
#: 按磁盘的指标（读取、写入），标签 `disk`。
DISK_METRICS = ("disk_read_bytes_per_s_by_disk", "disk_write_bytes_per_s_by_disk")


class Reading(NamedTuple):
    """某一时刻每块网卡（接收、发送）和每块磁盘（读取、写入，含分区）的累计字节数。

    合计、按网卡和按磁盘的速率都从同一次读数算出。
    """

    nics: dict[str, tuple[int, int]]
    disks: dict[str, tuple[int, int]]


def _read() -> Reading:
    nics = psutil.net_io_counters(pernic=True)
    disks = psutil.disk_io_counters(perdisk=True) or {}
    return Reading(
        {name: (c.bytes_recv, c.bytes_sent) for name, c in nics.items()},
        {name: (c.read_bytes, c.write_bytes) for name, c in disks.items()},
    )


def _whole_disk(name: str) -> bool:
    """是整块磁盘而不是分区，与 psutil 计算全部磁盘合计的口径相同：Linux 上是 /sys/block 下有的设备
    （含 loop 等虚拟设备）；其他平台按磁盘读到的本来就没有分区。"""
    if not sys.platform.startswith("linux"):
        return True
    return os.path.exists(f"/sys/block/{name.replace('/', '!')}")


def _net(reading: Reading, nic: str | None) -> tuple[int, int]:
    if nic is None:
        return _sum(reading.nics.values())
    if nic not in reading.nics:
        raise ValueError(f"网卡 {nic!r} 不存在，本机的网卡有：{', '.join(sorted(reading.nics))}")
    return reading.nics[nic]


def _disk(reading: Reading, disk: str | None) -> tuple[int, int]:
    if disk is None:
        return _sum(v for name, v in reading.disks.items() if _whole_disk(name))
    name = disk.removeprefix("/dev/")
    if name not in reading.disks:
        raise ValueError(f"磁盘 {disk!r} 不存在，本机的磁盘有：{', '.join(sorted(reading.disks))}")
    return reading.disks[name]


def _sum(values: Iterable[tuple[int, int]]) -> tuple[int, int]:
    first = second = 0
    for a, b in values:
        first += a
        second += b
    return first, second


def _counters(reading: Reading, nic: str | None, disk: str | None) -> Counters:
    return Counters(*_disk(reading, disk), *_net(reading, nic))


@node(
    title="系统监控",
    metrics=[
        Metric("cpu_percent", "%", description="CPU 使用率（所有核的平均）"),
        Metric("mem_used_percent", "%", description="已用内存占总内存的比例"),
        Metric("mem_used_bytes", "B", description="已用内存：总内存减去可用内存"),
        Metric("load1", "", description="1 分钟平均负载"),
        Metric("disk_used_percent", "%", description="disk_path 所在文件系统的已用空间比例"),
        Metric("disk_read_bytes_per_s", "B/s", description="磁盘每秒读取的字节数"),
        Metric("disk_write_bytes_per_s", "B/s", description="磁盘每秒写入的字节数"),
        Metric("net_rx_bytes_per_s", "B/s", description="网卡每秒接收的字节数"),
        Metric("net_tx_bytes_per_s", "B/s", description="网卡每秒发送的字节数"),
        Metric(
            "net_rx_bytes_per_s_by_nic",
            "B/s",
            description="每块网卡（含回环网卡 lo）每秒接收的字节数",
            labels=["nic"],
        ),
        Metric(
            "net_tx_bytes_per_s_by_nic",
            "B/s",
            description="每块网卡（含回环网卡 lo）每秒发送的字节数",
            labels=["nic"],
        ),
        Metric(
            "disk_read_bytes_per_s_by_disk",
            "B/s",
            description="每块整块磁盘（不含分区）每秒读取的字节数",
            labels=["disk"],
        ),
        Metric(
            "disk_write_bytes_per_s_by_disk",
            "B/s",
            description="每块整块磁盘（不含分区）每秒写入的字节数",
            labels=["disk"],
        ),
    ],
    charts=[
        Chart("CPU 使用率", "line", ["cpu_percent"]),
        Chart("内存使用率", "line", ["mem_used_percent"]),
        Chart("已用内存", "line", ["mem_used_bytes"]),
        Chart("负载", "line", ["load1"]),
        Chart("磁盘空间使用率", "line", ["disk_used_percent"]),
        Chart("磁盘读写", "line", ["disk_read_bytes_per_s", "disk_write_bytes_per_s"]),
        Chart("网络收发", "line", ["net_rx_bytes_per_s", "net_tx_bytes_per_s"]),
        Chart("磁盘读写（按磁盘）", "line", list(DISK_METRICS)),
        Chart("网络收发（按网卡）", "line", list(NIC_METRICS)),
    ],
    primary_metric="cpu_percent",
)
def system_monitor(
    ctx: Context,
    interval: float = 1,
    duration: float | None = None,
    disk_path: str = "/",
    nic: str | None = None,
    disk: str | None = None,
) -> None:
    """每 `interval` 秒（默认 1）采样一次本机的资源使用情况并上报为指标。

    `duration` 秒后成功结束；不设置时一直运行，直到被停止子流程节点停止或运行被取消。
    `disk_path`（默认 `/`）决定统计哪个文件系统的空间使用率；`nic`、`disk` 指定统计哪块网卡、
    哪块磁盘的速率，不指定时取全部网卡、全部磁盘的合计。
    """
    validate_interval(interval)
    validate_duration(duration)
    if not os.path.exists(disk_path):
        raise ValueError(f"disk_path 不存在：{disk_path}")
    # 第一次采样的 CPU 使用率和速率都相对于这里。
    psutil.cpu_percent(interval=None)
    last = time.monotonic()
    last_reading = _read()
    before = _counters(last_reading, nic, disk)
    ctx.log.info(
        "开始监控：每 %g 秒采样一次，空间使用率统计 %s 所在的文件系统，网卡%s，磁盘%s；%s",
        interval,
        disk_path,
        "取合计" if nic is None else f" {nic}",
        "取合计" if disk is None else f" {disk}",
        "一直运行到被停止或取消" if duration is None else f"运行 {duration:g} 秒",
    )
    samples = 0
    try:
        deadline = None if duration is None else last + duration
        while True:
            wait = interval
            if deadline is not None:
                wait = min(interval, deadline - time.monotonic())
                if wait <= 0:
                    break
            time.sleep(wait)
            now = time.monotonic()
            elapsed = now - last
            last = now
            reading = _read()
            after = _counters(reading, nic, disk)
            memory = psutil.virtual_memory()
            ctx.metric("cpu_percent", psutil.cpu_percent(interval=None))
            samples += 1
            ctx.metric("mem_used_percent", memory.percent)
            ctx.metric("mem_used_bytes", memory.total - memory.available)
            ctx.metric("load1", psutil.getloadavg()[0])
            ctx.metric("disk_used_percent", psutil.disk_usage(disk_path).percent)
            for name, current, previous in zip(RATE_METRICS, after, before, strict=True):
                ctx.metric(name, rate(current, previous, elapsed))
            _report_by_device(ctx, NIC_METRICS, "nic", reading.nics, last_reading.nics, elapsed)
            whole = {name: v for name, v in reading.disks.items() if _whole_disk(name)}
            _report_by_device(ctx, DISK_METRICS, "disk", whole, last_reading.disks, elapsed)
            before, last_reading = after, reading
    finally:
        # 被停止或取消时（Cancelled 从 sleep 里抛出）也执行；已上报的指标不受影响。
        ctx.log.info("监控结束，共采样 %d 次", samples)


def _report_by_device(
    ctx: Context,
    metrics: tuple[str, str],
    label: str,
    current: dict[str, tuple[int, int]],
    previous: dict[str, tuple[int, int]],
    elapsed: float,
) -> None:
    """每块网卡或磁盘各自上报两项速率；上次读数里还没有的设备（刚出现）从下一次采样开始上报。"""
    for device, values in current.items():
        if device not in previous:
            continue
        for metric, now, then in zip(metrics, values, previous[device], strict=True):
            ctx.metric(metric, rate(now, then, elapsed), labels={label: device})
