"""`follow_log`：把日志文件新增的行实时转为任务日志，出现 `fail_on` 匹配的行时失败。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `follow_log` 一节；
读取日志文件的逻辑与 `wait_log_line` 共用（_logfile.py）。
"""

from __future__ import annotations

import sys
import time
from collections.abc import Sequence
from typing import Annotated, Literal, TypedDict

from sfly import Context, Doc, Metric, node
from sfly_std import _params
from sfly_std._logfile import LogFile
from sfly_std._sampling import validate_duration

#: 检查新增内容的间隔（秒）。
POLL_INTERVAL = 0.2
#: 上报 `lines_per_s` 的间隔（秒）。
METRIC_INTERVAL = 1.0


class FollowLogOutputs(TypedDict):
    lines: Annotated[int, Doc("转发的总行数（duration 到期时才有输出）")]


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
    path: Annotated[str, Doc("日志文件路径；相对路径相对于任务工作目录")],
    # 不叫 from：节点参数就是函数参数，而 from 是 Python 关键字。
    read_from: Annotated[
        Literal["end", "start"],
        Doc("从哪里开始跟随：end 从节点开始时的文件末尾，start 先转发文件里已有的内容"),
    ] = "end",
    fail_on: Annotated[
        Sequence[str], Doc("正则表达式列表（re.search）：有一行匹配其中任意一个时节点失败")
    ] = (),
    duration: Annotated[
        float | None,
        Doc("跟随多少秒后成功结束；不设置时一直跟随，直到被停止子流程节点停止或运行被取消"),
    ] = None,
) -> FollowLogOutputs:
    """把日志文件新增的行实时转为任务日志，出现匹配的错误行时失败。

    副作用：只读取日志文件，不改动它；转发的行写进任务日志。
    文件还不存在时等它出现；文件被轮转或截断时继续跟随新的内容。
    不设置 duration 时一直跟随，直到被停止子流程节点停止或运行被取消。
    被停止时不算失败，已经转发的行都留在任务日志里。

    失败：有一行匹配 fail_on 里的任意一个正则时立即失败，错误信息附上第一行匹配的内容和匹配的正则。
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
            wake = min(window_start + METRIC_INTERVAL, now + POLL_INTERVAL)
            if deadline is not None:
                wake = min(wake, deadline)
            time.sleep(max(0.0, wake - now))
    finally:
        log.close()
    ctx.log.info("跟随结束，共 %d 行", total)
    return {"lines": total}
