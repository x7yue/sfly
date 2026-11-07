"""`stop_process`：终止后台进程所在的进程组，先 SIGTERM，宽限期后 SIGKILL。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `stop_process` 一节；
退出码取自 `start_process` 的看护进程写的状态文件（_supervise.py）。
"""

from __future__ import annotations

import os
import signal
from collections.abc import Callable
from typing import TypedDict

import psutil

from sfly import Context, node
from sfly_std import _process, _supervise
from sfly_std._waiting import poll_until

#: SIGKILL 之后等进程消失的最长时间（秒）。
KILL_WAIT = 5.0


class StopProcessOutputs(TypedDict):
    was_running: bool
    exit_code: int | None


class StopFailed(Exception):
    """SIGKILL 之后进程仍然没有退出。"""


def _members(pgid: int) -> list[int]:
    """进程组里还活着的进程（不含僵尸进程）。"""
    members = []
    for proc in psutil.process_iter():
        try:
            if os.getpgid(proc.pid) == pgid and _process.alive(proc):
                members.append(proc.pid)
        except ProcessLookupError:
            continue
    return members


@node(title="停止后台进程")
def stop_process(ctx: Context, pid: int | None = None, grace: float = 10) -> StopProcessOutputs:
    """终止 `pid` 所在的整个进程组：先发 SIGTERM，`grace` 秒（默认 10）后仍未退出的发 SIGKILL。

    进程已经不在（或 `pid` 为空，例如上游的 `start_process` 没有成功）时直接成功，
    适合放在 always 节点里清理。输出 `was_running`（开始时进程是否在运行）和 `exit_code`：
    进程由同一次运行里的 `start_process` 启动时能拿到它的退出码（被信号终止时为 128 + 信号值，
    被 SIGKILL 杀掉为 137），拿不到时为 null。
    """
    if pid is None:
        ctx.log.info("没有给出 pid，不需要停止")
        return {"was_running": False, "exit_code": None}
    if pid <= 0:
        raise ValueError(f"pid 必须是正整数，实际为 {pid}")
    status = _supervise.read_status(ctx.procs_dir, pid)
    was_running = _process.alive_pid(pid)
    try:
        pgid: int | None = os.getpgid(pid) if was_running else None
    except ProcessLookupError:
        was_running, pgid = False, None
    if pgid is None and status is not None:
        # 进程自己退出了，它在后台启动的进程可能还在同一个进程组里。
        pgid = status.pgid
    if pgid is not None and (pgid <= 1 or pgid == os.getpgrp()):
        pgid = None  # 不是独立的进程组（例如和执行器同组）：只终止这个进程

    def targets() -> list[int]:
        if pgid is not None:
            return _members(pgid)
        return [pid] if _process.alive_pid(pid) else []

    def send(sig: signal.Signals) -> None:
        try:
            if pgid is not None:
                os.killpg(pgid, sig)
            else:
                os.kill(pid, sig)
        except ProcessLookupError:
            pass

    killed = False
    if targets():
        what = f"进程组 {pgid}" if pgid is not None else f"进程 {pid}"
        ctx.log.info("向%s发送 SIGTERM，宽限期 %g 秒", what, grace)
        send(signal.SIGTERM)
        if not _wait_gone(targets, grace):
            ctx.log.warn("宽限期 %g 秒已过，%s仍未退出，发送 SIGKILL", grace, what)
            killed = was_running and _process.alive_pid(pid)
            send(signal.SIGKILL)
            if not _wait_gone(targets, KILL_WAIT):
                raise StopFailed(f"发送 SIGKILL 后 {KILL_WAIT:g} 秒，{what}仍未退出：{targets()}")
    elif not was_running:
        ctx.log.info("进程 %d 已不在运行", pid)

    # 进程刚退出时看护进程可能还没写下退出码。
    wait = _process.EXIT_CODE_WAIT if was_running and not killed else 0
    exit_code = _process.exit_code(ctx.procs_dir, pid, wait)
    if exit_code is None and killed:
        exit_code = 128 + signal.SIGKILL
    if was_running:
        ctx.log.info("进程 %d 已退出，退出码 %s", pid, exit_code)
    return {"was_running": was_running, "exit_code": exit_code}


def _wait_gone(targets: Callable[[], list[int]], timeout: float) -> bool:
    """最多等 `timeout` 秒，直到 `targets()` 为空；返回是否等到了。"""
    try:
        poll_until(
            lambda: True if not targets() else None,
            what="进程退出",
            wait=max(timeout, 0),
            poll=_process.POLL_INTERVAL,
        )
    except TimeoutError:
        return False
    return True
