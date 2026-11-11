"""Agent 能力 files.write 的测试用节点（#200）：写入、上传、删除，失败时把异常原样报告出来；
以及写到一半出错、写到一半被取消的写入。"""

from __future__ import annotations

import time
from collections.abc import Iterator
from typing import Any

from sfly import AgentError, AgentName, Context, FileInfo, node


def _info(file: FileInfo) -> dict[str, Any]:
    # 不从包的 __init__ 导入：联调测试会把包改名（full-stack-agent-files.test.ts）。
    return {
        "path": file.path,
        "size": file.size,
        "mtime_ns": file.mtime_ns,
        "device": file.id.device,
        "inode": file.id.inode,
    }


def _error(error: AgentError) -> dict[str, Any]:
    return {
        "type": type(error).__name__,
        "kind": error.kind,
        "agent": error.agent,
        "message": str(error),
    }


@node(title="写入文件", outputs=["file", "error"])
def write_file(
    ctx: Context, path: str, text: str, source: AgentName | None = None, pieces: int = 1
) -> dict[str, Any]:
    """把 text 分成 pieces 段流式写到 source（不选时是自己所在的 Agent）上的 path。"""
    data = text.encode("utf-8")
    step = max(1, -(-len(data) // max(1, pieces)))

    def chunks() -> Iterator[bytes]:
        for start in range(0, len(data), step):
            yield data[start : start + step]

    try:
        return {"file": _info(ctx.agent(source).files.write(path, chunks())), "error": None}
    except AgentError as error:
        return {"file": None, "error": _error(error)}


@node(title="上传文件", outputs=["file", "error"])
def upload_file(
    ctx: Context, path: str, text: str, source: AgentName | None = None
) -> dict[str, Any]:
    """把 text 写进任务目录里的 upload.txt，再用相对路径把它上传成 source 上的 path。"""
    with open("upload.txt", "w", encoding="utf-8") as f:
        f.write(text)
    try:
        return {"file": _info(ctx.agent(source).files.upload("upload.txt", path)), "error": None}
    except AgentError as error:
        return {"file": None, "error": _error(error)}


@node(title="删除文件", outputs=["error"])
def delete_file(ctx: Context, path: str, source: AgentName | None = None) -> dict[str, Any]:
    """删除 source 上的 path。"""
    try:
        ctx.agent(source).files.delete(path)
    except AgentError as error:
        return {"error": _error(error)}
    return {"error": None}


@node(title="写到一半出错", outputs=[])
def write_then_fail(ctx: Context, path: str, source: AgentName | None = None) -> None:
    """写出第一段之后，生成内容的代码抛出异常。"""

    def chunks() -> Iterator[bytes]:
        yield b"first part\n"
        raise RuntimeError("生成内容失败")

    ctx.agent(source).files.write(path, chunks())


@node(title="写到一半等待", outputs=[])
def write_until_cancelled(ctx: Context, path: str, source: AgentName | None = None) -> None:
    """写出第一段之后一直等（直到任务被取消）。"""

    def chunks() -> Iterator[bytes]:
        yield b"first part\n" * 1000
        ctx.log.info("已发出第一段")
        while True:
            time.sleep(1)

    ctx.agent(source).files.write(path, chunks(), timeout=None)
