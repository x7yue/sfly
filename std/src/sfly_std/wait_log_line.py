"""`wait_log_line`：等日志文件里出现匹配正则的行。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `wait_log_line` 一节；
读取日志文件的逻辑与 `follow_log` 共用（_logfile.py）。
"""

from __future__ import annotations

import re
from typing import Literal, TypedDict

from sfly import Context, node
from sfly_std._logfile import LogFile
from sfly_std._waiting import DEFAULT_POLL, DEFAULT_WAIT, poll_until, validate


class WaitLogLineOutputs(TypedDict):
    line: str


@node(title="等待日志行")
def wait_log_line(
    ctx: Context,
    path: str,
    pattern: str,
    read_from: Literal["end", "start"] = "end",
    wait: float = DEFAULT_WAIT,
    poll: float = DEFAULT_POLL,
) -> WaitLogLineOutputs:
    """每 `poll` 秒（默认 1）读取日志文件 `path` 新增的行，有一行匹配正则 `pattern`（`re.search`，
    匹配行内任意位置）就成功，输出这一行 `line`；`wait` 秒（默认 300）内没有出现时失败。

    `read_from` 默认 `end`：只看节点开始之后新写入的内容，旧日志不会误触发；`start` 从文件开头看起。
    文件还不存在时等它出现；文件被轮转或截断时继续读新的内容。
    """
    validate(wait, poll)
    try:
        regex = re.compile(pattern)
    except re.error as error:
        raise ValueError(f"pattern 不是合法的正则表达式：{error}：{pattern}") from None
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
    return {"line": line}
