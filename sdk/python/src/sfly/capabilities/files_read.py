"""`files.read`、`files.download`：流式读取文件、下载到本地路径。只用标准库（ADR 0002）。

Agent 一侧见 agent/src/capabilities/file_read.rs：下载由节点所在的 Agent 直接写本地文件，
数据不经过节点进程，节点只收到进度和结果。本地调试时的实现（`_local_read`、`_local_download`）
规则与它相同。
"""

from __future__ import annotations

import os
from collections.abc import Callable, Generator, Iterator
from typing import TYPE_CHECKING, Any

from sfly.capabilities.channel import DEFAULT_TIMEOUT
from sfly.capabilities.errors import AgentError, AgentFileNotFound
from sfly.capabilities.files_list import FilesBase

if TYPE_CHECKING:
    from sfly.capabilities.files import FileInfo
    from sfly.capabilities.local import LocalAgent

#: 本地调试时一次读多少字节（与 Agent 的块大小相同）。
_CHUNK = 256 * 1024


class ReadDownload(FilesBase):
    def read(
        self,
        path: str | os.PathLike[str],
        offset: int = 0,
        length: int | None = None,
        *,
        timeout: float | None = DEFAULT_TIMEOUT,
    ) -> Generator[bytes, None, None]:
        """从第 `offset` 个字节开始读取文件 `path`，逐块给出内容（`bytes`），读到 `length` 字节
        或文件末尾为止（`length` 为 None 时读到末尾）。`offset` 超过文件末尾时没有内容。

        - 读的是迭代到那一刻的内容：文件还在被写入时，读到的是当时已经写下的部分；
        - `timeout`：等对方回应的上限（秒），这里是到第一块、以及相邻两块之间各自最多等多久；
          None 为不限。

        迭代时才发起调用：文件不存在、是目录或没有权限时，迭代时抛出异常（见 `sfly.AgentError`）。
        中途停止迭代（或 `close()`）时调用随之放弃。
        """
        from sfly.capabilities.files import absolute

        text = absolute(path)
        _check_offset("offset", offset)
        if length is not None:
            _check_offset("length", length)
        self._agent._check_timeout(timeout)
        return self._read(text, offset, length, timeout)

    def _read(
        self, path: str, offset: int, length: int | None, timeout: float | None
    ) -> Generator[bytes, None, None]:
        local = self._agent._local()
        if local is not None:
            yield from _local_read(local, path, offset, length)
            return
        args = {"path": path, "offset": offset, "length": length}
        with self._agent._call("files.read", args, timeout) as call:
            for frame in call.frames():
                data = frame.get("bytes")
                if data:
                    yield data

    def download(
        self,
        path: str | os.PathLike[str],
        local_path: str | os.PathLike[str],
        *,
        timeout: float | None = DEFAULT_TIMEOUT,
        progress: Callable[[int, int], Any] | None = None,
    ) -> FileInfo:
        """把这台 Agent 上的文件 `path` 下载到节点所在机器上的 `local_path`，返回下载完成时
        源文件的属性（`FileInfo`，`size` 就是下载下来的字节数，`path` 是它现在的路径）。

        - 数据由节点所在的 Agent 直接写到 `local_path`，不经过节点进程；
        - `local_path` 是节点所在机器上的路径，相对路径相对于节点的工作目录（任务目录）；
          所在的目录不存在时一并创建，那里已有的文件被替换；
        - 先写同一目录里的临时文件（`.<文件名>.sfly-<随机>.tmp`，与 `write` 相同），完成并核对后
          才改名为 `local_path`：`local_path` 上不会出现半截文件，失败或被取消时临时文件被删除；
        - 下载的是开始时打开的那个文件、开始时的大小，内容都从打开的文件读：下载期间它被改名
          （例如日志轮转）不影响下载，返回的 `path` 是它现在的路径（在别的目录里时仍是 `path`）。
          完成时按这个文件核对：它在下载期间被删除时抛出 `sfly.AgentFileNotFound`，被截短或
          大小变了（还在写入）时抛出 `sfly.AgentError`；
        - 连接中断时自动重连，从断点继续读同一个文件：它在同一目录里改了名时接着读新路径上的它；
          路径上换成了另一个文件、在同一目录里也找不到它时抛出 `sfly.AgentFileMoved`（路径上
          没有文件时抛出 `sfly.AgentFileNotFound`），知道它去了哪里时用新路径重新下载；
        - `progress(downloaded, size)`：下载期间不时被调用（在 Agent 上大约每秒一次），
          参数是已经下载的字节数和要下载的字节数；
        - `timeout`：等对方回应的上限（秒），这里是相邻两次进展之间最多等多久，不是整个下载；
          None 为不限。
        """
        from sfly.capabilities.files import FileInfo, absolute

        text = absolute(path)
        target = os.path.abspath(os.fspath(local_path))
        self._agent._check_timeout(timeout)
        local = self._agent._local()
        if local is not None:
            return _local_download(local, text, target, progress)
        args = {"path": text, "local_path": target}
        result: Any = None
        with self._agent._call("files.download", args, timeout) as call:
            for frame in call.frames():
                item = frame.get("item")
                if isinstance(item, dict) and progress is not None:
                    progress(int(item["downloaded"]), int(item["size"]))
                result = frame.get("result", result)
        return FileInfo.from_json(result)


