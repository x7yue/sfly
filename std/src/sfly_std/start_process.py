"""`start_process`：在新会话里启动后台进程，节点结束后它继续运行。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `start_process` 一节；
停止用 `stop_process`（stop_process.py）。逻辑在辅助函数
`sfly_std.processes.start_background_process`，
这里是它的节点外壳。
"""

from __future__ import annotations

import os
from typing import Annotated, TypedDict

from sfly import Context, Doc, node
from sfly_std.processes import StartFailed as _StartFailed
from sfly_std.processes import start_background_process

__all__ = ["StartFailed", "start_process"]


class StartProcessOutputs(TypedDict):
    pid: Annotated[int, Doc("进程号：交给 stop_process、process_monitor 等节点")]
    log_file: Annotated[
        str, Doc("日志文件的绝对路径：交给 wait_log_line、follow_log、collect_artifacts 等节点")
    ]


class StartFailed(_StartFailed):
    """后台进程没有启动起来（节点失败时的错误类型：和 0.3.0 一样写成
    `sfly_std.start_process.StartFailed`）。"""


@node(title="启动后台进程")
def start_process(
    ctx: Context,
    command: Annotated[str, Doc("要执行的命令")],
    shell: Annotated[str, Doc("解释器，与 shell 节点相同")] = "/bin/sh",
    env: Annotated[
        dict[str, str] | None, Doc("追加的环境变量（对象，值为字符串），在 Agent 的环境变量之上")
    ] = None,
    cwd: Annotated[str | None, Doc("工作目录，必须已经存在")] = None,
    log_file: Annotated[
        str | None,
        Doc("进程的标准输出和标准错误追加写入的文件；相对路径相对于 cwd，目录不存在时自动创建"),
    ] = None,
) -> StartProcessOutputs:
    """在后台启动一个常驻进程，不等它结束，输出进程号和日志文件的路径。

    副作用：进程在新的会话和进程组里运行，不属于任务的进程树。
    节点结束、任务被取消或超时都不会停止它，运行结束后也不会自动停止。
    一定要配一个 stop_process 并设为 always 节点，前面的节点失败或运行被取消时它仍然会执行。
    进程的标准输出和标准错误只写进日志文件，不转为任务日志。
    默认的日志文件不在任务目录里，和任务目录按同一个保留期清理。

    失败：只有解释器或工作目录不存在时失败。
    命令随后失败退出时节点仍然成功：用 wait_port、wait_log_line 等节点等它就绪。
    """
    if log_file is None:
        # 节点的默认日志文件固定是 <节点 ID>.log（节点重试时接着写）：一个任务只启动一次进程。
        log_file = os.path.abspath(ctx.procs_dir / f"{ctx.task.node_id}.log")
    try:
        started = start_background_process(
            ctx, command, shell=shell, env=env, cwd=cwd, log_path=log_file
        )
    except _StartFailed as error:
        raise StartFailed(*error.args) from None
    return {"pid": started.pid, "log_file": str(started.log_path)}
