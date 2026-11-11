"""Agent 能力 files.read 的测试用节点（#199）：读取、下载，以及下载被取消。"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from sfly import AgentName, Cancelled, Context, FileInfo, node


def _info(file: FileInfo) -> dict[str, Any]:
    # 不从 sfly_agent_files 导入：联调测试给包改了名。
    return {
        "path": file.path,
        "size": file.size,
        "mtime_ns": file.mtime_ns,
        "device": file.id.device,
        "inode": file.id.inode,
    }


@node(title="读取文件", outputs=["size", "sha256", "first_line"])
def read_file(
    ctx: Context,
    path: str,
    source: AgentName | None = None,
    offset: int = 0,
    length: int | None = None,
) -> dict[str, Any]:
    """读取 source（不选时是自己所在的 Agent）上的文件，
    输出字节数、SHA-256 和第一行（开头 64 个字节以内）。"""
    digest = hashlib.sha256()
    size = 0
    head = b""
    for chunk in ctx.agent(source).files.read(path, offset, length):
        digest.update(chunk)
        size += len(chunk)
        if len(head) < 64:
            head += chunk[: 64 - len(head)]
    first_line = head.split(b"\n")[0].decode("utf-8", "replace")
    return {"size": size, "sha256": digest.hexdigest(), "first_line": first_line}


@node(title="下载文件", outputs=["file", "size", "sha256"])
def download_file(
    ctx: Context, path: str, local_path: str, source: AgentName | None = None
) -> dict[str, Any]:
    """把 source（不选时是自己所在的 Agent）上的文件下载到 local_path，输出源文件的属性、
    本地文件的字节数和 SHA-256。"""
    info = ctx.agent(source).files.download(path, local_path)
    data = Path(local_path).read_bytes()
    return {
        "file": _info(info),
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


@node(title="等待下载", outputs=[])
def wait_download(ctx: Context, path: str, local_path: str, source: AgentName) -> None:
    """不限超时地下载 source 上的文件（对方不回应时一直等），被取消时记一行日志再抛出。"""
    try:
        ctx.log.info("开始下载")
        ctx.agent(source).files.download(path, local_path, timeout=None)
    except Cancelled:
        ctx.log.info("下载被取消")
        raise
