"""测试里等一个条件成立的共享写法（CODING_STANDARDS.md「测试」，#432）。

SDK 和 sfly-std 的测试都用它，不各写一份。

固定 sleep 再断言在慢机器上会偶发失败，在快机器上白等；这里每隔一小段时间看一次条件，成立就返回，
到了 `timeout` 还不成立就失败。`timeout` 只是上限，不是期望的耗时。
测试里的 `time.sleep` 被 ruff 拦着（TID251），这里是放行的那一处。
"""

from __future__ import annotations

import time
from collections.abc import Callable

INTERVAL = 0.01


def wait_for(check: Callable[[], object], timeout: float = 10.0, *, what: str = "条件成立") -> None:
    """每隔 INTERVAL 秒调一次 `check`，返回真值就结束；
    `timeout` 秒后还没有就以 AssertionError 失败，写明在等什么。"""
    deadline = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < deadline, f"等了 {timeout} 秒，还没等到{what}"
        time.sleep(INTERVAL)  # noqa: TID251 等待辅助本身要隔一段时间再看
