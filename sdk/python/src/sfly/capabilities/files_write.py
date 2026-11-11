"""`files.write`、`files.upload`、`files.delete`：写入、上传、删除文件。只用标准库（ADR 0002）。

Agent 一侧见 agent/src/capabilities/file_write.rs，本地调试时的实现
（`_local_write`、`_local_delete`）规则与它相同：先写到目标所在目录里的临时文件
（`.<文件名>.sfly-<随机>.tmp`），写完才改名为目标路径。
"""

from __future__ import annotations

import itertools
import os
from collections.abc import Iterable, Iterator
from typing import TYPE_CHECKING

from sfly.capabilities.channel import DEFAULT_TIMEOUT, MAX_DATA
from sfly.capabilities.errors import (
    AgentError,
    AgentFileNotFound,
    AgentPermissionDenied,
)
from sfly.capabilities.files_list import FilesBase

if TYPE_CHECKING:
    from sfly.capabilities.files import FileInfo
    from sfly.capabilities.local import LocalAgent

#: `files.write` 的内容：一整块字节，或逐段给出字节的可迭代对象（例如生成器）。
Data = bytes | bytearray | memoryview | Iterable[bytes | bytearray | memoryview]

_BYTES = (bytes, bytearray, memoryview)


class WriteDelete(FilesBase):
    def write(
        self,
        path: str | os.PathLike[str],
        data: Data,
        *,
        timeout: float | None = DEFAULT_TIMEOUT,
    ) -> FileInfo:
        """把 `data` 写成那台 Agent 上的文件 `path`，返回写好的文件的属性。

        - `data` 是字节（`bytes`、`bytearray`、`memoryview`），或逐段给出字节的可迭代对象：
          边取边发，不用先把整个文件放进内存；
        - 先写到 `path` 所在目录里的临时文件，全部写完才改名为 `path`：`path` 已存在时整个替换
          （保留它的权限位），读它的人不会读到半截。写到一半出错（包括 `data` 抛出异常）、任务被取消
          或节点进程退出时，`path` 不受影响；
        - `path` 所在的目录必须已经存在，`path` 不能是目录；
        - `timeout`：等对方回应的上限（秒）：对方接收每一段、写完后给出结果各自最多等多久；
          等 `data` 给出下一段不计时。None 为不限。
        """
        from sfly.capabilities.files import absolute

        text = absolute(path)
        self._agent._check_timeout(timeout)
        chunks = _chunks(data)
        local = self._agent._local()
        if local is not None:
            return _local_write(local, text, chunks)
        from sfly.capabilities.files import FileInfo

        with self._agent._call("files.write", {"path": text}, timeout) as call:
            for chunk in chunks:
                if not call.send_data(chunk):
                    break  # Agent 已经结束了调用（出错了），结果里有原因。
            else:
                call.send_end()
            return FileInfo.from_json(call.result())

    def upload(
        self,
        local_path: str | os.PathLike[str],
        path: str | os.PathLike[str],
        *,
        timeout: float | None = DEFAULT_TIMEOUT,
    ) -> FileInfo:
        """把节点所在机器上的文件 `local_path` 上传成那台 Agent 上的文件 `path`，
        返回写好的文件的属性。

        - 由自己所在的 Agent 读 `local_path`，直接传给那台 Agent，数据不经过节点进程；
          对 `ctx.agent()` 就是本机复制；
        - `local_path` 是节点所在机器上的路径，相对路径相对于节点的当前目录（任务目录）；
        - 写入的规则与 `write` 相同（先写临时文件再改名）；
        - `timeout`：对方接收每一段、写完后给出结果各自最多等多久，None 为不限。
        """
        from sfly.capabilities.files import FileInfo, absolute

        text = absolute(path)
        source = os.path.abspath(os.fspath(local_path))
        self._agent._check_timeout(timeout)
        local = self._agent._local()
        if local is not None:
            return _local_write(local, text, _read_file(source))
        args = {"local_path": source, "path": text}
        with self._agent._call("files.upload", args, timeout) as call:
            return FileInfo.from_json(call.result())

    def delete(
        self, path: str | os.PathLike[str], *, timeout: float | None = DEFAULT_TIMEOUT
    ) -> None:
        """删除那台 Agent 上的文件 `path`。不删除目录；`path` 是符号链接时删除链接本身。
        文件不存在时抛出 `sfly.AgentFileNotFound`。"""
        from sfly.capabilities.files import absolute

        text = absolute(path)
        self._agent._check_timeout(timeout)
        local = self._agent._local()
        if local is not None:
            _local_delete(local, text)
            return
        with self._agent._call("files.delete", {"path": text}, timeout) as call:
            call.result()


