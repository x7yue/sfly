"""Agent 能力 files 的测试用节点（#198）：列出、查看属性，并把调用失败的异常原样报告出来。"""

from __future__ import annotations

from typing import Any

from sfly import AgentError, AgentName, Cancelled, Context, FileInfo, node


def _info(file: FileInfo) -> dict[str, Any]:
    return {
        "path": file.path,
        "size": file.size,
        "mtime_ns": file.mtime_ns,
        "device": file.id.device,
        "inode": file.id.inode,
    }


@node(title="列出文件", outputs=["files"])
def list_files(
    ctx: Context,
    directory: str,
    source: AgentName | None = None,
    pattern: str = "*",
    recursive: bool = False,
) -> dict[str, Any]:
    """列出 source（不选时是自己所在的 Agent）上的文件。"""
    files = ctx.agent(source).files.list(directory, pattern, recursive=recursive)
    return {"files": [_info(f) for f in files]}


@node(title="查看属性", outputs=["file"])
def stat_file(ctx: Context, path: str, source: AgentName | None = None) -> dict[str, Any]:
    """查看 source（不选时是自己所在的 Agent）上一个文件的属性。"""
    return {"file": _info(ctx.agent(source).files.stat(path))}


@node(title="尝试访问", outputs=["error"])
def try_stat(
    ctx: Context,
    path: str,
    source: AgentName | None = None,
    name: str = "",
    timeout: float | None = 30,
) -> dict[str, Any]:
    """查看 `name`（为空时是 source）上一个文件的属性；失败时输出异常的类型、原因、Agent 和消息。"""
    try:
        ctx.agent(name or source).files.stat(path, timeout=timeout)
    except AgentError as error:
        return {
            "error": {
                "type": type(error).__name__,
                "kind": error.kind,
                "agent": error.agent,
                "message": str(error),
            }
        }
    return {"error": None}


@node(title="等待调用", outputs=[])
def wait_stat(ctx: Context, path: str, source: AgentName) -> None:
    """不限超时地查看 source 上的文件（对方不回应时一直等），被取消时记一行日志再抛出。"""
    try:
        ctx.log.info("开始调用")
        ctx.agent(source).files.stat(path, timeout=None)
    except Cancelled:
        ctx.log.info("调用被取消")
        raise
