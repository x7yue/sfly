"""本地调试时的 `files.watch`：用 inotify（经 ctypes 调用 libc）监听本机的目录，规则与 Agent 相同
（agent/src/capabilities/file_watch.rs）。只用标准库（ADR 0002），只支持 Linux。

和 Agent 上的差别：事件在节点迭代时才读，没有 Agent 的事件队列，节点读得慢时由内核的 inotify
队列溢出（`IN_Q_OVERFLOW`）触发重新给快照；没有连接，所以没有重连。
"""

from __future__ import annotations

import ctypes
import errno as errno_module
import os
import select
import struct
import sys
from collections.abc import Iterator
from dataclasses import replace
from typing import NamedTuple

from sfly.capabilities.errors import AgentError, AgentFileNotFound, AgentUnsupported
from sfly.capabilities.files_base import FileInfo, Scope
from sfly.capabilities.files_list import local_entries, local_file, local_files
from sfly.capabilities.files_watch import FileEvent, FileEventKind, WatchSnapshot
from sfly.capabilities.local import LocalAgent
from sfly.context import DeferCancel

IN_MODIFY = 0x00000002
IN_CLOSE_WRITE = 0x00000008
IN_MOVED_FROM = 0x00000040
IN_MOVED_TO = 0x00000080
IN_CREATE = 0x00000100
IN_DELETE = 0x00000200
IN_DELETE_SELF = 0x00000400
IN_MOVE_SELF = 0x00000800
IN_UNMOUNT = 0x00002000
IN_Q_OVERFLOW = 0x00004000
IN_IGNORED = 0x00008000
IN_ONLYDIR = 0x01000000
IN_ISDIR = 0x40000000

DIR_MASK = (
    IN_CREATE
    | IN_MOVED_FROM
    | IN_MOVED_TO
    | IN_CLOSE_WRITE
    | IN_MODIFY
    | IN_DELETE
    | IN_DELETE_SELF
    | IN_MOVE_SELF
    | IN_ONLYDIR
)

_HEADER = struct.Struct("iIII")

#: 改名事件读完一批后再等多久配对的 IN_MOVED_TO（秒），等不到就当作移出了监听范围。
_MOVE_PAIRING = 0.01


class _Overflow(Exception):
    """内核的 inotify 队列溢出：重新给快照。"""


class _MovedFrom(NamedTuple):
    """还没配对的 IN_MOVED_FROM：等同一个 `cookie` 的 IN_MOVED_TO。"""

    cookie: int
    real: str
    is_dir: bool


class _Inotify:
    """一个 inotify 实例。"""

    def __init__(self) -> None:
        self._libc = ctypes.CDLL(None, use_errno=True)
        fd = self._libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if fd < 0:
            raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
        self.fd = fd
        self._poll = select.poll()
        self._poll.register(fd, select.POLLIN)

    def add_watch(self, path: str) -> int:
        wd = self._libc.inotify_add_watch(self.fd, os.fsencode(path), DIR_MASK)
        if wd < 0:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code), path)
        return int(wd)

    def rm_watch(self, wd: int) -> None:
        self._libc.inotify_rm_watch(self.fd, wd)

    def read(self, timeout: float | None) -> list[tuple[int, int, int, str | None]]:
        """等到有事件（最多 `timeout` 秒，None 为一直等），读出现有的全部事件。"""
        if not self._poll.poll(None if timeout is None else int(timeout * 1000)):
            return []
        events = []
        while True:
            try:
                data = os.read(self.fd, 65536)
            except BlockingIOError:
                break
            offset = 0
            while offset + _HEADER.size <= len(data):
                wd, mask, cookie, length = _HEADER.unpack_from(data, offset)
                offset += _HEADER.size
                raw = data[offset : offset + length].split(b"\0", 1)[0]
                offset += length
                name = os.fsdecode(raw) if raw else None
                events.append((wd, mask, cookie, name))
        return events

    def close(self) -> None:
        os.close(self.fd)


def local_watch(local: LocalAgent, scope: Scope) -> Iterator[WatchSnapshot | FileEvent]:
    """本地调试时的监听：先给快照，再给事件；内核队列溢出时重新给快照（`missed=True`）。"""
    if not sys.platform.startswith("linux"):
        raise AgentUnsupported(
            "本地调试时的 files.watch 只支持 Linux（用 inotify 实现）", agent=local.name
        )
    watcher: _Watcher | None = None
    try:
        # inotify 实例一建出来就归下面的 finally 关闭：取消不会落在建出来和进入 try 之间。
        with DeferCancel():
            watcher = _Watcher(local, scope)
        missed = False
        while True:
            yield WatchSnapshot(tuple(watcher.scan()), missed)
            missed = True
            try:
                yield from watcher.events()
            except _Overflow:
                continue
    finally:
        if watcher is not None:
            watcher.close()


