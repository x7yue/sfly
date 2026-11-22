"""等待：轮询一个条件直到成立，以及等端口、等文件这两个最常用的条件。

- `poll_until`：每 `poll` 秒检查一次，最多等 `wait` 秒，超时时抛出写明在等什么、等了多久的
  `TimeoutError`；
- `wait_for_port`：等 TCP 端口可以连接；
- `wait_for_file`：等文件出现，可选再等它写完（大小和修改时间连续一段时间不变）。

等日志里出现某一行见 `sfly_std.logs.wait_for_log_line`。这些函数都是同步的，在等待期间任务被取消时，
`sfly.Cancelled` 从 `time.sleep` 里抛出，直接往外传，不用自己处理。
"""

from __future__ import annotations

import os
import socket
import stat
import time
from collections.abc import Callable
from typing import TypeVar

from sfly import Context
from sfly_std import _params

__all__ = [
    "DEFAULT_POLL",
    "DEFAULT_WAIT",
    "poll_until",
    "wait_for_file",
    "wait_for_port",
]

T = TypeVar("T")

#: `wait` 的默认值（秒）。
DEFAULT_WAIT = 300.0
#: `poll` 的默认值（秒）。
DEFAULT_POLL = 1.0
#: 单次连接尝试的最长时间（秒），不超过 `poll`。
CONNECT_TIMEOUT = 5.0


def validate(wait: float, poll: float) -> None:
    if wait < 0:
        raise ValueError(f"wait 不能为负数，实际为 {wait:g}")
    if poll <= 0:
        raise ValueError(f"poll 必须大于 0，实际为 {poll:g}")


def poll_until(
    check: Callable[[], T | None],
    *,
    what: str,
    wait: float,
    poll: float,
    detail: Callable[[], str] = lambda: "",
) -> tuple[T, float]:
    """反复调用 `check`，直到它返回非 None 的值；返回这个值和已等的秒数。

    `check` 立即执行一次，之后每 `poll` 秒一次，最后一次恰好在 `wait` 秒时。超时时抛出
    `TimeoutError: 等待<what>超时：已等 <wait> 秒`，后面接 `detail()`（例如最后一次检查的情况）。
    取消时 `Cancelled` 从 `time.sleep` 或 `check` 里抛出，直接往外传。
    `wait` 为负数或 `poll` 不大于 0 时抛出 `ValueError`。
    """
    validate(wait, poll)
    started = time.monotonic()
    deadline = started + wait
    while True:
        value = check()
        now = time.monotonic()
        if value is not None:
            return value, now - started
        if now >= deadline:
            extra = detail()
            raise TimeoutError(
                f"等待{what}超时：已等 {wait:g} 秒" + (f"，{extra}" if extra else "")
            )
        time.sleep(min(poll, deadline - now))


def wait_for_port(
    ctx: Context,
    port: int,
    *,
    host: str = "127.0.0.1",
    wait: float = DEFAULT_WAIT,
    poll: float = DEFAULT_POLL,
) -> float:
    """等一个 TCP 端口可以连接，用来等被测服务开始监听；返回等了多少秒。

    从执行节点的 Agent 所在的机器上连接 `host`:`port`（`host` 是主机名或 IP 地址）。超时时抛出
    `TimeoutError`，信息写明等的是哪个地址、等了多久和最后一次连接的错误；`port` 不在 1–65535
    之间时抛出 `ValueError`。端口能连上只说明进程在监听，不一定已经能处理请求：服务有健康检查
    接口时，自己用 `poll_until` 配 `httpx` 等它返回成功。
    """
    _params.port(port)
    target = f"{host}:{port}"
    last_error = ""

    def connect() -> bool | None:
        nonlocal last_error
        try:
            with socket.create_connection((host, port), timeout=min(CONNECT_TIMEOUT, poll)):
                return True
        except OSError as error:
            last_error = error.strerror or str(error) or type(error).__name__
            return None

    ctx.log.info("等待 %s 可以连接，最多 %g 秒", target, wait)
    _, waited = poll_until(
        connect,
        what=f"端口 {target} 可以连接",
        wait=wait,
        poll=poll,
        detail=lambda: f"最后一次连接：{last_error}" if last_error else "",
    )
    ctx.log.info("%s 已可以连接，等了 %.1f 秒", target, waited)
    return waited


def wait_for_file(
    ctx: Context,
    path: str,
    *,
    stable: float = 0,
    wait: float = DEFAULT_WAIT,
    poll: float = DEFAULT_POLL,
) -> int:
    """等一个文件出现，可以要求它保持若干秒不变（例如等对方把报告写完）；返回文件的大小（字节）。

    `stable` 秒内文件的大小和修改时间都没变才算写完；为 0 时出现就成功。只等普通文件：路径是
    目录时一直等到超时。相对路径相对于任务工作目录。

    超时时抛出 `TimeoutError`，信息写明当时的情况：「文件不存在」「路径存在但不是文件」或
    「文件仍在变化」；`stable` 为负数时抛出 `ValueError`。
    """
    if stable < 0:
        raise ValueError(f"stable 不能为负数，实际为 {stable:g}")
    # 上一次看到的 (大小, 修改时间) 和从什么时候起没再变过。
    last: tuple[int, int] | None = None
    unchanged_since = 0.0
    state = "文件不存在"

    def check() -> int | None:
        nonlocal last, unchanged_since, state
        try:
            st = os.stat(path)
        except FileNotFoundError:
            last, state = None, "文件不存在"
            return None
        if not stat.S_ISREG(st.st_mode):
            last, state = None, "路径存在但不是文件"
            return None
        now = time.monotonic()
        current = (st.st_size, st.st_mtime_ns)
        if current != last:
            last, unchanged_since = current, now
        if now - unchanged_since >= stable:
            return st.st_size
        state = "文件仍在变化"
        return None

    what = f"文件 {path} 出现" + (f"并稳定 {stable:g} 秒" if stable else "")
    ctx.log.info("等待%s，最多 %g 秒", what, wait)
    size, waited = poll_until(check, what=what, wait=wait, poll=poll, detail=lambda: state)
    ctx.log.info("文件 %s 已就绪（%d 字节），等了 %.1f 秒", path, size, waited)
    return size
