"""Agent 能力 files：`ctx.agent(...).files`。只用标准库（ADR 0002）。

`Files` 由各组操作拼成，每组在自己的模块里（`files_list.py`：列出、查看属性；
`files_read.py`：读取、下载；`files_write.py`：写入、上传、删除；`files_watch.py`：监听）。
共用的类型（`FileInfo` 等）在 `files_base.py`，各组的模块只从那里导入。
加一组操作：新建模块，写一个以 `files_base.FilesBase` 为基类的类，加进 `Files` 的基类列表。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sfly.capabilities.files_base import FileId, FileInfo, absolute
from sfly.capabilities.files_list import ListStat
from sfly.capabilities.files_read import ReadDownload
from sfly.capabilities.files_watch import Watch
from sfly.capabilities.files_write import WriteDelete

if TYPE_CHECKING:
    from sfly.capabilities import Agent

__all__ = ["FileId", "FileInfo", "Files", "absolute"]


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
