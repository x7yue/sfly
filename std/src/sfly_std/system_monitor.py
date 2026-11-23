"""`system_monitor`：按采样间隔上报本机的 CPU、内存、负载、磁盘和网络指标。

磁盘和网络的速率除了合计（或参数 `disk`、`nic` 指定的那一块），
还按每块整块磁盘、每块网卡各上报一个序列。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `system_monitor` 一节；
逻辑在辅助函数 `sfly_std.resources.monitor_system`，这里是它的节点外壳。
"""

from __future__ import annotations

from typing import Annotated

from sfly import Context, Doc, node
from sfly_std.resources import SYSTEM_CHARTS, SYSTEM_METRICS, monitor_system


@node(
    title="系统监控",
    metrics=SYSTEM_METRICS,
    charts=SYSTEM_CHARTS,
    primary_metric="cpu_percent",
)
def system_monitor(
    ctx: Context,
    interval: Annotated[float, Doc("采样间隔（秒），必须大于 0")] = 1,
    duration: Annotated[
        float | None,
        Doc("监控多少秒后成功结束；不设置时一直运行，直到被停止子流程节点停止或运行被取消"),
    ] = None,
    disk_path: Annotated[
        str, Doc("统计哪个文件系统的空间使用率：给出其中的任意路径，必须已经存在")
    ] = "/",
    nic: Annotated[
        str | None, Doc("统计哪块网卡的收发速率，例如 eth0；合计包含回环网卡 lo")
    ] = None,
    disk: Annotated[
        str | None,
        Doc("统计哪块磁盘的读写速率，例如 nvme0n1 或 /dev/sda；合计只算整块磁盘，不重复计入分区"),
    ] = None,
) -> None:
    """按采样间隔上报执行它的 Agent 所在机器的 CPU、内存、负载、磁盘和网络指标。

    不设置 duration 时一直运行，直到被停止子流程节点停止或运行被取消，
    所以要放在子流程里和压测同时运行。
    被停止时记为「已停止」，不算失败，已经上报的指标都保留。

    失败：指定的网卡、磁盘或 disk_path 不存在时立即失败，错误信息列出本机有哪些网卡、磁盘。
    """
    monitor_system(
        ctx, interval=interval, duration=duration, disk_path=disk_path, nic=nic, disk=disk
    )
