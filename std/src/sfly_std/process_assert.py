"""`process_assert`：检查一次进程的状态（在或不在、数量）。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `process_assert` 一节。
"""

from __future__ import annotations

import os
from typing import TypedDict

import psutil

from sfly import Context, node
from sfly_std import _process

#: 失败信息里最多列出多少个进程。
LIST_LIMIT = 20
#: 输出 `pids` 最多列出多少个进程号（节点输出不能超过 1 MB）；`count` 不受影响。
PIDS_LIMIT = 1000


class ProcessAssertOutputs(TypedDict):
    passed: bool
    count: int
    pids: list[int]


class ProcessAssertionFailed(Exception):
    """进程的状态与期望不符。"""


@node(title="进程断言")
def process_assert(
    ctx: Context,
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

    通过时输出 `passed`（true）、匹配的进程数 `count` 和进程号 `pids`（从小到大，最多 1000 个）；
    不通过时失败，写明期望与实际，并列出匹配到的进程。
    """
    targets = _process.targets(pid, name, match)
    if count is not None and count < 0:
        raise ValueError(f"count 不能是负数，实际为 {count}")
    if not running and count:
        raise ValueError(f"running 为 false 时 count 只能是 0 或不填，实际为 {count}")

    found = []
    for proc in _candidates(pid):
        if proc.pid == os.getpid() or not _process.alive(proc):
            continue
        try:
            proc_name, command = proc.name(), _process.cmdline(proc)
        except psutil.NoSuchProcess:
            continue
        if all(t.matches(proc, proc_name, command) for t in targets):
            found.append((proc.pid, proc_name, command))
    found.sort()

    subject = f"{' 且 '.join(t.label for t in targets)} 的进程"
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
    if len(found) > PIDS_LIMIT:
        ctx.log.warn("匹配到 %d 个进程，输出 pids 只列出 pid 最小的 %d 个", len(found), PIDS_LIMIT)
    pids = [p for p, _, _ in found[:PIDS_LIMIT]]
    return {"passed": True, "count": len(found), "pids": pids}


def _candidates(pid: int | None) -> list[psutil.Process]:
    if pid is None:
        return list(psutil.process_iter())
    try:
        return [psutil.Process(pid)]
    except psutil.NoSuchProcess:
        return []


def _list(found: list[tuple[int, str, str]]) -> str:
    lines = [
        f"- pid {pid} {name}：{_process.preview(command)}"
        for pid, name, command in found[:LIST_LIMIT]
    ]
    if len(found) > LIST_LIMIT:
        lines.append(f"- ……还有 {len(found) - LIST_LIMIT} 个")
    return "\n".join(lines)
