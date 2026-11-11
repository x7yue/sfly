"""跨 Agent 下载产物的全栈测试用的节点（#195）。"""

from __future__ import annotations

import hashlib

from sfly import Context, node


@node(title="下载产物", outputs=["size", "sha256"])
def fetch_artifact(ctx: Context, ref: str) -> dict[str, object]:
    """用 SDK 把产物引用 ref 指向的产物下载到任务工作目录，返回它的字节数和 SHA-256。"""
    path = ctx.artifacts.download(ref, "downloaded.bin")
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return {"size": path.stat().st_size, "sha256": digest.hexdigest()}