def _chunks(data: Data) -> Iterator[memoryview]:
    """把内容切成每段不超过 `MAX_DATA` 字节、跳过空段。`data` 不是字节也不可迭代时
    立即抛出 TypeError，可迭代对象给出的某一段不是字节时取到那一段才抛出。"""
    if isinstance(data, str):
        raise TypeError("files.write 写入的是字节：文本先 encode()，例如 text.encode('utf-8')")

    def wrong(value: object) -> TypeError:
        return TypeError(
            f"files.write 的内容必须是字节，或逐段给出字节的可迭代对象，收到 {type(value).__name__}"
        )

    try:
        parts: Iterator[object] = iter((data,) if isinstance(data, _BYTES) else data)
    except TypeError:
        raise wrong(data) from None

    def split() -> Iterator[memoryview]:
        for part in parts:
            if not isinstance(part, _BYTES):
                raise wrong(part)
            view = memoryview(part).cast("B")
            for start in range(0, len(view), MAX_DATA):
                yield view[start : start + MAX_DATA]

    return split()


def _invalid(local: LocalAgent, message: str) -> AgentError:
    return AgentError(f"{local.label}：{message}", agent=local.name, kind="invalid")


def _read_file(path: str) -> Iterator[bytes]:
    """本地调试时上传：逐段读本机（节点所在机器）的文件。打不开时抛出和 Agent 上相同的异常。"""
    from sfly.capabilities.local import LocalAgent

    own = LocalAgent(None, None)
    try:
        f = open(path, "rb")  # noqa: SIM115 - 交给下面的生成器，读完关闭
    except IsADirectoryError:
        raise _invalid(own, f"{path} 不是文件") from None
    except OSError as error:
        raise own.error(error, path) from None

    def read() -> Iterator[bytes]:
        with f:
            while chunk := f.read(MAX_DATA):
                yield chunk

    return read()


_TEMP_SEQ = itertools.count()


def _local_write(local: LocalAgent, path: str, chunks: Iterable[bytes | memoryview]) -> FileInfo:
    """本地调试时的写入：先写临时文件再改名，规则与 Agent 相同。"""
    import posixpath
    import stat as stat_module

    from sfly.capabilities.files import FileInfo

    real = local.real(path)
    directory, name = os.path.split(real)
    if not posixpath.basename(path) or not name:
        raise _invalid(local, f"{path} 不是文件路径")
    try:
        existing = os.lstat(real)
    except FileNotFoundError:
        mode = None
    except OSError as error:
        raise local.error(error, path) from None
    else:
        if stat_module.S_ISDIR(existing.st_mode):
            raise _invalid(local, f"{path} 是目录：只能写入文件")
        regular = stat_module.S_ISREG(existing.st_mode)
        mode = stat_module.S_IMODE(existing.st_mode) if regular else None
    temp = os.path.join(
        directory,
        f".{name[:100]}.sfly-{os.getpid():x}-{next(_TEMP_SEQ):x}-{os.urandom(4).hex()}.tmp",
    )
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o666)
    except FileNotFoundError:
        message = f"{local.label}：目录 {posixpath.dirname(path)} 不存在"
        raise AgentFileNotFound(message, agent=local.name) from None
    except PermissionError:
        message = f"{local.label}：没有权限写入 {path}"
        raise AgentPermissionDenied(message, agent=local.name) from None
    except OSError as error:
        raise local.error(error, path) from None
    try:
        with os.fdopen(fd, "wb") as f:
            for chunk in chunks:
                f.write(chunk)
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(temp, mode)
        os.replace(temp, real)
    except BaseException as error:
        # 包括 Cancelled、内容抛出的异常：删掉临时文件，目标不受影响。
        try:
            os.unlink(temp)
        except OSError:
            pass
        if isinstance(error, OSError) and not isinstance(error, AgentError):
            raise local.error(error, path) from None
        raise
    return FileInfo.from_stat(path, os.stat(real))


def _local_delete(local: LocalAgent, path: str) -> None:
    """本地调试时的删除，规则与 Agent 相同。"""
    import stat as stat_module

    real = local.real(path)
    try:
        is_dir = stat_module.S_ISDIR(os.lstat(real).st_mode)
        if not is_dir:
            os.unlink(real)
    except PermissionError:
        message = f"{local.label}：没有权限删除 {path}"
        raise AgentPermissionDenied(message, agent=local.name) from None
    except OSError as error:
        raise local.error(error, path) from None
    if is_dir:
        raise _invalid(local, f"{path} 是目录：只能删除文件")
