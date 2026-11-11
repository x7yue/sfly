"""Agent 能力 exec：`ctx.agent(...).exec`，在一台 Agent 上执行一条命令。只用标准库（ADR 0002）。

Agent 一侧见 agent/src/capabilities/exec.rs：Agent 把命令的输出按行切开、标上来自哪台
Agent，逐行回复（`{"stdout": "[Agent 名称] 一行"}`、`{"stderr": ...}`），这里写到执行器
自己的标准输出 / 标准错误，于是进入任务的日志；结果是 `{"exit_code": N}`。

本地调试时的实现（`_local_run`）规则与 Agent 相同：命令自成一个进程组（一棵进程树），
超时、任务被取消、命令退出后还剩下子进程时整体结束（先 SIGTERM，宽限期过后 SIGKILL）。
命令由看守进程（`exec_guard.py`）启动和结束：执行器被强制杀掉时也不留下孤儿。
"""

from __future__ import annotations

import json
import os
import sys
import time
from collections.abc import Mapping, Sequence
from typing import IO, TYPE_CHECKING, TextIO

from sfly.capabilities.errors import AgentError, AgentFileNotFound, AgentTimeout
from sfly.capabilities.files_base import absolute
from sfly.capabilities.local import LocalAgent
from sfly.context import DeferCancel

if TYPE_CHECKING:
    import subprocess

    from sfly.capabilities import Agent

#: Agent 超时后要结束进程树（最多一个宽限期，默认 10 秒）才回复，最晚在超时之后
#: 「宽限期 + 10 秒」回复；SDK 多等这么久才认为 Agent 自己卡住了。
_REPLY_MARGIN = 60.0

#: 本地调试时结束进程树的宽限期（秒）。
_LOCAL_GRACE = 5.0

#: 本地调试时，进程树结束后等仍持有输出管道的进程关闭管道的最长时间（秒）。
_DRAIN_TIMEOUT = 2.0

#: 一行最多多少字节，更长的行拆成多行（与 Agent 相同）。
_MAX_LINE = 64 * 1024


class Exec:
    """`ctx.agent(...).exec`：在一台 Agent 上执行命令。

    - `run(command, *, timeout, cwd=None, env=None)`：执行一条命令，返回退出码。
    """

    def __init__(self, agent: Agent) -> None:
        self._agent = agent

    def run(
        self,
        command: str | Sequence[str],
        *,
        timeout: float,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
    ) -> int:
        """在那台 Agent 上执行 `command`，等它结束，返回退出码（被信号终止时为 128 + 信号值）。

        - `command` 是字符串时用 `/bin/sh -c` 执行；是字符串列表时第一项是程序，其余是参数，
          不经过 shell；
        - 命令的标准输出、标准错误逐行进入这个任务的日志，每行前面标上来自哪台 Agent
          （`[Agent a-01] ...`）；
        - `timeout`（秒）必须给：命令最多运行多久。超过时命令连同它启动的子进程一起被结束，
          抛出 `sfly.AgentTimeout`；
        - 这个任务被取消、被停止或结束时，命令连同它的子进程一起被结束；两台 Agent 之间的
          连接断开时也一样；
        - 命令退出后，它留在后台的子进程也被结束：常驻进程不要这样启动，把 `start_process`
          节点派到那台机器上；
        - `cwd`：工作目录，那台机器上的绝对路径，默认 `/`；`env`：在那台 Agent 进程的
          环境变量之上追加的环境变量。

        找不到程序、工作目录不存在时抛出 `sfly.AgentFileNotFound`，没有权限执行时抛出
        `sfly.AgentPermissionDenied`。命令以非 0 退出码结束不是异常，由调用方检查返回值。
        """
        argv = _argv(command)
        if timeout is None:
            raise ValueError("exec.run 必须给超时（秒）：命令最多运行多久，不能传 None")
        self._agent._check_timeout(timeout)
        directory = absolute(cwd) if cwd is not None else None
        extra = _env(env)
        local = self._agent._local()
        if local is not None:
            return _local_run(local, argv, directory, extra, timeout)
        args = {"argv": argv, "cwd": directory or "", "env": extra}
        with self._agent._call("exec.run", args, timeout, margin=_REPLY_MARGIN) as call:
            for frame in call.frames():
                item = frame.get("item")
                if isinstance(item, dict):
                    for key, stream in (("stdout", sys.stdout), ("stderr", sys.stderr)):
                        if isinstance(item.get(key), str):
                            _echo(stream, item[key])
                elif "result" in frame:
                    return int(frame["result"]["exit_code"])
        raise AgentError("exec.run 没有收到退出码", agent=self._agent.name)


def _argv(command: str | Sequence[str]) -> list[str]:
    """要执行的程序和参数：字符串用 `/bin/sh -c` 执行。"""
    if isinstance(command, str):
        return ["/bin/sh", "-c", command]
    if isinstance(command, (bytes, bytearray)) or not isinstance(command, Sequence):
        raise TypeError(
            f"command 必须是字符串（用 /bin/sh -c 执行）或字符串列表，收到 {type(command).__name__}"
        )
    argv = [os.fspath(part) for part in command]
    if not argv or not argv[0]:
        raise ValueError("command 是空的：列表的第一项是要执行的程序")
    if not all(isinstance(part, str) for part in argv):
        raise TypeError("command 列表里的每一项都必须是字符串")
    return argv


