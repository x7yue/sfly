"""示例业务节点：起服务、等就绪、采样资源、收集日志、停服务。"""

from pathlib import Path
from typing import Annotated, TypedDict

from sfly import Context, Doc, node
from sfly_std.logs import wait_for_log_line
from sfly_std.processes import start_background_process, stop_background_process
from sfly_std.resources import PROCESS_CHARTS, PROCESS_METRICS, monitor_processes
from sfly_std.waiting import wait_for_port


class ServiceCheckOutputs(TypedDict):
    samples: Annotated[int, Doc("采样了多少次")]
    log: Annotated[str, Doc("服务日志的产物引用")]
    exit_code: Annotated[int | None, Doc("停止服务时它的退出码")]


@node(
    title="服务冒烟检查",
    metrics=PROCESS_METRICS,
    charts=PROCESS_CHARTS,
    primary_metric="cpu_percent",
)
def service_check(
    ctx: Context,
    command: Annotated[str, Doc("启动被测服务的命令")],
    port: Annotated[int, Doc("服务监听的端口")],
    ready_line: Annotated[str, Doc("服务就绪时打出的日志行（正则）")],
    observe: Annotated[float, Doc("就绪后采样资源的秒数")] = 10,
) -> ServiceCheckOutputs:
    """起服务，等它就绪，采样它的资源，收集日志，最后停掉服务。

    副作用：启动的服务在节点结束前一定会被停掉，包括节点失败、被取消的时候。

    失败：服务 60 秒内没有就绪，或者采样期间服务退出了。
    """
    service = start_background_process(ctx, command)
    try:
        wait_for_log_line(ctx, service.log_file, ready_line, read_from="start", wait=60)
        wait_for_port(ctx, port, wait=10)
        monitor = monitor_processes(ctx, pid=service.pid, duration=observe)
        log = ctx.artifacts.save("service.log", Path(service.log_file))
    finally:
        stopped = stop_background_process(ctx, service.pid)
    return {"samples": monitor.samples, "log": log, "exit_code": stopped.exit_code}
