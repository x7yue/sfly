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

#: 行首的异常模块路径：小写字母、数字、下划线的名字加点，后面是首字母大写的异常类名，
#: 类名之后是冒号或行尾。
_MODULE_PATH = re.compile(r"^(?:[a-z_][a-z0-9_]*\.)+(?=[A-Z][A-Za-z0-9_.]*(?::|$))")
#: 堆栈的开头：异常信息之后接它，不算异常信息的下一行。
_TRACEBACK = "Traceback (most recent call last)"
_LINE_BREAK = re.compile(r"\r\n|\r|\n")


def split_error(message: str) -> tuple[str, list[str]]:
    """（失败原因的一行，没有并进这一行的各行原文）；没有错误信息时是 `("", [])`。"""
    lines = _LINE_BREAK.split(message.rstrip())
    at = next((i for i, line in enumerate(lines) if line.strip()), None)
    if at is None:
        return "", []
    headline = _MODULE_PATH.sub("", lines[at].strip())
    used = at + 1
    following = lines[used].strip() if used < len(lines) else ""
    if headline.endswith((":", "：")) and following and not following.startswith(_TRACEBACK):
        headline += following if headline.endswith("：") else f" {following}"
        used += 1
    return headline, lines[used:]


def error_headline(message: str) -> str:
    """失败原因的一行。"""
    return split_error(message)[0]
