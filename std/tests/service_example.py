"""示例业务节点：起服务、等就绪、采样资源、收集日志、停服务。"""

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

    副作用：启动的服务在节点结束前会被停掉，包括节点失败、被取消的时候：先发 SIGTERM，服务
    没有退出就在 5 秒后发 SIGKILL（取消或超时进入收尾时间时最多等 3 秒）。服务日志在服务
    停掉之后存成产物，节点失败时也存。

    失败：服务 60 秒内没有就绪，或者采样期间服务退出了。
    """
    service = start_background_process(ctx, command)
    try:
        try:
            wait_for_log_line(ctx, service.log_path, ready_line, read_from="start", wait=60)
            wait_for_port(ctx, port, wait=10)
            monitor = monitor_processes(ctx, pid=service.pid, duration=observe)
        finally:
            # 在 finally 里清理要在平台给的收尾时间（默认 10 秒）内做完：stop_background_process
            # 的宽限期默认 5 秒，取消或超时进入收尾时间时最多 3 秒，来得及发 SIGKILL。
            stopped = stop_background_process(ctx, service.pid)
    finally:
        # 服务停掉之后再存：日志里有它停止时的输出；节点失败时（最需要日志的时候）也存。
        log = ctx.artifacts.save("service.log", service.log_path)
    return {"samples": monitor.samples, "log": log, "exit_code": stopped.exit_code}
