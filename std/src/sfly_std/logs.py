"""读日志文件：像 `tail -F` 一样读新增的行，跟随日志转为任务日志，等日志里出现某一行。

- `LogFile`：读日志文件新增的行。文件还不存在时等它出现（出现后从头读）；文件被轮转（路径指向了
  另一个文件，例如 logrotate 改名后新建）时先读完旧文件剩下的内容，再从头读新文件；文件被截断
  （例如 logrotate 的 copytruncate）时从头读。只按「检查时」的状态判断：两次检查之间被截断又写到
  超过原来的长度时，截断前后的差别看不出来；
- `follow_log_file`：把新增的行实时转为任务日志，出现匹配 `fail_on` 的行时失败，并上报每秒行数
  的指标；
- `wait_for_log_line`：等日志里出现匹配正则的行，用来等被测系统打出就绪日志。
"""

from __future__ import annotations

import os
import sys
import time
from collections.abc import Iterator, Sequence
from typing import BinaryIO, Literal

from sfly import Context, Metric
from sfly_std import _params
from sfly_std._sampling import validate_duration
from sfly_std.waiting import DEFAULT_POLL, DEFAULT_WAIT, poll_until, validate

__all__ = [
    "FOLLOW_METRICS",
    "FailOnMatched",
    "LogFile",
    "follow_log_file",
    "wait_for_log_line",
]

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


#: 检查新增内容的间隔（秒）。
FOLLOW_POLL_INTERVAL = 0.2
#: 上报 `lines_per_s` 的间隔（秒）。
METRIC_INTERVAL = 1.0

#: `follow_log_file` 上报的指标：自己的节点用 `@node(metrics=FOLLOW_METRICS,
#: primary_metric="lines_per_s")` 声明。
FOLLOW_METRICS = [
    Metric("lines_per_s", unit="行/s", description="每秒新增的行数"),
    Metric("fail_matches", kind="counter", description="累计匹配 fail_on 的行数"),
]


class FailOnMatched(Exception):
    """日志里出现了匹配 `fail_on` 的行。"""


def follow_log_file(
    ctx: Context,
    path: str,
    *,
    read_from: Literal["end", "start"] = "end",
    fail_on: Sequence[str] = (),
    duration: float | None = None,
) -> int:
    """把日志文件新增的行实时转为任务日志，出现匹配的错误行时失败；返回转发的总行数。

    行写到执行器自己的标准输出（Agent 实时转为任务日志）。`read_from` 为 `"end"` 时从调用时的文件
    末尾开始，`"start"` 时先转发文件里已有的内容；文件还不存在时等它出现，被轮转或截断时继续跟随
    新的内容。`fail_on` 是正则表达式列表（`re.search`）：有一行匹配其中任意一个时抛出
    `FailOnMatched`，信息附上第一行匹配的内容和匹配的正则；不合法的正则抛出 `ValueError`。

    `duration` 秒后成功返回；不设置时一直跟随，直到任务被取消（`sfly.Cancelled` 从 `time.sleep`
    里抛出，已转发的行都留在任务日志里）。按 `FOLLOW_METRICS` 上报指标（调用方的节点要声明它们）。
    """
    validate_duration(duration)
    patterns = [_params.regex(f"fail_on 第 {i} 条", p) for i, p in enumerate(fail_on, 1)]

    log = LogFile(path, from_start=read_from == "start")
    out = sys.stdout.buffer
    total = matches = window_lines = 0
    started = window_start = time.monotonic()
    deadline = started + duration if duration is not None else None
    first_match: tuple[str, str] | None = None  # (正则, 行)

    def forward(lines: Sequence[str]) -> None:
        nonlocal total, matches, window_lines, first_match
        for line in lines:
            out.write(line.encode("utf-8") + b"\n")
            for regex in patterns:
                if regex.search(line):
                    matches += 1
                    if first_match is None:
                        first_match = (regex.pattern, line)
                    break
        out.flush()
        total += len(lines)
        window_lines += len(lines)

    def report(now: float) -> None:
        nonlocal window_lines, window_start
        ctx.metric("lines_per_s", window_lines / max(now - window_start, 1e-6))
        ctx.metric("fail_matches", matches)
        window_lines, window_start = 0, now

    try:
        how = "从头" if read_from == "start" else "从末尾"
        until = f"{duration:g} 秒" if duration is not None else "直到被停止"
        ctx.log.info("跟随日志 %s（%s开始，%s）", path, how, until)
        if not log.exists():
            ctx.log.info("文件 %s 还不存在，出现后开始跟随", path)
        while True:
            # 取消时 Cancelled 从 sleep 里抛出，已转发的行都在任务日志里。
            forward(list(log.lines()))
            now = time.monotonic()
            finished = deadline is not None and now >= deadline
            if finished:
                forward(list(log.flush()))
            if first_match is not None or finished or now - window_start >= METRIC_INTERVAL:
                report(now)
            if first_match is not None:
                pattern, line = first_match
                more = f"（共 {matches} 行匹配）" if matches > 1 else ""
                raise FailOnMatched(f"日志 {path} 出现匹配 fail_on {pattern} 的行{more}：{line}")
            if finished:
                break
            wake = min(window_start + METRIC_INTERVAL, now + FOLLOW_POLL_INTERVAL)
            if deadline is not None:
                wake = min(wake, deadline)
            time.sleep(max(0.0, wake - now))
    finally:
        log.close()
    ctx.log.info("跟随结束，共 %d 行", total)
    return total


def wait_for_log_line(
    ctx: Context,
    path: str,
    pattern: str,
    *,
    read_from: Literal["end", "start"] = "end",
    wait: float = DEFAULT_WAIT,
    poll: float = DEFAULT_POLL,
) -> str:
    """等日志文件里出现匹配正则（`re.search`，要匹配整行用 `^...$`）的行，返回第一行匹配的内容。

    返回的内容不含换行符。`read_from` 为 `"end"` 时只看调用之后新写入的内容，`"start"` 时从文件
    开头看起。文件还不存在时等它出现，被轮转或截断时继续读新的内容。

    `wait` 秒内没有出现时抛出 `TimeoutError`，信息写明文件、正则和等了多久，文件一直不存在时注明
    「文件不存在」；`pattern` 不是合法的正则时抛出 `ValueError`。
    """
    validate(wait, poll)
    regex = _params.regex("pattern", pattern)
    log = LogFile(path, from_start=read_from == "start")
    try:
        ctx.log.info("等待日志 %s 出现匹配 %s 的行，最多 %g 秒", path, pattern, wait)

        def check() -> str | None:
            return next((line for line in log.lines() if regex.search(line)), None)

        line, waited = poll_until(
            check,
            what=f"日志 {path} 出现匹配 {pattern} 的行",
            wait=wait,
            poll=poll,
            detail=lambda: "" if log.exists() else "文件不存在",
        )
    finally:
        log.close()
    ctx.log.info("等了 %.1f 秒，匹配到：%s", waited, line)
    return line
