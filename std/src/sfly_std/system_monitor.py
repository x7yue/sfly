"""`system_monitor`：按采样间隔上报本机的 CPU、内存、负载、磁盘和网络指标。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `system_monitor` 一节。
"""

from __future__ import annotations

import os
import time
from typing import NamedTuple

import psutil

from sfly import Chart, Context, Metric, node


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


def _net(nic: str | None) -> tuple[int, int]:
    if nic is None:
        total = psutil.net_io_counters()
        return total.bytes_recv, total.bytes_sent
    per_nic = psutil.net_io_counters(pernic=True)
    if nic not in per_nic:
        raise ValueError(f"网卡 {nic!r} 不存在，本机的网卡有：{', '.join(sorted(per_nic))}")
    return per_nic[nic].bytes_recv, per_nic[nic].bytes_sent


def _disk(disk: str | None) -> tuple[int, int]:
    if disk is None:
        total = psutil.disk_io_counters()
        return (total.read_bytes, total.write_bytes) if total is not None else (0, 0)
    per_disk = psutil.disk_io_counters(perdisk=True) or {}
    name = disk.removeprefix("/dev/")
    if name not in per_disk:
        raise ValueError(f"磁盘 {disk!r} 不存在，本机的磁盘有：{', '.join(sorted(per_disk))}")
    return per_disk[name].read_bytes, per_disk[name].write_bytes


def _counters(nic: str | None, disk: str | None) -> Counters:
    return Counters(*_disk(disk), *_net(nic))


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
    ],
    charts=[
        Chart("CPU 使用率", "line", ["cpu_percent"]),
        Chart("内存使用率", "line", ["mem_used_percent"]),
        Chart("已用内存", "line", ["mem_used_bytes"]),
        Chart("负载", "line", ["load1"]),
        Chart("磁盘空间使用率", "line", ["disk_used_percent"]),
        Chart("磁盘读写", "line", ["disk_read_bytes_per_s", "disk_write_bytes_per_s"]),
        Chart("网络收发", "line", ["net_rx_bytes_per_s", "net_tx_bytes_per_s"]),
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
    if interval <= 0:
        raise ValueError(f"interval 必须大于 0，实际为 {interval:g}")
    if duration is not None and duration < 0:
        raise ValueError(f"duration 不能小于 0，实际为 {duration:g}")
    if not os.path.exists(disk_path):
        raise ValueError(f"disk_path 不存在：{disk_path}")
    # 第一次采样的 CPU 使用率和速率都相对于这里。
    psutil.cpu_percent(interval=None)
    last = time.monotonic()
    before = _counters(nic, disk)
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
            after = _counters(nic, disk)
            memory = psutil.virtual_memory()
            ctx.metric("cpu_percent", psutil.cpu_percent(interval=None))
            samples += 1
            ctx.metric("mem_used_percent", memory.percent)
            ctx.metric("mem_used_bytes", memory.total - memory.available)
            ctx.metric("load1", psutil.getloadavg()[0])
            ctx.metric("disk_used_percent", psutil.disk_usage(disk_path).percent)
            for name, current, previous in zip(RATE_METRICS, after, before, strict=True):
                # 计数器被重置（例如网卡重新插拔）时不报负数。
                ctx.metric(name, max(current - previous, 0) / elapsed)
            before = after
    finally:
        # 被停止或取消时（Cancelled 从 sleep 里抛出）也执行；已上报的指标不受影响。
        ctx.log.info("监控结束，共采样 %d 次", samples)
