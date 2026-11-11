"""`files.write`、`files.upload`、`files.delete`：写入、上传、删除文件。只用标准库（ADR 0002）。

Agent 一侧见 agent/src/capabilities/file_write.rs，本地调试时的实现
（`local_write`、`_local_delete`）规则与它相同：先写到目标所在目录里的临时文件
（`.<文件名>.sfly-<随机>.tmp`），写完才改名为目标路径。
"""

from __future__ import annotations

import itertools
import os
import posixpath
import stat as stat_module
from collections.abc import Iterable, Iterator
from typing import IO

from sfly.capabilities.channel import DEFAULT_TIMEOUT, MAX_DATA
from sfly.capabilities.errors import AgentError
from sfly.capabilities.files_base import FileInfo, FilesBase, absolute
from sfly.capabilities.local import HERE, LocalAgent, read_chunks
from sfly.context import DeferCancel

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
        text = absolute(path)
        self._agent._check_timeout(timeout)
        chunks = _chunks(data)
        local = self._agent._local()
        if local is not None:
            return local_write(local, text, chunks)
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
        text = absolute(path)
        source = os.path.abspath(os.fspath(local_path))
        self._agent._check_timeout(timeout)
        local = self._agent._local()
        if local is not None:
            # 和 Agent 上一样先打开要上传的文件：它不存在时报的是本机上的错误。
            with HERE.open_file(source, regular=True) as f:
                return local_write(local, text, read_chunks(f, MAX_DATA))
        args = {"local_path": source, "path": text}
        with self._agent._call("files.upload", args, timeout) as call:
            return FileInfo.from_json(call.result())

    def delete(
        self, path: str | os.PathLike[str], *, timeout: float | None = DEFAULT_TIMEOUT
    ) -> None:
        """删除那台 Agent 上的文件 `path`。不删除目录；`path` 是符号链接时删除链接本身。
        文件不存在时抛出 `sfly.AgentFileNotFound`。"""
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


_TEMP_SEQ = itertools.count()


def local_write(local: LocalAgent, path: str, chunks: Iterable[bytes | memoryview]) -> FileInfo:
    """本地调试时的写入：先写临时文件再改名，规则与 Agent 相同。失败（包括 `chunks` 抛出异常、
    任务被取消）时删掉临时文件，目标不受影响。"""
    real = local.real(path)
    directory, name = os.path.split(real)
    if not posixpath.basename(path) or not name:
        raise local.invalid(f"{path} 不是文件路径")
    try:
        existing = os.lstat(real)
    except FileNotFoundError:
        mode = None
    except OSError as error:
        raise local.error(error, path) from None
    else:
        if stat_module.S_ISDIR(existing.st_mode):
            raise local.invalid(f"{path} 是目录：只能写入文件")
        regular = stat_module.S_ISREG(existing.st_mode)
        mode = stat_module.S_IMODE(existing.st_mode) if regular else None
    temp = os.path.join(
        directory,
        f".{name[:100]}.sfly-{os.getpid():x}-{next(_TEMP_SEQ):x}-{os.urandom(4).hex()}.tmp",
    )
    f: IO[bytes] | None = None
    try:
        # 临时文件一建出来就归下面的清理管：取消不会落在建出来和进入 try 之间。
        with DeferCancel():
            f = _create(local, path, temp)
        with f:
            for chunk in chunks:
                f.write(chunk)
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(temp, mode)
        os.replace(temp, real)
    except BaseException as error:
        # 包括 Cancelled、内容抛出的异常：删掉临时文件，目标不受影响。建临时文件失败时它不存在，
        # 删除也失败，不要紧（名字是随机的，不会是别人的文件）。
        if f is not None:
            f.close()
        try:
            os.unlink(temp)
        except OSError:
            pass
        if isinstance(error, OSError) and not isinstance(error, AgentError):
            raise local.error(error, path) from None
        raise
    return FileInfo.from_stat(path, os.stat(real))


def _create(local: LocalAgent, path: str, temp: str) -> IO[bytes]:
    """建临时文件（`O_EXCL`），错误与 Agent 上建临时文件时相同。"""
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o666)
    except OSError as error:
        parent = posixpath.dirname(path)
        raise local.error(
            error,
            path,
            missing=f"目录 {parent} 不存在",
            denied=f"没有权限写入 {path}",
            not_dir=f"{parent} 不是目录",
        ) from None
    return os.fdopen(fd, "wb")


def _local_delete(local: LocalAgent, path: str) -> None:
    """本地调试时的删除，规则与 Agent 相同。"""
    real = local.real(path)
    try:
        is_dir = stat_module.S_ISDIR(os.lstat(real).st_mode)
        if not is_dir:
            os.unlink(real)
    except OSError as error:
        raise local.error(error, path, denied=f"没有权限删除 {path}") from None
    if is_dir:
        raise local.invalid(f"{path} 是目录：只能删除文件")