def _check_offset(name: str, value: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} 必须是不小于 0 的整数，收到 {value!r}")


def _open(local: LocalAgent, path: str) -> Any:
    """打开那台 Agent 上要读的文件（本机上的位置），错误与 Agent 上相同。"""
    real = local.real(path)
    if os.path.isdir(real):
        raise AgentError(
            f"{local.label}：{path} 是目录，不能读取", agent=local.name, kind="invalid"
        )
    try:
        return open(real, "rb")  # noqa: SIM115 — 调用方用 with 管理
    except OSError as error:
        raise local.error(error, path) from None


def _local_read(local: LocalAgent, path: str, offset: int, length: int | None) -> Iterator[bytes]:
    """本地调试时的读取，规则与 Agent 相同。"""
    with _open(local, path) as f:
        f.seek(offset)
        remaining = length
        while remaining is None or remaining > 0:
            data = f.read(_CHUNK if remaining is None else min(_CHUNK, remaining))
            if not data:
                return
            if remaining is not None:
                remaining -= len(data)
            yield data


def _local_download(
    local: LocalAgent,
    path: str,
    target: str,
    progress: Callable[[int, int], Any] | None,
) -> FileInfo:
    """本地调试时的下载，规则与 Agent 相同：和写入一样先写临时文件（`_local_write`），
    从打开的文件读到开始时的大小，读完按这个文件（不是路径上现在的文件）核对之后才改名为目标路径。"""
    from sfly.capabilities.files import FileInfo
    from sfly.capabilities.files_write import _local_write
    from sfly.capabilities.local import LocalAgent

    # 目标在本机上：路径原样使用，消息里是「本机」。
    own = LocalAgent(None, None)
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
    except OSError as error:
        raise own.error(error, target) from None
    end: os.stat_result | None = None
    with _open(local, path) as source:
        start = os.fstat(source.fileno())

        def chunks() -> Iterator[bytes]:
            nonlocal end
            written = 0
            while written < start.st_size:
                data = source.read(min(_CHUNK, start.st_size - written))
                if not data:
                    break
                yield data
                written += len(data)
                if progress is not None:
                    progress(written, start.st_size)
            # 在这里抛出的异常让 `_local_write` 删掉临时文件、不改名。
            end = os.fstat(source.fileno())
            if end.st_nlink == 0:
                raise AgentFileNotFound(
                    f"{local.label}：{path} 在下载期间被删除，下载作废", agent=local.name
                )
            changed = _changed(start, end, written)
            if changed:
                raise AgentError(f"{local.label}：{path} {changed}，下载作废", agent=local.name)

        _local_write(own, target, chunks())
    assert end is not None
    return FileInfo.from_stat(_located(local, path, end), end)


def _changed(start: os.stat_result, end: os.stat_result, written: int) -> str:
    """打开的源文件在下载期间怎样变了（与 Agent 的消息相同）；没有变时为空串。"""
    if written < start.st_size:
        return (
            f"在下载期间被截短（开始时 {start.st_size} 字节，读到第 {written} 字节就到了末尾，"
            f"现在 {end.st_size} 字节）"
        )
    if end.st_size != written:
        return (
            f"在下载期间变化了（开始时 {start.st_size} 字节，现在 {end.st_size} 字节，"
            "可能还在写入）"
        )
    return ""


def _located(local: LocalAgent, path: str, file: os.stat_result) -> str:
    """文件 `file` 现在在哪里（那台 Agent 上的写法）：还在 `path` 上就是 `path`，在同一目录里改了名
    就是新路径，找不到时仍是 `path`（与 Agent 相同）。"""
    import posixpath

    real = local.real(path)
    identity = (file.st_dev, file.st_ino)
    try:
        here = os.stat(real)
    except OSError:
        pass
    else:
        if (here.st_dev, here.st_ino) == identity:
            return path
    try:
        with os.scandir(os.path.dirname(real)) as entries:
            for entry in entries:
                if entry.inode() != file.st_ino:
                    continue
                found = os.stat(entry.path)
                if (found.st_dev, found.st_ino) == identity:
                    return posixpath.join(posixpath.dirname(path), entry.name)
    except OSError:
        pass
    return path
