"""涉及进程的函数（`run_command`、`start_background_process`、`stop_background_process`、
`monitor_processes`）共用的工具：启动命令的参数、判断进程是否还活着、读看护进程记下的退出码。
按 pid / 进程名 / 命令行找进程在 `_finder.py`（`find_processes` 用它）。"""

from __future__ import annotations

import os

import psutil

from sfly_std import _supervise
from sfly_std.waiting import poll_until

#: 日志和错误信息里命令、命令行的最大字符数。
PREVIEW_CHARS = 200
#: 进程刚退出时，等看护进程写下退出码的最长时间（秒）。
EXIT_CODE_WAIT = 2.0
#: 检查进程状态的间隔（秒）。
POLL_INTERVAL = 0.1


def preview(text: str) -> str:
    """日志和错误信息里展示的命令：超过 PREVIEW_CHARS 个字符时截断，加上 `…`。"""
    return text[:PREVIEW_CHARS] + "…" if len(text) > PREVIEW_CHARS else text


# ---- 启动命令（shell、start_process）----


def check_cwd(cwd: str | os.PathLike[str] | None) -> None:
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


def exit_status(
    procs_dir: str | os.PathLike[str], pid: int, wait: float
) -> _supervise.Status | None:
    """`start_process` 的看护进程记下的状态；不是它启动的进程（没有记录）时为 None。

    还没有退出码的（还在运行）最多等 `wait` 秒：进程刚退出时看护进程可能还没写下退出码；等不到时
    返回最后一次读到的状态（`exit_code` 为 None）。
    """
    last: _supervise.Status | None = None

    def check() -> tuple[None] | None:
        nonlocal last
        last = _supervise.read_status(procs_dir, pid)
        return (None,) if last is None or last.exit_code is not None else None

    try:
        poll_until(check, what="退出码", wait=wait, poll=POLL_INTERVAL)
    except TimeoutError:
        pass
    return last


def exit_code(procs_dir: str | os.PathLike[str], pid: int, wait: float) -> int | None:
    """看护进程记下的退出码；不是它启动的进程、或还没退出时为 None（见 `exit_status`）。"""
    status = exit_status(procs_dir, pid, wait)
    return status.exit_code if status is not None else None
