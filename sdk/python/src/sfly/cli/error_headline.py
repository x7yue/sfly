"""失败原因的一行：任务错误信息的摘要，命令行摘要里「错误：…」那一行用它。

规则与网页、控制面一致（`packages/schema/src/run-failures.ts` 的 `errorHeadline`），两边共用用例表
`testdata/error-headline-cases.json`：

- 取错误信息里第一行有内容的文字，去掉首尾空白；
- 行首是异常的模块路径（`sfly_std.assert_.AssertionFailed: x`）时去掉它，取 `AssertionFailed: x`；
- 这一行以冒号（半角 `:` 或全角 `：`）结尾、下一行紧接着有内容（不是空行，也不是堆栈的开头）时，
  把下一行接上去：全角冒号后直接接，半角冒号后隔一个空格，只接一行。

只管这一行摘要：完整的错误信息原样保留（`--json` 里是原文），没有并进摘要的各行照旧显示在它下面。
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

#: 行首的异常模块路径：小写字母、数字、下划线的名字加点，后面是首字母大写的异常类名，
#: 类名之后是冒号或行尾。
_MODULE_PATH = re.compile(r"^(?:[a-z_][a-z0-9_]*\.)+(?=[A-Z][A-Za-z0-9_.]*(?::|$))")
#: 堆栈的开头：异常信息之后接它，不算异常信息的下一行。
_TRACEBACK = "Traceback (most recent call last)"
_LINE_BREAK = re.compile(r"\r\n|\r|\n")
#: 去掉首尾的空白，BOM 也算：和 JS 的 `trim()` 一致（Python 的 `strip()` 不去 BOM）。
_TRIM = re.compile(r"^[\s\ufeff]+|[\s\ufeff]+$")


def _trim(text: str) -> str:
    return _TRIM.sub("", text)


def split_error(message: str) -> tuple[str, list[str]]:
    """（失败原因的一行，没有并进这一行的各行原文）；没有错误信息时是 `("", [])`。"""
    lines = _LINE_BREAK.split(message.rstrip())
    at = next((i for i, line in enumerate(lines) if _trim(line)), None)
    if at is None:
        return "", []
    headline = _MODULE_PATH.sub("", _trim(lines[at]))
    used = at + 1
    following = _trim(lines[used]) if used < len(lines) else ""
    if headline.endswith((":", "：")) and following and not following.startswith(_TRACEBACK):
        headline += following if headline.endswith("：") else f" {following}"
        used += 1
    return headline, lines[used:]


def error_headline(message: str) -> str:
    """失败原因的一行。"""
    return split_error(message)[0]


def error_location(error: Mapping[str, Any]) -> str | None:
    """错误里节点失败时出错的位置（`error.location`，「模块.函数 第 N 行」）。

    旧版本的控制面没有这个键，升级之前的任务、不是节点自己出错的失败是 null：都是 None。
    """
    location = error.get("location")
    return location if isinstance(location, str) and location else None


def location_line(location: str) -> str:
    """出错位置写在文本里的样子。"""
    return f"出错位置：{location}"


def with_location(message_lines: list[str], location: str | None) -> list[str]:
    """错误信息的各行里加上出错位置：放在失败原因的各行之后、堆栈之前（没有堆栈时放在末尾）。

    `sfly run show` 这样的地方整段错误信息都打出来，位置不能埋在堆栈后面。
    """
    if location is None:
        return message_lines
    at = next(
        (i for i, line in enumerate(message_lines) if _trim(line).startswith(_TRACEBACK)),
        len(message_lines),
    )
    # 失败原因和堆栈之间的空行留在位置的后面，位置紧接着失败原因。
    while at > 0 and not _trim(message_lines[at - 1]):
        at -= 1
    return [*message_lines[:at], location_line(location), *message_lines[at:]]
