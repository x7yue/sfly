"""从另一台 Agent 拉取文件（Agent 能力 files，ADR 0019）：拉取文件的节点共用。

- `local_path`：来源上的文件拉到本地目录下的哪里（保留子目录）；
- `download`：下载一个列出的文件，列出之后被删除时返回 None（跳过它）；
- `delete_pulled`：删除已经拉下来的源文件，下载之后它被改动或替换时不删；
- `listed`：输出里的本地路径列表，太多时截断。
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from pathlib import Path, PurePosixPath
from typing import Any, Literal

from sfly import Agent, AgentFileNotFound, FileInfo

#: 输出的本地路径列表最多列出多少个文件；更多时只列出前面的，文件数另有输出。
MAX_LISTED_FILES = 1000
#: 本地路径列表序列化后的最大字节数（节点输出不能超过 1 MB）。
LISTED_BYTES = 256 * 1024


def local_path(directory: str, path: str, root: Path) -> Path:
    """来源 Agent 上 `directory` 下的文件 `path` 拉到本地目录 `root` 下的哪里：
    保留它相对 `directory` 的子目录。"""
    try:
        relative = PurePosixPath(path).relative_to(PurePosixPath(directory))
    except ValueError:  # 不会发生：列出的文件都在 directory 下；保险起见只取文件名
        relative = PurePosixPath(PurePosixPath(path).name)
    return root.joinpath(*relative.parts)


def download(
    agent: Agent,
    file: FileInfo,
    target: Path,
    progress: Callable[[int, int], Any] | None = None,
) -> FileInfo | None:
    """把列出的文件 `file` 下载到 `target`（先写临时文件，完成后才改名，失败或被取消时
    不留半截文件），返回下载完成时源文件的属性。它在列出之后、下载完成之前被删除时返回 None；
    其它失败抛出异常。"""
    try:
        return agent.files.download(file.path, target, progress=progress)
    except AgentFileNotFound:
        # 也可能是本地这一侧的路径不存在（例如下载期间本地目录被删除）：只有源文件确实没了才跳过。
        try:
            agent.files.stat(file.path)
        except AgentFileNotFound:
            return None
        raise


Deleted = Literal["deleted", "gone", "changed"]


def delete_pulled(agent: Agent, pulled: FileInfo) -> Deleted:
    """删除已经下载下来的源文件 `pulled`（`download` 的返回值）。删除前再查看一次：
    它已经不在了时是 gone；下载之后被改动或替换了（例如日志轮转后路径上换成了新文件）时不删，
    是 changed。"""
    try:
        now = agent.files.stat(pulled.path)
    except AgentFileNotFound:
        return "gone"
    if (now.id, now.size, now.mtime_ns) != (pulled.id, pulled.size, pulled.mtime_ns):
        return "changed"
    try:
        agent.files.delete(pulled.path)
    except AgentFileNotFound:
        return "gone"
    return "deleted"


def listed(paths: Sequence[Path]) -> list[str]:
    """输出里的本地路径列表：最多 `MAX_LISTED_FILES` 个、序列化后最多 `LISTED_BYTES` 字节，
    超过时只保留前面的。"""
    result: list[str] = []
    size = 2  # []
    for path in paths[:MAX_LISTED_FILES]:
        text = str(path)
        size += len(json.dumps(text, ensure_ascii=False).encode()) + 2  # 逗号和空格
        if size > LISTED_BYTES:
            break
        result.append(text)
    return result
