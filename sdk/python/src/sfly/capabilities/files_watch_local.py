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
import stat as stat_module
import struct
import sys
from collections.abc import Iterator
from fnmatch import fnmatchcase
from typing import TYPE_CHECKING

from sfly.capabilities.errors import AgentError, AgentFileNotFound, AgentUnsupported

if TYPE_CHECKING:
    from sfly.capabilities.files import FileInfo
    from sfly.capabilities.files_watch import FileEvent, FileEventKind, WatchSnapshot
    from sfly.capabilities.local import LocalAgent

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


def local_watch(
    local: LocalAgent, directory: str, pattern: str, recursive: bool
) -> Iterator[WatchSnapshot | FileEvent]:
    """本地调试时的监听：先给快照，再给事件；内核队列溢出时重新给快照（`missed=True`）。"""
    from sfly.capabilities.files_watch import WatchSnapshot

    if not sys.platform.startswith("linux"):
        raise AgentUnsupported(
            "本地调试时的 files.watch 只支持 Linux（用 inotify 实现）", agent=local.name
        )
    watcher = _Watcher(local, directory, pattern, recursive)
    try:
        missed = False
        while True:
            yield WatchSnapshot(tuple(watcher.scan()), missed)
            missed = True
            try:
                yield from watcher.events()
            except _Overflow:
                continue
    finally:
        watcher.close()


class _Watcher:
    """一次监听：各目录的 watch，和调用方已经知道的文件（`index`，本机上的路径 → 属性）。"""

    def __init__(self, local: LocalAgent, directory: str, pattern: str, recursive: bool) -> None:
        self.local = local
        self.directory = directory
        self.root = local.real(directory)
        self.pattern = pattern
        self.recursive = recursive
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
        found: list[FileInfo] = []
        dirs = {self.root_wd: self.root}
        try:
            top = _entries(self.root)
        except OSError as error:
            raise self.local.error(error, self.directory) from None
        self._walk(self.root, top, found, dirs)
        for wd in set(self.dirs) - set(dirs):
            self.inotify.rm_watch(wd)
        self.dirs = dirs
        self.index = {self.local.real(f.path): f for f in found}
        return found

    def _walk(
        self,
        real: str,
        entries: list[os.DirEntry[str]],
        found: list[FileInfo],
        dirs: dict[int, str],
    ) -> None:
        subdirs = []
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    if self.recursive:
                        subdirs.append(entry.path)
                    continue
            except OSError:
                continue
            info = self._matching(entry.name, entry.path)
            if info is not None:
                found.append(info)
        for sub in subdirs:
            try:
                wd = self.inotify.add_watch(sub)
            except OSError as error:
                if error.errno == errno_module.ENOSPC:
                    raise self._watch_error(error, self.local.agent_path(sub)) from None
                continue
            try:
                below = _entries(sub)
            except OSError:
                continue
            dirs[wd] = sub
            self._walk(sub, below, found, dirs)

    def _matching(self, name: str, real: str) -> FileInfo | None:
        from sfly.capabilities.files import FileInfo

        if not fnmatchcase(name, self.pattern):
            return None
        try:
            st = os.stat(real)
        except OSError:
            return None
        if not stat_module.S_ISREG(st.st_mode):
            return None
        return FileInfo.from_stat(self.local.agent_path(real), st)

    # ---- 事件 ----

    def events(self) -> Iterator[FileEvent]:
        """一直读 inotify，逐个给出事件；内核队列溢出时抛出 `_Overflow`。"""
        moved: tuple[int, str, bool] | None = (
            None  # 还没配对的 IN_MOVED_FROM：(cookie, 路径, 是否目录)
        )
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
        from sfly.capabilities.files_watch import FileEvent

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
        try:
            wd = self.inotify.add_watch(real)
        except OSError as error:
            if error.errno == errno_module.ENOSPC:
                raise self._watch_error(error, self.local.agent_path(real)) from None
            return
        try:
            entries = _entries(real)
        except OSError:
            return
        found: list[FileInfo] = []
        dirs = {wd: real}
        self._walk(real, entries, found, dirs)
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
        from dataclasses import replace

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
        from sfly.capabilities.files import FileInfo

        return FileInfo.from_stat(self.local.agent_path(real), os.stat(real))

    def _moved_out(self, moved: tuple[int, str, bool]) -> None:
        _, real, is_dir = moved
        if is_dir:
            self._dir_gone(real)
        else:
            self._gone(real)

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
        moved: tuple[int, str, bool] | None,
    ) -> tuple[int, str, bool] | None:
        """处理一个 inotify 事件，返回还没配对的 IN_MOVED_FROM。"""
        if mask & IN_Q_OVERFLOW:
            raise _Overflow
        if moved is not None and not (mask & IN_MOVED_TO and cookie == moved[0]):
            self._moved_out(moved)
            moved = None
        if wd == self.root_wd and mask & (IN_DELETE_SELF | IN_MOVE_SELF | IN_IGNORED):
            raise AgentFileNotFound(
                f"{self.local.label}：被监听的目录 {self.directory} 已被删除或改名，监听结束",
                agent=self.local.name,
            )
        if mask & IN_UNMOUNT:
            raise AgentError(
                f"{self.local.label}：被监听的目录 {self.directory} 所在的文件系统已被卸载，"
                "监听结束",
                agent=self.local.name,
                kind="invalid",
            )
        if mask & IN_IGNORED:
            self.dirs.pop(wd, None)
            return moved
        parent = self.dirs.get(wd)
        if parent is None or name is None:
            return moved
        real = os.path.join(parent, name)
        is_dir = bool(mask & IN_ISDIR)
        if is_dir and not self.recursive:
            return moved
        if mask & IN_MOVED_FROM:
            return (cookie, real, is_dir)
        if mask & IN_MOVED_TO:
            if moved is not None:
                if moved[2]:
                    self._dir_moved(moved[1], real)
                else:
                    self._file_moved(moved[1], name, real)
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


def _entries(real: str) -> list[os.DirEntry[str]]:
    with os.scandir(real) as it:
        return sorted(it, key=lambda e: e.name)
