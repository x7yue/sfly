"""读取日志文件新增的行（`wait_log_line` 与 `follow_log` 共用）。

像 `tail -F`：文件还不存在时等它出现（出现后从头读）；文件被轮转（路径指向了另一个文件，
例如 logrotate 改名后新建）时先读完旧文件剩下的内容，再从头读新文件；文件被截断
（例如 logrotate 的 copytruncate）时从头读。只按「检查时」的状态判断：两次检查之间被截断
又写到超过原来的长度时，截断前后的差别看不出来。
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import BinaryIO

#: 每次读取的字节数。
CHUNK_BYTES = 64 * 1024
#: 一行最长的字节数：超过时不等换行符，先把已读到的内容当作一行。
MAX_LINE_BYTES = 64 * 1024


class LogFile:
    """`lines()` 返回上次调用以来新增的完整行（不含换行符，按 UTF-8 解码，无法解码的字节替换为 �）。

    `from_start` 为 False 时只读创建时之后新写入的内容；创建时文件不存在的，出现后的内容都算新的。
    最后一行还没写完（没有换行符）时留到下次；`flush()` 返回这样留下的半行。
    """

    def __init__(self, path: str, *, from_start: bool) -> None:
        self.path = path
        self._file: BinaryIO | None = None
        self._ident: tuple[int, int] | None = None
        self._pending = bytearray()
        if self._open() and not from_start:
            assert self._file is not None
            self._file.seek(0, os.SEEK_END)

    def exists(self) -> bool:
        """正在读的文件存在（创建以来出现过，且没有被删掉）。"""
        return self._file is not None and os.path.exists(self.path)

    def lines(self) -> Iterator[str]:
        if self._file is not None:
            if os.fstat(self._file.fileno()).st_size < self._file.tell():
                yield from self.flush()  # 被截断：截断前没写完的半行不会再有后续
                self._file.seek(0)
            yield from self._read()
        try:
            st = os.stat(self.path)
        except FileNotFoundError:
            return  # 被删掉（还没重建）或还没出现：继续读已经打开的旧文件
        if (st.st_dev, st.st_ino) != self._ident:
            yield from self.flush()
            self.close()
            if self._open():
                yield from self._read()

    def flush(self) -> Iterator[str]:
        if self._pending:
            yield _decode(self._pending)
            self._pending.clear()

    def close(self) -> None:
        if self._file is not None:
            self._file.close()
            self._file, self._ident = None, None

    def _open(self) -> bool:
        try:
            self._file = open(self.path, "rb", buffering=0)  # noqa: SIM115
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
            return False
        st = os.fstat(self._file.fileno())
        self._ident = (st.st_dev, st.st_ino)
        return True

    def _read(self) -> Iterator[str]:
        assert self._file is not None
        while chunk := self._file.read(CHUNK_BYTES):
            self._pending += chunk
            *complete, rest = self._pending.split(b"\n")
            for line in complete:
                yield _decode(line)
            self._pending[:] = rest
            if len(self._pending) > MAX_LINE_BYTES:
                yield from self.flush()


def _decode(line: bytes | bytearray) -> str:
    return bytes(line).removesuffix(b"\r").decode("utf-8", errors="replace")
