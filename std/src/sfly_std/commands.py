"""执行命令：用解释器（默认 `/bin/sh`）执行一段命令，实时转成任务日志，保留输出的末尾，
可选保存完整输出为产物。

`run_command` 是 `shell` 节点的全部逻辑：自己的业务节点里要跑脚本、调用被测系统的命令行时直接用它，
不用再写一遍「读两条管道、不丢输出、取消时终止整棵进程树、失败时带上 stderr 的末尾」。
同一个节点里可以调用多次：保存完整输出时每次调用用不同的产物名，不互相覆盖。
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import IO

from sfly import Context
from sfly_std import _names, _process

__all__ = ["CommandFailed", "CommandResult", "run_command"]

#: 输出里保留的 stdout、stderr 末尾字节数。
OUTPUT_TAIL_BYTES = 64 * 1024
#: 失败信息里附带的 stderr 末尾字节数（从完整的一行开始）。
ERROR_TAIL_BYTES = 4 * 1024
#: 打开 `save_output` 时保存完整 stdout、stderr 的产物的默认名称：同一个节点里第二次起依次是
#: `stdout-2.txt`、`stdout-3.txt`……（`stderr` 同理）。
STDOUT_ARTIFACT = "stdout.txt"
STDERR_ARTIFACT = "stderr.txt"
#: 命令退出后，等待仍持有输出管道的后台进程关闭管道的最长时间（秒）。
DRAIN_TIMEOUT = 2.0


class CommandFailed(Exception):
    """命令的退出码不在 `ok_exit_codes` 中。"""


@dataclass(frozen=True)
class CommandResult:
    """`run_command` 的结果。"""

    #: 退出码；命令被信号终止时为 128 + 信号值（与 shell 的 `$?` 相同）。
    exit_code: int
    #: 标准输出的最后 64 KiB。
    stdout: str
    #: 标准错误的最后 64 KiB。
    stderr: str
    #: 保存下来的完整标准输出的产物引用（下载地址，可以交给后面的节点下载；不是本地路径，
    #: 本地调试时恰好是路径，上了 Agent 就不是）；`save_output` 为 False 时是 None。
    stdout_ref: str | None
    #: 保存下来的完整标准错误的产物引用；`save_output` 为 False 时是 None。
    stderr_ref: str | None
    #: 完整标准输出实际保存成的产物名称（`ctx.artifacts.path(它)` 是本地文件）；
    #: `save_output` 为 False 时是 None。
    stdout_artifact: str | None = None
    #: 完整标准错误实际保存成的产物名称；`save_output` 为 False 时是 None。
    stderr_artifact: str | None = None


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


def run_command(
    ctx: Context,
    command: str,
    *,
    shell: str = "/bin/sh",
    env: dict[str, str] | None = None,
    cwd: str | os.PathLike[str] | None = None,
    ok_exit_codes: Sequence[int] = (0,),
    save_output: bool = False,
    stdout_artifact: str | None = None,
    stderr_artifact: str | None = None,
) -> CommandResult:
    """执行一段命令，返回退出码、标准输出和标准错误的末尾。

    `shell` 是任何能用 `-c` 执行一段命令的程序（`/bin/bash`、`python3` 等）；`env` 追加在执行器的
    环境变量之上；`cwd` 必须已经存在。标准输出和标准错误实时转为任务日志；`save_output` 为 True 时
    完整的输出各保存为一个产物（`stdout_ref`、`stderr_ref` 是产物引用，可以交给后面的节点下载）。
    产物名称默认每次调用不同：第一次是 `stdout.txt`、`stderr.txt`，同一个节点里再调用依次是
    `stdout-2.txt`、`stdout-3.txt`……，前一次的输出不会被覆盖；用 `stdout_artifact`、
    `stderr_artifact` 自己指定名称时直接用这个名称（同名的已有产物被覆盖）。实际用的名称在返回值的
    `stdout_artifact`、`stderr_artifact` 里。命令退出时还在运行的后台进程不会被终止。

    退出码不在 `ok_exit_codes` 里时抛出 `CommandFailed`，信息是退出码、命令和标准错误的末尾；
    解释器不存在抛出 `FileNotFoundError`（`start_background_process` 在同样的情况下抛出的是
    `StartFailed`，两个函数不同），`cwd` 不存在抛出 `NotADirectoryError`；没有打开 `save_output`
    却给了 `stdout_artifact` 或 `stderr_artifact`、给的产物名称不合法、两个名称相同时抛出
    `ValueError`（命令启动之前就检查，不会先跑起命令再报错）。
    任务被取消或超时时，命令和它启动的全部子进程都由平台终止（它们和执行器在同一个进程组里），
    `sfly.Cancelled` 照常往外传，不用自己终止命令。
    """
    _process.check_cwd(cwd)
    if not save_output and (stdout_artifact is not None or stderr_artifact is not None):
        raise ValueError("给了 stdout_artifact 或 stderr_artifact 时要同时打开 save_output")
    # 自己给的产物名称在命令启动之前就检查：不合法时不能先跑起命令再报错。
    for given in (stdout_artifact, stderr_artifact):
        if given is not None:
            ctx.artifacts.ref(given)
    if stdout_artifact is not None and stdout_artifact == stderr_artifact:
        raise ValueError(f"stdout_artifact 和 stderr_artifact 不能是同一个产物：{stdout_artifact}")
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
    # 命令启动之后才认领产物名称：命令没能启动时不留下空的产物。
    out_name = err_name = None
    if save_output:
        out_name = (
            stdout_artifact
            if stdout_artifact is not None
            else _names.claim(ctx.artifacts.path, STDOUT_ARTIFACT)
        )
        err_name = (
            stderr_artifact
            if stderr_artifact is not None
            else _names.claim(ctx.artifacts.path, STDERR_ARTIFACT)
        )
    stdout = _Forward(ctx, sys.stdout.buffer, out_name)
    stderr = _Forward(ctx, sys.stderr.buffer, err_name)
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
    return CommandResult(
        exit_code=exit_code,
        stdout=stdout.text(),
        stderr=stderr.text(),
        stdout_ref=stdout.ref,
        stderr_ref=stderr.ref,
        stdout_artifact=out_name,
        stderr_artifact=err_name,
    )
