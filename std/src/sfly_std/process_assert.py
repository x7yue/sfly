"""`process_assert`：检查一次进程的状态（在或不在、数量）。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `process_assert` 一节。
"""

from __future__ import annotations

import json
import os
import re
from typing import TypedDict

import psutil

from sfly import node

#: 失败信息里最多列出多少个进程。
LIST_LIMIT = 20
#: 失败信息里命令行的最大字符数。
CMDLINE_PREVIEW_CHARS = 200


class ProcessAssertOutputs(TypedDict):
    passed: bool
    count: int
    pids: list[int]


class ProcessAssertionFailed(Exception):
    """进程的状态与期望不符。"""


@node(title="进程断言")
def process_assert(
    pid: int | None = None,
    name: str | None = None,
    match: str | None = None,
    running: bool = True,
    count: int | None = None,
) -> ProcessAssertOutputs:
    """检查一次匹配的进程，不等待。

    - 条件：`pid`（进程号）、`name`（进程名，完全相同）、`match`（命令行正则，部分匹配即可），
      至少给出一个；同时给出几个时，进程要全部满足；
    - `running`（默认 true）：应至少有一个匹配的进程；为 false 时应一个都没有；
    - `count`：应恰好有这么多个匹配的进程（给出时代替 `running` 的检查）。

    通过时输出 `passed`（true）、匹配的进程数 `count` 和进程号 `pids`；不通过时失败，
    写明期望与实际，并列出匹配到的进程。
    """
    labels = []
    if pid is not None:
        labels.append(f"pid {pid}")
    if name is not None:
        labels.append(f"name {json.dumps(name, ensure_ascii=False)}")
    if match is not None:
        labels.append(f"match {json.dumps(match, ensure_ascii=False)}")
    if not labels:
        raise ValueError("至少要给出 pid、name、match 中的一个")
    if pid is not None and pid <= 0:
        raise ValueError(f"pid 必须是正整数，实际为 {pid}")
    if count is not None and count < 0:
        raise ValueError(f"count 不能是负数，实际为 {count}")
    if not running and count:
        raise ValueError(f"running 为 false 时 count 只能是 0 或不填，实际为 {count}")
    try:
        regex = re.compile(match) if match is not None else None
    except re.error as error:
        raise ValueError(f"match 不是合法的正则表达式：{match!r}（{error}）") from None

    found = []
    for proc in _candidates(pid):
        try:
            if proc.pid == os.getpid() or proc.status() == psutil.STATUS_ZOMBIE:
                continue
            if name is not None and proc.name() != name:
                continue
            cmdline = _cmdline(proc)
            if regex is not None and not regex.search(cmdline):
                continue
            found.append((proc.pid, proc.name(), cmdline))
        except psutil.NoSuchProcess:
            continue
    found.sort()

    subject = f"{' 且 '.join(labels)} 的进程"
    if count is not None:
        if len(found) != count:
            listed = f"：\n{_list(found)}" if found else ""
            raise ProcessAssertionFailed(
                f"{subject}应有 {count} 个，实际有 {len(found)} 个{listed}"
            )
    elif running and not found:
        raise ProcessAssertionFailed(f"{subject}应在运行，实际没有找到")
    elif not running and found:
        raise ProcessAssertionFailed(
            f"{subject}应不在运行，实际有 {len(found)} 个：\n{_list(found)}"
        )
    return {"passed": True, "count": len(found), "pids": [p for p, _, _ in found]}


def _candidates(pid: int | None) -> list[psutil.Process]:
    if pid is None:
        return list(psutil.process_iter())
    try:
        return [psutil.Process(pid)]
    except psutil.NoSuchProcess:
        return []


def _cmdline(proc: psutil.Process) -> str:
    try:
        return " ".join(proc.cmdline())
    except psutil.AccessDenied:
        return ""


def _list(found: list[tuple[int, str, str]]) -> str:
    lines = [
        f"- pid {pid} {name}：{_preview(cmdline)}" for pid, name, cmdline in found[:LIST_LIMIT]
    ]
    if len(found) > LIST_LIMIT:
        lines.append(f"- ……还有 {len(found) - LIST_LIMIT} 个")
    return "\n".join(lines)


def _preview(cmdline: str) -> str:
    if len(cmdline) > CMDLINE_PREVIEW_CHARS:
        return cmdline[:CMDLINE_PREVIEW_CHARS] + "…"
    return cmdline
