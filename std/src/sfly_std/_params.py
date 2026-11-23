"""多个节点共用的参数校验：写法不对时抛出 ValueError，错误信息写明参数名和实际的值。"""

from __future__ import annotations

import re
from collections.abc import Sequence


def port(value: int) -> None:
    """TCP 端口号必须在 1–65535 之间。"""
    if not 1 <= value <= 65535:
        raise ValueError(f"port 必须在 1–65535 之间，实际为 {value}")


def seconds(name: str, value: float | None) -> None:
    """表示秒数的参数不能是布尔值：`True` 是 1，写成 `refind_within=True` 不会报错，被当成 1 秒。"""
    if isinstance(value, bool):
        raise ValueError(f"{name} 是秒数，不能是布尔值 {value!r}")


def choice(name: str, value: str, allowed: Sequence[str]) -> None:
    """取值只能是 `allowed` 里的一个（`Literal` 类型的参数）：写错时报错，不当成某个默认的取值。"""
    if value not in allowed:
        listed = " 或 ".join(f'"{a}"' for a in allowed)
        raise ValueError(f"{name} 只能是 {listed}，实际为 {value!r}")


def wait_and_poll(wait: float, poll: float) -> None:
    """等待的时长不能为负，轮询间隔必须大于 0。"""
    seconds("wait", wait)
    seconds("poll", poll)
    if wait < 0:
        raise ValueError(f"wait 不能为负数，实际为 {wait:g}")
    if poll <= 0:
        raise ValueError(f"poll 必须大于 0，实际为 {poll:g}")


def regex(param: str, pattern: str, flags: int = 0) -> re.Pattern[str]:
    """编译参数 `param`（例如 `match`、`fail_on 第 2 条`）里的正则表达式；
    不合法时的错误信息写明参数、正则和原因。"""
    try:
        return re.compile(pattern, flags)
    except re.error as error:
        space = " " if param[-1].isascii() else ""  # 「match 不是」「fail_on 第 2 条不是」
        raise ValueError(f"{param}{space}不是合法的正则表达式：{pattern!r}（{error}）") from None
