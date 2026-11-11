"""Agent 能力 files.watch 的测试用节点（#201）：监听目录，记下快照和事件。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sfly import AgentName, Cancelled, Context, WatchSnapshot, node


@node(title="监听目录", outputs=["snapshots", "events"])
def watch_until(
    ctx: Context,
    directory: str,
    stop: str,
    source: AgentName | None = None,
    pattern: str = "*",
    recursive: bool = False,
    ready: str = "",
) -> dict[str, Any]:
    """监听 source（不选时是自己所在的 Agent）上的目录，直到新建了名为 `stop` 的文件。

    收到第一份快照后新建本机上的 `ready` 文件（测试据此开始改动目录）。输出每份快照的文件路径和
    是否可能有遗漏，以及每个事件的类型、路径、原路径和 inode。被取消时记一行日志再抛出。
    """
    try:
        return _watch(ctx, directory, stop, source, pattern, recursive, ready)
    except Cancelled:
        ctx.log.info("监听被取消")
        raise


def _watch(
    ctx: Context,
    directory: str,
    stop: str,
    source: str | None,
    pattern: str,
    recursive: bool,
    ready: str,
) -> dict[str, Any]:
    snapshots: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    for item in ctx.agent(source).files.watch(directory, pattern, recursive=recursive):
        if isinstance(item, WatchSnapshot):
            snapshots.append({"files": [f.path for f in item.files], "missed": item.missed})
            if ready and len(snapshots) == 1:
                Path(ready).write_text("ready\n", encoding="utf-8")
            continue
        events.append(
            {
                "kind": item.kind,
                "path": item.path,
                "old_path": item.old_path,
                "inode": item.id.inode,
            }
        )
        if item.kind == "created" and item.path.rsplit("/", 1)[-1] == stop:
            break
    return {"snapshots": snapshots, "events": events}
