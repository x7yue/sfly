"""`files.list`、`files.stat`：列出文件、查看文件属性。只用标准库（ADR 0002）。

Agent 一侧见 agent/src/capabilities/files.rs，本地调试时的实现（`local_files`）规则与它相同；
本地调试时的监听（`files_watch_local.py`）也用 `local_files` 列出文件。
"""

from __future__ import annotations

import os
import stat as stat_module
from collections.abc import Callable, Generator, Iterator
from typing import TYPE_CHECKING

from sfly.capabilities.channel import DEFAULT_TIMEOUT
from sfly.capabilities.files_base import FileInfo, FilesBase, Scope, absolute

if TYPE_CHECKING:
    from sfly.capabilities.local import LocalAgent


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
        scope = Scope.of(directory, pattern, recursive)
        self._agent._check_timeout(timeout)
        return self._list(scope, timeout)

    def _list(self, scope: Scope, timeout: float | None) -> Generator[FileInfo, None, None]:
        local = self._agent._local()
        if local is not None:
            real = local.real(scope.directory)
            try:
                top = local_entries(real)
            except OSError as error:
                raise local.error(error, scope.directory) from None
            yield from local_files(local, scope, top)
            return
        with self._agent._call("files.list", scope.args(), timeout) as call:
            for item in call.items():
                yield FileInfo.from_json(item)

    def stat(
        self, path: str | os.PathLike[str], *, timeout: float | None = DEFAULT_TIMEOUT
    ) -> FileInfo:
        """查看一个文件（或目录）的属性（跟随符号链接）。
        文件不存在时抛出 `sfly.AgentFileNotFound`。"""
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


def local_entries(real: str) -> list[os.DirEntry[str]]:
    """本机目录 `real` 里的条目，按名称排序。"""
    with os.scandir(real) as it:
        return sorted(it, key=lambda e: e.name)


def local_files(
    local: LocalAgent,
    scope: Scope,
    entries: list[os.DirEntry[str]],
    enter: Callable[[str], bool] = lambda _: True,
) -> Iterator[FileInfo]:
    """本地调试时列出：`entries` 是一个目录里的条目（`local_entries`），给出其中匹配的普通文件，
    `scope.recursive` 时再按名称依次进入子目录，规则与 Agent 相同。进入子目录之前先调用
    `enter(子目录在本机上的位置)`，返回 False 时跳过它；列不出的子目录、列出期间消失的文件跳过。"""
    subdirs = []
    for entry in entries:
        try:
            if entry.is_dir(follow_symlinks=False):
                if scope.recursive:
                    subdirs.append(entry.path)
                continue
        except OSError:
            continue
        info = local_file(local, scope, entry.name, entry.path)
        if info is not None:
            yield info
    for sub in subdirs:
        if not enter(sub):
            continue
        try:
            below = local_entries(sub)
        except OSError:
            continue
        yield from local_files(local, scope, below, enter)


def local_file(local: LocalAgent, scope: Scope, name: str, real: str) -> FileInfo | None:
    """本机上的 `real`（文件名 `name`）在范围里时的属性：匹配 `pattern` 的普通文件
    （跟随符号链接）。"""
    if not scope.matches(name):
        return None
    try:
        st = os.stat(real)
    except OSError:
        return None
    if not stat_module.S_ISREG(st.st_mode):
        return None
    return FileInfo.from_stat(local.agent_path(real), st)
