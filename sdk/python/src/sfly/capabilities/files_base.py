"""能力 files 各组操作共用的类型：文件属性、路径检查、列出范围和基类。只用标准库（ADR 0002）。

各组操作的模块（`files_list.py`、`files_read.py`、`files_write.py`、`files_watch.py`）
都只从这里导入共用的东西，`files.py` 把它们拼成 `Files`。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from fnmatch import fnmatchcase
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from sfly.capabilities import Agent


@dataclass(frozen=True)
class FileId:
    """文件标识：设备号 + inode。文件被改名后不变，删除后重建会变：
    用它判断「还是不是同一个文件」。"""

    device: int
    inode: int


@dataclass(frozen=True)
class FileInfo:
    """一台 Agent 上的一个文件的属性。

    - `path`：那台 Agent 所在机器上的绝对路径；
    - `size`：字节数；
    - `mtime_ns`：修改时间（Unix 纳秒），`mtime` 是同一时间的秒数（float）。
      这是那台机器的 Agent 时间，原样给出：和本机的 `time.time()` 比较时要考虑两台机器的时钟差；
    - `id`：文件标识（`FileId`）。
    """

    path: str
    size: int
    mtime_ns: int
    id: FileId

    @property
    def mtime(self) -> float:
        """修改时间（Unix 秒）。"""
        return self.mtime_ns / 1e9

    @classmethod
    def from_json(cls, data: Any) -> FileInfo:
        """Agent 回复里的文件属性：`{"path", "size", "mtime_ns", "device", "inode"}`。"""
        return cls(
            path=str(data["path"]),
            size=int(data["size"]),
            mtime_ns=int(data["mtime_ns"]),
            id=FileId(int(data["device"]), int(data["inode"])),
        )

    @classmethod
    def from_stat(cls, path: str, stat: os.stat_result) -> FileInfo:
        """本地调试时从 `os.stat` 的结果构造。"""
        return cls(
            path=path,
            size=stat.st_size,
            mtime_ns=stat.st_mtime_ns,
            id=FileId(stat.st_dev, stat.st_ino),
        )


def absolute(path: str | os.PathLike[str]) -> str:
    """那台 Agent 上的路径：必须是绝对路径。"""
    text = os.fspath(path)
    if not isinstance(text, str) or not text.startswith("/"):
        raise ValueError(f"路径必须是那台 Agent 所在机器上的绝对路径，收到 {text!r}")
    return text


@dataclass(frozen=True)
class Scope:
    """列出、监听的范围：目录 `directory` 下文件名匹配 `pattern` 的普通文件，
    `recursive` 时含子目录。"""

    directory: str
    pattern: str
    recursive: bool

    @classmethod
    def of(cls, directory: str | os.PathLike[str], pattern: str, recursive: bool) -> Scope:
        """检查参数：`directory` 是绝对路径；`pattern` 为空时是 `*`。"""
        return cls(absolute(directory), pattern or "*", recursive)

    def matches(self, name: str) -> bool:
        """文件名是否匹配（`fnmatch.fnmatchcase`，区分大小写）。"""
        return fnmatchcase(name, self.pattern)

    def args(self) -> dict[str, Any]:
        """调用 Agent 时的参数。"""
        return {"directory": self.directory, "pattern": self.pattern, "recursive": self.recursive}


class FilesBase:
    """`Files` 各组操作的共同基类：`_agent` 是这些文件所在的 Agent。"""

    _agent: Agent
