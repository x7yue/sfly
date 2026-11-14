"""`start_process`：在新会话里启动后台进程，节点结束后它继续运行。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `start_process` 一节；
停止用 `stop_process`（stop_process.py），两者共用的看护进程见 _supervise.py。
"""

from __future__ import annotations

import os
import select
import subprocess
import sys
import time
from typing import Annotated, TypedDict

from sfly import Context, Doc, node
from sfly_std import _process, _supervise

#: 等看护进程报告命令 pid 的最长时间（秒）。
REPORT_TIMEOUT = 30.0


class StartProcessOutputs(TypedDict):
    pid: Annotated[int, Doc("进程号：交给 stop_process、process_monitor 等节点")]
    log_file: Annotated[
        str, Doc("日志文件的绝对路径：交给 wait_log_line、follow_log、collect_artifacts 等节点")
    ]


class StartFailed(Exception):
    """后台进程没有启动起来。"""


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
    _process.check_cwd(cwd)
    if log_file is None:
        log = os.path.abspath(ctx.procs_dir / f"{ctx.task.node_id}.log")
    else:
        log = os.path.abspath(os.path.join(cwd or os.getcwd(), log_file))
    os.makedirs(os.path.dirname(log), exist_ok=True)

    read_fd, write_fd = os.pipe()
    try:
        with open(log, "ab") as out:
            supervisor = subprocess.Popen(
                [
                    sys.executable,
                    "-I",
                    _supervise.__file__,
                    str(ctx.procs_dir),
                    str(write_fd),
                    shell,
                    "-c",
                    command,
                ],
                cwd=cwd,
                env=_process.child_env(env),
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=subprocess.STDOUT,
                pass_fds=(write_fd,),
                # 新会话：不在任务的进程组里，任务结束、取消或超时时平台终止进程树都不会波及它。
                start_new_session=True,
            )
    finally:
        os.close(write_fd)
    try:
        report = _read_report(read_fd)
    finally:
        os.close(read_fd)
    preview = _process.preview(command)
    if not report.isdigit():
        supervisor.wait()
        reason = report.removeprefix("error ") or f"看护进程退出码 {supervisor.returncode}"
        raise StartFailed(f"无法启动后台进程（{reason}）：{preview}")
    pid = int(report)
    ctx.log.info("已启动后台进程 %d：%s；日志：%s", pid, preview, log)
    return {"pid": pid, "log_file": log}


def _read_report(fd: int) -> str:
    """读看护进程经管道报告的一行（命令的 pid 或 `error <原因>`），直到它关闭管道。"""
    data = b""
    deadline = time.monotonic() + REPORT_TIMEOUT
    while (left := deadline - time.monotonic()) > 0:
        ready, _, _ = select.select([fd], [], [], left)
        if not ready:
            break
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        data += chunk
    return data.decode("utf-8", errors="replace").strip()