def _env(env: Mapping[str, str] | None) -> dict[str, str]:
    if env is None:
        return {}
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        raise TypeError("env 的键和值都必须是字符串")
    return dict(env)


def _echo(stream: TextIO, text: str) -> None:
    """把一行写到执行器的标准输出 / 标准错误（Agent 把它们转成任务的日志）。"""
    buffer = getattr(stream, "buffer", None)
    if buffer is None:
        stream.write(text + "\n")
        stream.flush()
        return
    stream.flush()
    buffer.write(text.encode("utf-8", errors="replace") + b"\n")
    buffer.flush()


def _local_run(
    local: LocalAgent, argv: list[str], cwd: str | None, env: dict[str, str], timeout: float
) -> int:
    """本地调试时在本机执行。映射到本地目录的 Agent：工作目录落在映射的目录里，
    命令里写的路径不换算。"""
    # 用到时才导入：subprocess 会导入 threading，不放在每个任务的启动路径上（#76）。
    import subprocess
    import threading

    shown = cwd or "/"
    directory = local.real(shown)
    if not os.path.isdir(directory):
        if os.path.exists(directory):
            raise local.invalid(f"工作目录 {shown} 不是目录")
        raise AgentFileNotFound(f"{local.label}：工作目录 {shown} 不存在", agent=local.name)
    status_out = status_in = -1
    guard: subprocess.Popen[bytes] | None = None
    readers: list[threading.Thread] = []
    try:
        # 管道和看守进程一建出来就归下面的 finally 管：取消不会落在建出来和进入 try 之间。
        # 执行器在这之前就退出了也不要紧：看守进程的标准输入随之关闭，它照样结束命令。
        with DeferCancel():
            status_out, status_in = os.pipe()
            try:
                guard = subprocess.Popen(
                    [sys.executable, "-I", "-S", _GUARD, str(_LOCAL_GRACE), str(status_in)] + argv,
                    cwd=directory,
                    env={**os.environ, **env},
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    pass_fds=(status_in,),
                    start_new_session=True,
                )
            except FileNotFoundError:
                # 看守进程（Python）总在：找不到的是工作目录（检查之后被删除了）。
                message = f"{local.label}：工作目录 {shown} 不存在"
                raise AgentFileNotFound(message, agent=local.name) from None
        tag = f"[{local.label}] "
        readers = [
            threading.Thread(target=_pump, args=(pipe, tag, stream), daemon=True)
            for pipe, stream in ((guard.stdout, sys.stdout), (guard.stderr, sys.stderr))
        ]
        for reader in readers:
            reader.start()
        try:
            guard.wait(timeout)
        except subprocess.TimeoutExpired:
            _end(guard)
            raise AgentTimeout(
                f"{local.label}：命令超过 {timeout:g} 秒没有结束，已结束它的进程树",
                agent=local.name,
            ) from None
    finally:
        # 正常退出后剩下的子进程、被取消（sfly.Cancelled）时的整棵树：看守进程结束它们。
        if guard is not None:
            _end(guard)
        if status_in >= 0:
            os.close(status_in)
        status = _read_status(status_out) if status_out >= 0 else {}
        deadline = time.monotonic() + _DRAIN_TIMEOUT
        for reader in readers:
            reader.join(max(0.0, deadline - time.monotonic()))
    if "exit" in status:
        returncode = int(str(status["exit"]))
        return returncode if returncode >= 0 else 128 - returncode
    program = argv[0]
    raise local.error(
        _status_error(status),
        program,
        missing=f"找不到程序 {program}",
        denied=f"没有权限执行 {program}",
    )


#: 看守进程的脚本。
_GUARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "exec_guard.py")


def _end(guard: subprocess.Popen[bytes]) -> None:
    """让看守进程结束命令的进程树（关掉它的标准输入），等它退出。"""
    if guard.stdin is not None and not guard.stdin.closed:
        guard.stdin.close()
    guard.wait()


def _read_status(fd: int) -> dict[str, object]:
    """读看守进程报告的结果（见 `exec_guard.py`），读完关闭。看守进程没有报告时为空。"""
    with os.fdopen(fd, "rb") as f:
        line = f.readline()
    try:
        status = json.loads(line)
    except ValueError:
        return {}
    return status if isinstance(status, dict) else {}


def _status_error(status: Mapping[str, object]) -> OSError:
    """看守进程启动命令失败的原因，转成对应的 OSError（再由 `LocalAgent.error` 转换）。"""
    kind, message = status.get("error"), str(status.get("message", "看守进程没有报告结果"))
    if kind == "not_found":
        return FileNotFoundError(message)
    if kind == "permission_denied":
        return PermissionError(message)
    return OSError(message)


def _pump(pipe: IO[bytes], tag: str, stream: TextIO) -> None:
    """逐行把命令的输出写到执行器的标准输出 / 标准错误，每行前面标上 `tag`。"""
    with pipe:
        while raw := pipe.readline(_MAX_LINE):
            line = raw[:-1] if raw.endswith(b"\n") else raw
            if line.endswith(b"\r"):
                line = line[:-1]
            _echo(stream, tag + line.decode("utf-8", errors="replace"))
