"""多个节点共用的参数校验：写法不对时抛出 ValueError，错误信息写明参数名和实际的值。"""

from __future__ import annotations

import re


def port(value: int) -> None:
    """TCP 端口号必须在 1–65535 之间。"""
    if not 1 <= value <= 65535:
        raise ValueError(f"port 必须在 1–65535 之间，实际为 {value}")


def regex(param: str, pattern: str, flags: int = 0) -> re.Pattern[str]:
    """编译参数 `param`（例如 `match`、`fail_on 第 2 条`）里的正则表达式；
    不合法时的错误信息写明参数、正则和原因。"""
    try:
        return re.compile(pattern, flags)
    except re.error as error:
        space = " " if param[-1].isascii() else ""  # 「match 不是」「fail_on 第 2 条不是」
        raise ValueError(f"{param}{space}不是合法的正则表达式：{pattern!r}（{error}）") from None
