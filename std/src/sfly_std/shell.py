"""`shell`：用解释器（默认 `/bin/sh`）执行一段命令。

用法与安全说明见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `shell` 一节。
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Sequence
from typing import IO, TypedDict

from sfly import Context, node
from sfly_std import _process

#: 输出里保留的 stdout 末尾字节数。
STDOUT_TAIL_BYTES = 64 * 1024
#: 失败信息里附带的 stderr 末尾字节数（从完整的一行开始）。
STDERR_TAIL_BYTES = 4 * 1024
#: 命令退出后，等待仍持有输出管道的后台进程关闭管道的最长时间（秒）。
DRAIN_TIMEOUT = 2.0


class ShellOutputs(TypedDict):
    exit_code: int
    stdout: str


class CommandFailed(Exception):
    """命令的退出码不在 `ok_exit_codes` 中。"""


class _Forward:
    """在后台线程里把管道的内容原样写到执行器自己的 stdout / stderr（Agent 实时转为日志），
    同时保留末尾 `keep` 个字节。"""

    def __init__(self, pipe: IO[bytes], dest: IO[bytes], keep: int) -> None:
        self._pipe, self._dest, self._keep = pipe, dest, keep
        self._tail = bytearray()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        fd = self._pipe.fileno()
        while chunk := os.read(fd, 65536):
            self._dest.write(chunk)
            self._dest.flush()
            self._tail += chunk
            del self._tail[: -self._keep]

    def join(self, deadline: float) -> None:
        self._thread.join(max(0.0, deadline - time.monotonic()))

    def text(self) -> str:
        """末尾的内容；截断处落在多字节字符中间时去掉残缺的字节。"""
        tail = bytes(self._tail)
        if len(tail) >= self._keep:
            tail = tail.lstrip(bytes(range(0x80, 0xC0)))  # UTF-8 的后续字节 10xxxxxx
        return tail.decode("utf-8", errors="replace")

    def last_lines(self) -> str:
        """末尾的内容，去掉被截断的第一行。"""
        tail = bytes(self._tail)
        if len(tail) >= self._keep and b"\n" in tail:
            tail = tail.split(b"\n", 1)[1]
        return tail.decode("utf-8", errors="replace").rstrip("\n")


@node(title="Shell 命令")
def shell(
    ctx: Context,
    command: str,
    shell: str = "/bin/sh",
    env: dict[str, str] | None = None,
    cwd: str | None = None,
    ok_exit_codes: Sequence[int] = (0,),
) -> ShellOutputs:
    """执行 `<shell> -c <command>`，stdout、stderr 实时转为任务日志。

    - `shell`：解释器，默认 `/bin/sh`，也可以是 `/bin/bash`、`python3` 等任何接受 `-c` 的程序；
    - `env`：追加的环境变量（在 Agent 的环境变量之上）；`cwd`：工作目录，默认任务工作目录；
    - `ok_exit_codes`：算作成功的退出码，默认 `[0]`；不在其中时失败，错误信息附 stderr 末尾。

    输出退出码（被信号终止时为 128 + 信号值）和 stdout 的最后 64 KiB。
    """
    _process.check_cwd(cwd)
    try:
        proc = subprocess.Popen(
            [shell, "-c", command],
            cwd=cwd,
            env=_process.child_env(env),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        raise FileNotFoundError(f"找不到解释器 {shell}") from None
    assert proc.stdout is not None and proc.stderr is not None
    stdout = _Forward(proc.stdout, sys.stdout.buffer, STDOUT_TAIL_BYTES)
    stderr = _Forward(proc.stderr, sys.stderr.buffer, STDERR_TAIL_BYTES)
    try:
        # 取消或超时时这里抛出 Cancelled：平台已经向整棵进程树（执行器和命令在同一个进程组里）
        # 发了 SIGTERM，宽限期过后强制杀掉，节点不需要自己终止命令，让 Cancelled 继续往外传即可。
        returncode = proc.wait()
    finally:
        # 命令退出后，它启动的后台进程可能还持有输出管道：最多再转发 DRAIN_TIMEOUT 秒。
        deadline = time.monotonic() + DRAIN_TIMEOUT
        stdout.join(deadline)
        stderr.join(deadline)

    # 被信号终止时按 shell 的习惯记为 128 + 信号值。
    exit_code = returncode if returncode >= 0 else 128 - returncode
    if exit_code not in ok_exit_codes:
        if returncode < 0:
            reason = f"命令被信号 {signal.Signals(-returncode).name} 终止（退出码 {exit_code}）"
        else:
            reason = f"命令退出码 {exit_code}"
        message = (
            f"{reason}，不在 ok_exit_codes {list(ok_exit_codes)} 中：{_process.preview(command)}"
        )
        tail = stderr.last_lines()
        raise CommandFailed(f"{message}\n\nstderr 末尾：\n{tail}" if tail else message)
    return {"exit_code": exit_code, "stdout": stdout.text()}
