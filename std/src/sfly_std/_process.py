"""涉及进程的节点（`shell`、`start_process`、`stop_process`、`process_assert`、`process_monitor`）
共用的工具：启动命令的参数、按 pid / 进程名 / 命令行找进程、判断进程是否还活着、
读看护进程记下的退出码。"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, TypeVar

import psutil

from sfly_std import _params, _supervise
from sfly_std._waiting import poll_until

#: 日志和错误信息里命令、命令行的最大字符数。
PREVIEW_CHARS = 200
#: 进程刚退出时，等看护进程写下退出码的最长时间（秒）。
EXIT_CODE_WAIT = 2.0
#: 检查进程状态的间隔（秒）。
POLL_INTERVAL = 0.1

T = TypeVar("T", int, str)


def preview(text: str) -> str:
    """日志和错误信息里展示的命令：超过 PREVIEW_CHARS 个字符时截断，加上 `…`。"""
    return text[:PREVIEW_CHARS] + "…" if len(text) > PREVIEW_CHARS else text


# ---- 启动命令（shell、start_process）----


def check_cwd(cwd: str | None) -> None:
    """`cwd` 给出时必须是已有的目录。"""
    if cwd is not None and not os.path.isdir(cwd):
        raise NotADirectoryError(f"工作目录不存在：{cwd}")


def child_env(env: dict[str, str] | None) -> dict[str, str] | None:
    """子进程的环境变量：在执行器的环境变量之上追加 `env`；不需要追加时为 None（继承）。"""
    return {**os.environ, **env} if env else None


# ---- 进程状态 ----


def alive(proc: psutil.Process) -> bool:
    """进程还在且不是僵尸进程（已退出、还没被回收；`os.kill(pid, 0)` 对它也成功）。"""
    try:
        return proc.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def alive_pid(pid: int) -> bool:
    """进程号为 `pid` 的进程还在且不是僵尸进程。"""
    try:
        return alive(psutil.Process(pid))
    except psutil.NoSuchProcess:
        return False


def cmdline(proc: psutil.Process) -> str:
    """命令行（各参数以空格连接）；读不到（别的用户的进程）时为空。"""
    try:
        return " ".join(proc.cmdline())
    except psutil.AccessDenied:
        return ""


def exit_code(procs_dir: str | os.PathLike[str], pid: int, wait: float) -> int | None:
    """`start_process` 的看护进程记下的退出码；不是它启动的进程、或还没退出时为 None。

    进程刚退出时看护进程可能还没写下退出码：最多等 `wait` 秒。
    """

    def check() -> tuple[int | None] | None:
        status = _supervise.read_status(procs_dir, pid)
        if status is None or status.exit_code is not None:
            return (status.exit_code if status is not None else None,)
        return None

    try:
        (code,), _ = poll_until(check, what="退出码", wait=wait, poll=POLL_INTERVAL)
    except TimeoutError:
        return None
    return code


# ---- 按 pid / 进程名 / 命令行找进程（process_assert、process_monitor）----


@dataclass(frozen=True)
class Target:
    """一个找进程的条件：`pid`（进程号）、`name`（进程名，完全相同）
    或 `match`（命令行正则，部分匹配）。"""

    kind: Literal["pid", "name", "match"]
    pid: int = 0
    text: str = ""
    pattern: re.Pattern[str] | None = None

    @property
    def label(self) -> str:
        """日志和错误信息里的写法，例如 `pid 123`、`name "nginx"`、`match "server\\.py"`。"""
        if self.kind == "pid":
            return f"pid {self.pid}"
        return f"{self.kind} {json.dumps(self.text, ensure_ascii=False)}"

    def matches(self, proc: psutil.Process, name: str, command: str) -> bool:
        """进程 `proc`（进程名 `name`、命令行 `command`）是否满足这个条件。"""
        if self.kind == "pid":
            return proc.pid == self.pid
        if self.kind == "name":
            return name == self.text
        assert self.pattern is not None
        return self.pattern.search(command) is not None


def targets(
    pid: int | Sequence[int] | None,
    name: str | Sequence[str] | None,
    match: str | Sequence[str] | None,
) -> list[Target]:
    """把 `pid`、`name`、`match` 参数（单个值或列表）变成条件，按这个顺序；
    写法不对时抛出 ValueError。"""
    pids, names, patterns = as_list(pid), as_list(name), as_list(match)
    if not (pids or names or patterns):
        raise ValueError("至少要给出 pid、name、match 中的一个")
    for p in pids:
        if p <= 0:
            raise ValueError(f"pid 必须是正整数，实际为 {p}")
    return (
        [Target("pid", pid=p) for p in pids]
        + [Target("name", text=n) for n in names]
        + [Target("match", text=m, pattern=_params.regex("match", m)) for m in patterns]
    )


def as_list(value: T | Sequence[T] | None) -> list[T]:
    """单个值或列表（JSON 数组）统一成列表。"""
    if value is None:
        return []
    if isinstance(value, (int, str)):
        return [value]
    return list(value)
