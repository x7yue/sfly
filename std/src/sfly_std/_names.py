"""一个节点里多次调用辅助函数时，默认的文件名和产物名不互相覆盖。

第一次调用用原来的名字（`stdout.txt`、`<节点 ID>.log`），之后依次是 `stdout-2.txt`、
`stdout-3.txt`……：认领一个名字就是把这个文件创建出来（`O_EXCL`），已经存在的跳过。
调用方自己指定名字时不经过这里，指定的名字直接用（同名的已有文件被覆盖）。
"""

from __future__ import annotations

import posixpath
from collections.abc import Callable
from pathlib import Path


def claim(path_of: Callable[[str], Path], name: str) -> str:
    """在 `name`、`name-2`、`name-3`…里认领第一个还不存在的名字（创建一个空文件），返回它。

    `path_of(名字)` 给出名字对应的文件路径（父目录要已经存在）；`-<序号>` 加在扩展名之前。
    """
    suffix = posixpath.splitext(name)[1]
    stem = name[: len(name) - len(suffix)]
    number = 1
    while True:
        candidate = name if number == 1 else f"{stem}-{number}{suffix}"
        try:
            with path_of(candidate).open("xb"):
                pass
        except FileExistsError:
            number += 1
            continue
        return candidate
