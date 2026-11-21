"""命令行选项里 `@文件`、`@-` 的写法：`sfly api --body`、`sfly debug --params` 共用同一个读取。

选项的值以 `@` 开头时，后面是来源：文件路径（`~` 展开，相对当前目录），或 `-`（标准输入）。
读不了时抛出 `OSError` 或 `UnicodeDecodeError`，各个命令按自己的错误格式写出原因。
"""

from __future__ import annotations

import sys
from pathlib import Path

#: `@-`：从标准输入读。
STDIN = "-"


def read_source(source: str) -> str:
    """`@<source>` 指的文本内容：文件（UTF-8），或标准输入（`source` 是 `-`）。"""
    if source == STDIN:
        return sys.stdin.read()
    return Path(source).expanduser().read_text(encoding="utf-8")
