"""`stop_process`：终止后台进程所在的进程组，先 SIGTERM，宽限期后 SIGKILL。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `stop_process` 一节；
逻辑在辅助函数 `sfly_std.processes.stop_background_process`，这里是它的节点外壳。
"""

from __future__ import annotations

from typing import Annotated, TypedDict

from sfly import Context, Doc, node
from sfly_std.processes import StopFailed as _StopFailed
from sfly_std.processes import stop_background_process

__all__ = ["StopFailed", "stop_process"]


class StopProcessOutputs(TypedDict):
    was_running: Annotated[bool, Doc("开始停止时进程是否还在运行")]
    exit_code: Annotated[
        int | None,
        Doc(
            "进程的退出码：被信号终止时为 128 + 信号值（SIGTERM 为 143，被 SIGKILL 强制杀掉为 137）"
            "；拿不到时为 null"
        ),
    ]


class StopFailed(_StopFailed):
    """SIGKILL 之后进程仍然没有退出（节点失败时的错误类型：和 0.3.0 一样写成
    `sfly_std.stop_process.StopFailed`）。"""


@node(title="停止后台进程")
def stop_process(
    ctx: Context,
    pid: Annotated[
        int | None,
        Doc("要停止的进程号，通常引用 start_process 的输出 pid；为空时什么也不做、直接成功"),
    ] = None,
    grace: Annotated[float, Doc("从 SIGTERM 到 SIGKILL 的宽限期（秒）")] = 10,
) -> StopProcessOutputs:
    """停止 start_process 启动的后台进程：终止 pid 所在的整个进程组。

    副作用：先发 SIGTERM，宽限期过后还没退出的发 SIGKILL。
    进程组里的子进程一起终止，自己脱离进程组的进程不在其中。
    进程已经不在、或 pid 为空（例如上游的 start_process 没有成功）时什么也不做，直接成功，
    所以适合设为 always 节点来清理。

    失败：宽限期加 SIGKILL 之后进程仍然没有退出（例如卡在不可中断的磁盘读写里）时失败。
    """
    try:
        stopped = stop_background_process(ctx, pid, grace=grace)
    except _StopFailed as error:
        raise StopFailed(*error.args) from None
    return {"was_running": stopped.was_running, "exit_code": stopped.exit_code}
