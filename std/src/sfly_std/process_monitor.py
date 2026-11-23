"""`process_monitor`：按采样间隔统计目标进程（默认含整棵进程树）的资源。

指标是所有进程的合计，另按每个进程（标签 `pid`、`name`）各上报一个序列。
每个进程每次采样的明细写进产物 `processes.csv`，每采样一次就写入并刷新，
节点被停止、取消时已采集的明细不丢。用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的
`process_monitor` 一节；逻辑在辅助函数 `sfly_std.resources.monitor_processes`，这里是它的节点外壳
（节点没有 `refind_within` 参数：目标进程退出就按 `on_exit` 处理，和 0.3.0 一致；
进程重启后接着监控要用辅助函数）。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated, Literal, TypedDict

from sfly import Context, Doc, node
from sfly_std.resources import (
    PROCESS_CHARTS,
    PROCESS_METRICS,
    monitor_processes,
)
from sfly_std.resources import (
    ProcessExited as _ProcessExited,
)
from sfly_std.resources import (
    ProcessNotFound as _ProcessNotFound,
)

__all__ = ["ProcessExited", "ProcessNotFound", "process_monitor"]


class ProcessMonitorOutputs(TypedDict):
    samples: Annotated[int, Doc("采样了多少次")]
    processes_csv: Annotated[str, Doc("产物 processes.csv 的引用")]


class ProcessNotFound(_ProcessNotFound):
    """等了 `wait_for_process` 秒，仍有目标没有匹配到进程（和 0.3.0 一样写成
    `sfly_std.process_monitor.ProcessNotFound`）。"""


class ProcessExited(_ProcessExited):
    """监控期间某个目标匹配的进程全部退出了（`on_exit` 为 `fail`；和 0.3.0 一样写成
    `sfly_std.process_monitor.ProcessExited`）。"""


@node(
    title="监控进程",
    metrics=PROCESS_METRICS,
    charts=PROCESS_CHARTS,
    primary_metric="cpu_percent",
)
def process_monitor(
    ctx: Context,
    pid: Annotated[
        int | Sequence[int] | None, Doc("进程号，或进程号的列表；通常引用 start_process 的输出 pid")
    ] = None,
    name: Annotated[
        str | Sequence[str] | None,
        Doc("进程名（可执行文件名，例如 nginx，必须完全一致），或进程名的列表"),
    ] = None,
    match: Annotated[
        str | Sequence[str] | None,
        Doc("命令行（各参数以空格连接）的正则表达式，部分匹配即可，或正则的列表"),
    ] = None,
    include_children: Annotated[bool, Doc("是否连同目标的全部子孙进程一起统计")] = True,
    wait_for_process: Annotated[float, Doc("开始时最多等多少秒让每个目标都出现")] = 60,
    interval: Annotated[float, Doc("采样间隔（秒）")] = 1,
    duration: Annotated[
        float | None,
        Doc("监控多少秒后成功结束；不设置时一直运行，直到被停止子流程节点停止或运行被取消"),
    ] = None,
    on_exit: Annotated[
        Literal["fail", "succeed"], Doc("目标进程退出时：fail 让节点失败，succeed 让节点成功结束")
    ] = "fail",
) -> ProcessMonitorOutputs:
    """统计目标进程（默认连同全部子孙进程）用了多少资源，上报合计和每个进程各自的指标。

    副作用：每个进程每次采样的明细写进产物 processes.csv，进程列表有变化时写一条任务日志。

    不设置 duration 时一直运行，直到被停止子流程节点停止或运行被取消，被停止时记为「已停止」，
    不算失败。

    失败：开始时最多等 wait_for_process 秒让每个目标都出现，等不到时失败，错误信息列出没找到的目标。
    某个目标匹配的进程全部退出时，on_exit 为 fail（默认）则失败，为 succeed 则成功结束。
    pid、name、match 一个都没给时也失败。
    """
    try:
        result = monitor_processes(
            ctx,
            pid=pid,
            name=name,
            match=match,
            include_children=include_children,
            appear_within=wait_for_process,
            interval=interval,
            duration=duration,
            on_exit=on_exit,
            csv_artifact="processes.csv",
        )
    except _ProcessNotFound as error:
        raise ProcessNotFound(*error.args) from None
    except _ProcessExited as error:
        raise ProcessExited(*error.args) from None
    return {"samples": result.samples, "processes_csv": result.csv_ref}
