"""写本地文件的公共部分：先写临时文件，写完再改名，下载中途出错不留下半个文件。"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO


@contextmanager
def part_file(target: Path) -> Iterator[BinaryIO]:
    """打开 `target` 旁边的 `<名称>.part` 写入；`with` 块正常结束后改名成 `target`，
    块里出错（或被打断）时删掉临时文件、不动 `target`。会创建缺少的父目录；
    写不了文件的 `OSError` 由调用方按自己的错误码处理。"""
    temp = target.with_name(f"{target.name}.part")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with temp.open("wb") as file:
            yield file
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
