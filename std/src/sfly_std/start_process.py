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
from typing import TypedDict

from sfly import Context, node
from sfly_std import _supervise

#: 等看护进程报告命令 pid 的最长时间（秒）。
REPORT_TIMEOUT = 30.0
#: 日志里命令的最大字符数。
COMMAND_PREVIEW_CHARS = 200


class StartProcessOutputs(TypedDict):
    pid: int
    log_file: str


class StartFailed(Exception):
    """后台进程没有启动起来。"""


@node(title="启动后台进程")
def start_process(
    ctx: Context,
    command: str,
    shell: str = "/bin/sh",
    env: dict[str, str] | None = None,
    cwd: str | None = None,
    log_file: str | None = None,
) -> StartProcessOutputs:
    """在新会话里执行 `<shell> -c <command>`，不等它结束：节点结束、任务被清理后进程继续运行。

    - `shell`、`env`、`cwd` 与 `shell` 节点相同；
    - `log_file`：进程的 stdout、stderr 追加写入的文件，
      默认 `$SFLY_HOME/procs/<运行 ID>/<节点 ID>.log`（不在任务目录里，任务目录被清理时不受影响）；
      相对路径相对于 `cwd`（默认任务工作目录）。

    输出进程的 `pid`（交给 `stop_process`、`process_monitor` 等）和日志文件的绝对路径 `log_file`。
    """
    if cwd is not None and not os.path.isdir(cwd):
        raise NotADirectoryError(f"工作目录不存在：{cwd}")
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
                env={**os.environ, **env} if env else None,
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
    preview = command
    if len(command) > COMMAND_PREVIEW_CHARS:
        preview = command[:COMMAND_PREVIEW_CHARS] + "…"
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
