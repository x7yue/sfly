"""`files.list`、`files.stat`：列出文件、查看文件属性。只用标准库（ADR 0002）。

Agent 一侧见 agent/src/capabilities/files.rs，本地调试时的实现（`_local_list`）规则与它相同。
"""

from __future__ import annotations

import os
from collections.abc import Generator, Iterator
from typing import TYPE_CHECKING

from sfly.capabilities.channel import DEFAULT_TIMEOUT

if TYPE_CHECKING:
    from sfly.capabilities import Agent
    from sfly.capabilities.files import FileInfo
    from sfly.capabilities.local import LocalAgent


class FilesBase:
    """`Files` 各组操作的共同基类：`_agent` 是这些文件所在的 Agent。"""

    _agent: Agent


class ListStat(FilesBase):
    def list(
        self,
        directory: str | os.PathLike[str],
        pattern: str = "*",
        *,
        recursive: bool = False,
        timeout: float | None = DEFAULT_TIMEOUT,
    ) -> Generator[FileInfo, None, None]:
        """列出目录 `directory` 下文件名匹配 `pattern` 的普通文件（跟随符号链接判断），
        逐个给出 `FileInfo`。

        - `pattern` 只匹配文件名（不含目录），与 `fnmatch.fnmatchcase` 相同：`*`、`?`、
          `[a-z]`、`[!0-9]`，区分大小写，`*` 也匹配以 `.` 开头的名字；
        - `recursive=True` 时进入子目录（不进入指向目录的符号链接）。顺序：同一个目录里的文件
          按名称排序，先给出目录里的文件，再按名称依次进入子目录；
        - 列出期间被删除的文件、没有权限进入的子目录跳过；
        - `timeout`：等对方回应的上限（秒），这里是到第一项、以及相邻两项之间各自最多等多久；
          None 为不限。

        迭代时才发起调用：`directory` 不存在、不是目录或没有权限时，迭代时抛出异常
        （见 `sfly.AgentError`）。中途停止迭代（或 `close()`）时调用随之放弃。
        """
        from sfly.capabilities.files import absolute

        path = absolute(directory)
        self._agent._check_timeout(timeout)
        return self._list(path, pattern or "*", recursive, timeout)

    def _list(
        self, path: str, pattern: str, recursive: bool, timeout: float | None
    ) -> Generator[FileInfo, None, None]:
        from sfly.capabilities.files import FileInfo

        local = self._agent._local()
        if local is not None:
            yield from _local_list(local, path, pattern, recursive)
            return
        args = {"directory": path, "pattern": pattern, "recursive": recursive}
        with self._agent._call("files.list", args, timeout) as call:
            for item in call.items():
                yield FileInfo.from_json(item)

    def stat(
        self, path: str | os.PathLike[str], *, timeout: float | None = DEFAULT_TIMEOUT
    ) -> FileInfo:
        """查看一个文件（或目录）的属性（跟随符号链接）。
        文件不存在时抛出 `sfly.AgentFileNotFound`。"""
        from sfly.capabilities.files import FileInfo, absolute

        text = absolute(path)
        self._agent._check_timeout(timeout)
        local = self._agent._local()
        if local is not None:
            try:
                return FileInfo.from_stat(text, os.stat(local.real(text)))
            except OSError as error:
                raise local.error(error, text) from None
        with self._agent._call("files.stat", {"path": text}, timeout) as call:
            return FileInfo.from_json(call.result())


def _local_list(
    local: LocalAgent, directory: str, pattern: str, recursive: bool
) -> Iterator[FileInfo]:
    """本地调试时的列出，规则与 Agent 相同。"""
    import stat as stat_module
    from fnmatch import fnmatchcase

    from sfly.capabilities.files import FileInfo

    pattern = pattern or "*"

    def entries(real: str) -> list[os.DirEntry[str]]:
        with os.scandir(real) as it:
            return sorted(it, key=lambda e: e.name)

    def walk(real: str, items: list[os.DirEntry[str]]) -> Iterator[FileInfo]:
        subdirs = []
        for entry in items:
            try:
                if entry.is_dir(follow_symlinks=False):
                    if recursive:
                        subdirs.append(entry.path)
                    continue
                if not fnmatchcase(entry.name, pattern):
                    continue
                stat = os.stat(entry.path)
            except OSError:
                continue
            if stat_module.S_ISREG(stat.st_mode):
                yield FileInfo.from_stat(local.agent_path(entry.path), stat)
        for sub in subdirs:
            try:
                below = entries(sub)
            except OSError:
                continue
            yield from walk(sub, below)

    try:
        top = entries(local.real(directory))
    except OSError as error:
        raise local.error(error, directory) from None
    yield from walk(local.real(directory), top)
