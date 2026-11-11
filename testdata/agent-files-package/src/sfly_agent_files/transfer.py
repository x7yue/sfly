"""性能基准「两台 Agent 之间传输大文件」用的节点：
apps/server/perf/items/11-agent-file-transfer.ts。
"""

from __future__ import annotations

import time
from typing import Any

from sfly import AgentName, Context, node


@node(title="计时下载", outputs=["size", "seconds"])
def timed_download(ctx: Context, source: AgentName, path: str, local_path: str) -> dict[str, Any]:
    """把 source 上的文件下载到 local_path，输出字节数和下载用了多少秒
    （只计 files.download 本身）。"""
    started = time.monotonic()
    info = ctx.agent(source).files.download(path, local_path)
    return {"size": info.size, "seconds": time.monotonic() - started}
