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
from typing import IO, Annotated, TypedDict

from sfly import Context, Doc, node
from sfly_std import _process

#: 输出里保留的 stdout、stderr 末尾字节数。
OUTPUT_TAIL_BYTES = 64 * 1024
#: 失败信息里附带的 stderr 末尾字节数（从完整的一行开始）。
ERROR_TAIL_BYTES = 4 * 1024
#: 打开 `save_output` 时保存完整 stdout、stderr 的产物名称。
STDOUT_ARTIFACT = "stdout.txt"
STDERR_ARTIFACT = "stderr.txt"
#: 命令退出后，等待仍持有输出管道的后台进程关闭管道的最长时间（秒）。
DRAIN_TIMEOUT = 2.0


class ShellOutputs(TypedDict):
    exit_code: Annotated[int, Doc("退出码；命令被信号终止时为 128 + 信号值（与 shell 的 $? 相同）")]
    stdout: Annotated[str, Doc("标准输出的最后 64 KiB")]
    stderr: Annotated[str, Doc("标准错误的最后 64 KiB")]
    stdout_file: Annotated[
        str | None, Doc("产物 stdout.txt（完整的标准输出）的引用；save_output 为 false 时是空值")
    ]
    stderr_file: Annotated[
        str | None, Doc("产物 stderr.txt（完整的标准错误）的引用；save_output 为 false 时是空值")
    ]


class CommandFailed(Exception):
    """命令的退出码不在 `ok_exit_codes` 中。"""


class _Forward:
    """在后台线程里把管道的内容原样写到执行器自己的 stdout / stderr（Agent 实时转为日志），
    同时保留末尾 OUTPUT_TAIL_BYTES 个字节；给了 `artifact` 时把读到的原始字节边读边写进这个产物。"""

    def __init__(self, ctx: Context, dest: IO[bytes], artifact: str | None) -> None:
        self._dest = dest
        #: 保存完整内容的产物的引用；没有保存时为 None。
        self.ref = ctx.artifacts.ref(artifact) if artifact is not None else None
        self._path = ctx.artifacts.path(artifact) if artifact is not None else None
        self._save: IO[bytes] | None = None
        self._tail = bytearray()
        #: 持有它才能转发；`finish` 之后不再转发。
        self._lock = threading.Lock()
        self._finished = False
        self._thread: threading.Thread | None = None

    def start(self, pipe: IO[bytes]) -> None:
        """开始转发 `pipe` 的内容。"""
        if self._path is not None:
            # 不带缓冲：命令还在运行、或者被取消时，已经读到的内容都在文件里。
            self._save = self._path.open("wb", buffering=0)
        self._thread = threading.Thread(target=self._run, args=(pipe.fileno(),), daemon=True)
        self._thread.start()

    def _run(self, fd: int) -> None:
        while chunk := os.read(fd, 65536):
            with self._lock:
                if self._finished:
                    return
                self._dest.write(chunk)
                self._dest.flush()
                if self._save is not None:
                    self._save.write(chunk)
                self._tail += chunk
                del self._tail[:-OUTPUT_TAIL_BYTES]

    def finish(self, deadline: float) -> None:
        """等管道读完，最晚到 `deadline`；之后不再转发，末尾内容和产物就此不变。"""
        assert self._thread is not None
        self._thread.join(max(0.0, deadline - time.monotonic()))
        with self._lock:
            self._finished = True
            if self._save is not None:
                self._save.close()

    def text(self) -> str:
        """末尾的内容；截断处落在多字节字符中间时去掉残缺的字节。"""
        tail = bytes(self._tail)
        if len(tail) >= OUTPUT_TAIL_BYTES:
            tail = tail.lstrip(bytes(range(0x80, 0xC0)))  # UTF-8 的后续字节 10xxxxxx
        return tail.decode("utf-8", errors="replace")

    def last_lines(self, limit: int) -> str:
        """末尾 `limit` 个字节的内容，去掉被截断的第一行。"""
        tail = bytes(self._tail[-limit:])
        if len(tail) >= limit and b"\n" in tail:
            tail = tail.split(b"\n", 1)[1]
        return tail.decode("utf-8", errors="replace").rstrip("\n")


@node(title="Shell 命令")
def shell(
    ctx: Context,
    command: Annotated[str, Doc("要执行的命令")],
    shell: Annotated[
        str, Doc("解释器：/bin/bash、python3 等任何能用 -c 执行一段命令的程序")
    ] = "/bin/sh",
    env: Annotated[
        dict[str, str] | None, Doc("追加的环境变量（对象，值为字符串），在 Agent 的环境变量之上")
    ] = None,
    cwd: Annotated[str | None, Doc("工作目录，必须已经存在")] = None,
    ok_exit_codes: Annotated[Sequence[int], Doc("算作成功的退出码")] = (0,),
    save_output: Annotated[
        bool, Doc("保存完整输出：为 true 时把完整的标准输出和标准错误各保存为一个产物")
    ] = False,
) -> ShellOutputs:
    """执行一段命令，输出退出码、标准输出和标准错误。

    副作用：命令做什么，就有什么副作用。
    标准输出和标准错误实时转为任务日志。
    打开 save_output 时，完整的标准输出和标准错误各保存为一个产物。
    命令退出时还在运行的后台进程不会被终止。

    失败：退出码不在 ok_exit_codes 里时失败，错误信息是退出码、命令和标准错误的末尾。
    解释器或工作目录不存在时也失败。
    任务被取消或超时时，命令和它启动的全部子进程都会被终止。
    """
    _process.check_cwd(cwd)
    stdout = _Forward(ctx, sys.stdout.buffer, STDOUT_ARTIFACT if save_output else None)
    stderr = _Forward(ctx, sys.stderr.buffer, STDERR_ARTIFACT if save_output else None)
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
    stdout.start(proc.stdout)
    stderr.start(proc.stderr)
    try:
        # 取消或超时时这里抛出 Cancelled：平台已经向整棵进程树（执行器和命令在同一个进程组里）
        # 发了 SIGTERM，宽限期过后强制杀掉，节点不需要自己终止命令，让 Cancelled 继续往外传即可。
        returncode = proc.wait()
    finally:
        # 命令退出后，它启动的后台进程可能还持有输出管道：最多再转发 DRAIN_TIMEOUT 秒，
        # 之后的内容不进日志、输出和产物。
        deadline = time.monotonic() + DRAIN_TIMEOUT
        stdout.finish(deadline)
        stderr.finish(deadline)

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
        tail = stderr.last_lines(ERROR_TAIL_BYTES)
        raise CommandFailed(f"{message}\n\nstderr 末尾：\n{tail}" if tail else message)
    return {
        "exit_code": exit_code,
        "stdout": stdout.text(),
        "stderr": stderr.text(),
        "stdout_file": stdout.ref,
        "stderr_file": stderr.ref,
    }
