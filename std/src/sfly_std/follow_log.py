"""`follow_log`：把日志文件新增的行实时转为任务日志，出现 `fail_on` 匹配的行时失败。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `follow_log` 一节；
读取日志文件的逻辑与 `wait_log_line` 共用（_logfile.py）。
"""

from __future__ import annotations

import re
import sys
import time
from collections.abc import Sequence
from typing import Literal, TypedDict

from sfly import Context, Metric, node
from sfly_std._logfile import LogFile

#: 检查新增内容的间隔（秒）。
POLL_INTERVAL = 0.2
#: 上报 `lines_per_s` 的间隔（秒）。
METRIC_INTERVAL = 1.0


class FollowLogOutputs(TypedDict):
    lines: int


class FailOnMatched(Exception):
    """日志里出现了匹配 `fail_on` 的行。"""


@node(
    title="跟随日志",
    metrics=[
        Metric("lines_per_s", unit="行/s", description="每秒新增的行数"),
        Metric("fail_matches", kind="counter", description="匹配 fail_on 的行数"),
    ],
    primary_metric="lines_per_s",
)
def follow_log(
    ctx: Context,
    path: str,
    read_from: Literal["end", "start"] = "end",
    fail_on: Sequence[str] = (),
    duration: float | None = None,
) -> FollowLogOutputs:
    """把日志文件 `path` 新增的行实时转为任务日志（来源 stdout）。

    - `read_from` 默认 `end`：从节点开始时的文件末尾跟起；`start` 先转发已有的内容；
    - `fail_on`：正则列表（`re.search`），有一行匹配任意一个时节点失败，错误信息附上这一行；
    - `duration`：跟随多少秒后成功结束；不设置时一直跟随，直到被停止子流程节点停止或运行被取消。

    文件还不存在时等它出现；文件被轮转或截断时继续跟随新的内容。
    指标 `lines_per_s`（每秒新增的行数，主指标）和 `fail_matches`（累计匹配 `fail_on` 的行数）；
    输出转发的总行数 `lines`。
    """
    if duration is not None and duration <= 0:
        raise ValueError(f"duration 必须大于 0，实际为 {duration:g}")
    patterns = []
    for i, pattern in enumerate(fail_on, 1):
        try:
            patterns.append(re.compile(pattern))
        except re.error as error:
            raise ValueError(f"fail_on 第 {i} 条不是合法的正则表达式：{error}：{pattern}") from None

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
            wake = min(window_start + METRIC_INTERVAL, now + POLL_INTERVAL)
            if deadline is not None:
                wake = min(wake, deadline)
            time.sleep(max(0.0, wake - now))
    finally:
        log.close()
    ctx.log.info("跟随结束，共 %d 行", total)
    return {"lines": total}
