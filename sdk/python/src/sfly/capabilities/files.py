"""Agent 能力 files：`ctx.agent(...).files`。只用标准库（ADR 0002）。

`Files` 由各组操作拼成，每组在自己的模块里（`files_list.py`：列出、查看属性；
`files_read.py`：读取、下载；`files_write.py`：写入、上传、删除）。
加一组操作：新建模块，写一个以 `files_list.FilesBase` 为基类的类，加进 `Files` 的基类列表。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from sfly.capabilities.files_list import ListStat
from sfly.capabilities.files_read import ReadDownload
from sfly.capabilities.files_watch import Watch
from sfly.capabilities.files_write import WriteDelete

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


class Files(
    ListStat,
    ReadDownload,
    WriteDelete,
    Watch,
):
    """`ctx.agent(...).files`：一台 Agent 上的文件。路径都是那台 Agent 所在机器上的绝对路径，
    权限就是那台 Agent 进程的权限。

    - `list(directory, pattern="*", *, recursive=False, timeout=30.0)`：列出文件（迭代器）；
    - `stat(path, *, timeout=30.0)`：查看一个文件的属性；
    - `read(path, offset=0, length=None, *, timeout=30.0)`：流式读取（`bytes` 的迭代器）；
    - `download(path, local_path, *, timeout=30.0, progress=None)`：下载到本地路径；
    - `write(path, data, *, timeout=30.0)`：写入（先写临时文件再改名）；
    - `upload(local_path, path, *, timeout=30.0)`：把节点所在机器上的文件上传过去；
    - `delete(path, *, timeout=30.0)`：删除一个文件；
    - `watch(directory, pattern="*", *, recursive=False, timeout=30.0)`：监听目录（迭代器）。
    """

    def __init__(self, agent: Agent) -> None:
        self._agent = agent
