"""等待类节点（`wait_port`、`wait_file`、`wait_log_line`）共用的轮询：每 `poll` 秒检查一次，
最多等 `wait` 秒，超时时抛出写明在等什么、等了多久的 `TimeoutError`。"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")

#: `wait` 的默认值（秒）。
DEFAULT_WAIT = 300.0
#: `poll` 的默认值（秒）。
DEFAULT_POLL = 1.0


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