class _Watcher:
    """一次监听：各目录的 watch，和调用方已经知道的文件（`index`，本机上的路径 → 属性）。"""

    def __init__(self, local: LocalAgent, scope: Scope) -> None:
        self.local = local
        self.scope = scope
        directory = scope.directory
        self.root = local.real(directory)
        try:
            self.inotify = _Inotify()
        except OSError as error:
            raise AgentError(
                f"{local.label}：监听 {directory} 失败：{error}"
                "（inotify 实例数可能超过了系统上限 /proc/sys/fs/inotify/max_user_instances）",
                agent=local.name,
            ) from None
        try:
            self.root_wd = self.inotify.add_watch(self.root)
            os.listdir(self.root)
        except OSError as error:
            self.inotify.close()
            raise self._watch_error(error, directory) from None
        self.dirs: dict[int, str] = {self.root_wd: self.root}
        self.index: dict[str, FileInfo] = {}
        self.pending: list[FileEvent] = []

    def close(self) -> None:
        self.inotify.close()

    def _watch_error(self, error: OSError, path: str) -> AgentError:
        if error.errno == errno_module.ENOSPC:
            return AgentError(
                f"{self.local.label}：监听 {path} 失败：监听的目录数超过了系统上限"
                "（/proc/sys/fs/inotify/max_user_watches）：调大这个上限，或缩小监听范围",
                agent=self.local.name,
            )
        return self.local.error(error, path)

    # ---- 快照 ----

    def scan(self) -> list[FileInfo]:
        """列出当前匹配的文件（递归时顺便给子目录加上 watch），作为新的「调用方已经知道的文件」。"""
        dirs = {self.root_wd: self.root}
        try:
            top = local_entries(self.root)
        except OSError as error:
            raise self.local.error(error, self.scope.directory) from None
        found = list(self._files(top, dirs))
        for wd in set(self.dirs) - set(dirs):
            self.inotify.rm_watch(wd)
        self.dirs = dirs
        self.index = {self.local.real(f.path): f for f in found}
        return found

    def _files(self, entries: list[os.DirEntry[str]], dirs: dict[int, str]) -> Iterator[FileInfo]:
        """列出 `entries`（一个目录里的条目）下匹配的文件；递归时进入子目录前先给它加上 watch。"""
        return local_files(self.local, self.scope, entries, lambda sub: self._enter(sub, dirs))

    def _enter(self, real: str, dirs: dict[int, str]) -> bool:
        """给目录加上 watch，记进 `dirs`；加不上（例如已经被删除）时为 False。
        超过系统的 watch 数上限时抛出异常。"""
        try:
            wd = self.inotify.add_watch(real)
        except OSError as error:
            if error.errno == errno_module.ENOSPC:
                raise self._watch_error(error, self.local.agent_path(real)) from None
            return False
        dirs[wd] = real
        return True

    def _matching(self, name: str, real: str) -> FileInfo | None:
        return local_file(self.local, self.scope, name, real)

    # ---- 事件 ----

    def events(self) -> Iterator[FileEvent]:
        """一直读 inotify，逐个给出事件；内核队列溢出时抛出 `_Overflow`。"""
        moved: _MovedFrom | None = None
        while True:
            batch = self.inotify.read(_MOVE_PAIRING if moved is not None else None)
            if not batch and moved is not None:
                self._moved_out(moved)
                moved = None
            for wd, mask, cookie, name in batch:
                moved = self._handle(wd, mask, cookie, name, moved)
                yield from self._drain()
            yield from self._drain()

    def _drain(self) -> Iterator[FileEvent]:
        while self.pending:
            yield self.pending.pop(0)

    def _emit(self, kind: FileEventKind, info: FileInfo, old_real: str | None = None) -> None:
        if old_real is not None:
            self.index.pop(old_real, None)
        real = self.local.real(info.path)
        if kind == "deleted":
            self.index.pop(real, None)
        else:
            self.index[real] = info
        old_path = self.local.agent_path(old_real) if old_real is not None else None
        self.pending.append(FileEvent(kind=kind, file=info, old_path=old_path))

    def _appeared(self, name: str, real: str) -> None:
        info = self._matching(name, real)
        if info is None:
            return
        known = self.index.get(real)
        if known is not None and known.id == info.id:
            return
        if known is not None:
            self._emit("deleted", known)
        self._emit("created", info)

    def _gone(self, real: str) -> None:
        known = self.index.get(real)
        if known is not None:
            self._emit("deleted", known)

    def _known_under(self, real_dir: str) -> list[str]:
        prefix = real_dir.rstrip("/") + "/"
        return sorted(p for p in self.index if p.startswith(prefix))

    def _dir_appeared(self, real: str) -> None:
        dirs: dict[int, str] = {}
        if not self._enter(real, dirs):
            return
        try:
            entries = local_entries(real)
        except OSError:
            return
        found = list(self._files(entries, dirs))
        self.dirs.update(dirs)
        for info in found:
            file_real = self.local.real(info.path)
            self._appeared(os.path.basename(file_real), file_real)

    def _dir_gone(self, real: str) -> None:
        prefix = real.rstrip("/") + "/"
        for wd, path in list(self.dirs.items()):
            if path == real or path.startswith(prefix):
                del self.dirs[wd]
                self.inotify.rm_watch(wd)
        for path in self._known_under(real):
            self._gone(path)

    def _dir_moved(self, old: str, new: str) -> None:
        prefix = old.rstrip("/") + "/"
        for wd, path in list(self.dirs.items()):
            if path == old:
                self.dirs[wd] = new
            elif path.startswith(prefix):
                self.dirs[wd] = new + "/" + path[len(prefix) :]
        for old_file in self._known_under(old):
            new_file = new + "/" + old_file[len(prefix) :]
            try:
                info = self._stat(new_file)
            except OSError:
                info = replace(self.index[old_file], path=self.local.agent_path(new_file))
            self._emit("moved", info, old_file)

    def _stat(self, real: str) -> FileInfo:
        return FileInfo.from_stat(self.local.agent_path(real), os.stat(real))

    def _moved_out(self, moved: _MovedFrom) -> None:
        if moved.is_dir:
            self._dir_gone(moved.real)
        else:
            self._gone(moved.real)

    def _file_moved(self, old: str, name: str, new: str) -> None:
        known = old in self.index
        info = self._matching(name, new)
        if known and info is not None:
            replaced = self.index.get(new)
            if replaced is not None and replaced.id != info.id:
                self._emit("deleted", replaced)
            self._emit("moved", info, old)
        elif known:
            self._gone(old)
        elif info is not None:
            self._appeared(name, new)

    def _handle(
        self,
        wd: int,
        mask: int,
        cookie: int,
        name: str | None,
        moved: _MovedFrom | None,
    ) -> _MovedFrom | None:
        """处理一个 inotify 事件，返回还没配对的 IN_MOVED_FROM。"""
        if mask & IN_Q_OVERFLOW:
            raise _Overflow
        if moved is not None and not (mask & IN_MOVED_TO and cookie == moved.cookie):
            self._moved_out(moved)
            moved = None
        if wd == self.root_wd and mask & (IN_DELETE_SELF | IN_MOVE_SELF | IN_IGNORED):
            raise AgentFileNotFound(
                f"{self.local.label}：被监听的目录 {self.scope.directory} 已被删除或改名，监听结束",
                agent=self.local.name,
            )
        if mask & IN_UNMOUNT:
            raise self.local.invalid(
                f"被监听的目录 {self.scope.directory} 所在的文件系统已被卸载，监听结束"
            )
        if mask & IN_IGNORED:
            self.dirs.pop(wd, None)
            return moved
        parent = self.dirs.get(wd)
        if parent is None or name is None:
            return moved
        real = os.path.join(parent, name)
        is_dir = bool(mask & IN_ISDIR)
        if is_dir and not self.scope.recursive:
            return moved
        if mask & IN_MOVED_FROM:
            return _MovedFrom(cookie, real, is_dir)
        if mask & IN_MOVED_TO:
            if moved is not None:
                if moved.is_dir:
                    self._dir_moved(moved.real, real)
                else:
                    self._file_moved(moved.real, name, real)
            elif is_dir:
                self._dir_appeared(real)
            else:
                self._appeared(name, real)
            return None
        if is_dir:
            if mask & IN_CREATE:
                self._dir_appeared(real)
            elif mask & IN_DELETE:
                self._dir_gone(real)
            return moved
        if mask & IN_CREATE:
            self._appeared(name, real)
        elif mask & IN_DELETE:
            self._gone(real)
        elif mask & (IN_CLOSE_WRITE | IN_MODIFY):
            info = self._matching(name, real)
            if info is not None:
                self._emit("closed" if mask & IN_CLOSE_WRITE else "modified", info)
        return moved
