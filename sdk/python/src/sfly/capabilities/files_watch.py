"""`files.watch`：监听目录。只用标准库（ADR 0002）。

Agent 一侧见 agent/src/capabilities/file_watch.rs；本地调试时的实现（`files_watch_local.py`）
规则与它相同。
"""

from __future__ import annotations

import os
from collections.abc import Generator
from dataclasses import dataclass
from typing import Any, Literal

from sfly.capabilities.channel import DEFAULT_TIMEOUT
from sfly.capabilities.files_base import FileId, FileInfo, FilesBase, Scope

#: 事件的类型。
FileEventKind = Literal["created", "moved", "closed", "modified", "deleted"]


@dataclass(frozen=True)
class WatchSnapshot:
    """监听目录时的一份快照：当时匹配的全部文件（顺序与 `files.list` 相同）。

    - `files`：`FileInfo` 的元组；
    - `missed`：可能有遗漏。监听开始时的第一份快照为 False；两台 Agent 之间的连接中断后重连、
      或事件太多来不及发出（事件队列溢出）时重新给的快照为 True：之前的一些事件没有送到，
      以这份快照为准，按文件标识去重。
    """

    files: tuple[FileInfo, ...]
    missed: bool


@dataclass(frozen=True)
class FileEvent:
    """监听目录时一个文件上发生的事。

    - `kind`：`created`（新建，包括从别处移进来）、`moved`（在监听范围内改名，例如日志轮转，
      文件标识不变）、`closed`（以写方式打开的文件被关闭；不代表不会再被写）、`modified`
      （内容被修改，还没送到的连续几次修改合并成一个）、`deleted`（被删除，包括移出监听范围）；
    - `file`：事件之后这个文件的属性（`FileInfo`）；`deleted` 是最后一次看到的属性；
    - `old_path`：`moved` 时原来的路径，其它为 None。

    事件描述的是「匹配通配符的文件」这个集合的变化：改名后不再匹配是 `deleted`，改名后才匹配是
    `created`。
    """

    kind: FileEventKind
    file: FileInfo
    old_path: str | None = None

    @property
    def path(self) -> str:
        """文件（事件之后）的路径。"""
        return self.file.path

    @property
    def id(self) -> FileId:
        """文件标识。"""
        return self.file.id


class Watch(FilesBase):
    def watch(
        self,
        directory: str | os.PathLike[str],
        pattern: str = "*",
        *,
        recursive: bool = False,
        timeout: float | None = DEFAULT_TIMEOUT,
    ) -> Generator[WatchSnapshot | FileEvent, None, None]:
        """监听目录 `directory` 下文件名匹配 `pattern` 的普通文件：先给出一份 `WatchSnapshot`
        （当前的文件），之后逐个给出 `FileEvent`，一直监听下去，直到停止迭代（或 `close()`）。

        - `pattern` 与 `files.list` 相同；`recursive=True` 时监听子目录，包括监听期间新建的
          （新子目录里已有的文件作为 `created` 给出）；
        - 快照之后的变化不会漏掉，但可能和快照重复；连接中断后自动重连、事件太多来不及发出时，
          重新给一份 `missed=True` 的快照。按文件标识（`FileId`）去重；
        - 只报告发生了什么，不判断文件是否写完；
        - 用 inotify 实现，只在 Linux 的本地文件系统上可靠；
        - `timeout`：等对方回应的上限（秒），None 为不限。开始监听最多等这么久；之后对方超过
          这么久没有任何回应（它会定期发心跳）就认为连接中断并重连，重连这么久还没成功时抛出
          `sfly.AgentUnreachable`。

        迭代时才开始监听：`directory` 不存在、不是目录或没有权限时，迭代时抛出异常
        （见 `sfly.AgentError`）；监听期间目录被删除或改名时抛出 `sfly.AgentFileNotFound`。
        """
        scope = Scope.of(directory, pattern, recursive)
        self._agent._check_timeout(timeout)
        return self._watch(scope, timeout)

    def _watch(
        self, scope: Scope, timeout: float | None
    ) -> Generator[WatchSnapshot | FileEvent, None, None]:
        local = self._agent._local()
        if local is not None:
            # 用到时才导入：它用 ctypes 调用 libc，不放在每个任务的启动路径上（#76）。
            from sfly.capabilities.files_watch_local import local_watch

            yield from local_watch(local, scope)
            return
        files: list[FileInfo] = []
        missed = False
        with self._agent._call("files.watch", scope.args(), timeout) as call:
            for item in call.items():
                if not isinstance(item, dict):
                    continue
                snapshot: Any = item.get("snapshot")
                event: Any = item.get("event")
                if isinstance(snapshot, dict):
                    # 一份快照分成若干批：first 开始一份新的（重连时丢掉没收完的那份）。
                    if snapshot.get("first"):
                        files = []
                        missed = bool(snapshot.get("missed"))
                    files.extend(FileInfo.from_json(f) for f in snapshot.get("files", []))
                    if snapshot.get("last"):
                        yield WatchSnapshot(tuple(files), missed)
                        files = []
                elif isinstance(event, dict):
                    yield FileEvent(
                        kind=event["kind"],
                        file=FileInfo.from_json(event["file"]),
                        old_path=event.get("old_path"),
                    )
                # 其它（保活 `alive`）跳过。
