"""`sfly dev`：让本机 Agent 以可编辑方式加载本地源码目录，作为该节点包的开发版本 `包名@dev`。

流程：
1. 和 `sfly build` 一样读取项目、扫描 `@node`、校验元信息；
2. 构建一个可编辑 wheel（不含源文件，只有指向源码目录的 `.pth`；dist-info 里的
   `sfly-package.json` 的 version 为 `dev`）；
3. 通过 Agent 的本地 socket（Unix domain socket，只在本机可见，Agent 不对外开放任何端口）
   把请求交给 Agent，由 Agent 安装进共享 venv、登记并上报控制面；等待 Agent 的回复。

本地 socket 协议：客户端连接后发送一行 JSON 请求，Agent 回复一行 JSON 后关闭连接。
    请求 `{"command": "dev", "package": 包名, "source": 项目目录, "wheel": 可编辑 wheel 路径,
           "metadata": 元信息}`
    回复 `{"ok": true|false, "message": 说明, "output": 安装输出}`
Agent 在回复前把 wheel 复制到自己的工作目录，回复之后客户端即可删除临时文件。
"""

from __future__ import annotations

import json
import socket
import tempfile
from pathlib import Path
from typing import Any

from sfly.cli.build import METADATA_FILE, load_project, scan_nodes, validate_metadata
from sfly.cli.wheel import build_wheel

DEV_VERSION = "dev"
SOCKET_FILE = "agent.sock"


class DevError(Exception):
    def __init__(self, message: str, output: str = "") -> None:
        super().__init__(message)
        self.output = output


def _wheel_version(version: str) -> str:
    """可编辑 wheel 的版本：在项目版本上加本地版本标记 dev（wheel 版本必须符合 PEP 440）。"""
    return f"{version}.dev" if "+" in version else f"{version}+dev"


def request(socket_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    """向 Agent 的本地 socket 发送一个请求并等待回复。"""
    if not hasattr(socket, "AF_UNIX"):
        raise DevError("这个平台不支持本地 socket，无法连接 Agent")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        try:
            conn.connect(str(socket_path))
        except OSError as error:
            raise DevError(
                f"无法连接本机 Agent 的本地 socket {socket_path}（{error.strerror or error}）；"
                "确认 Agent 正在运行，并用 --socket 指定它的 socket"
                "（默认按 Agent 的 SFLY_DEV_SOCKET、SFLY_WORK_DIR 配置找，"
                "都没有时 $SFLY_HOME/work/agent.sock）"
            ) from error
        conn.sendall(json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
        conn.shutdown(socket.SHUT_WR)
        chunks = []
        while chunk := conn.recv(65536):
            chunks.append(chunk)
    try:
        reply: dict[str, Any] = json.loads(b"".join(chunks).decode("utf-8"))
    except ValueError as error:
        raise DevError("Agent 的回复无法解析（Agent 是否已退出？）") from error
    return reply


def dev(root: Path, socket_path: Path) -> dict[str, Any]:
    """让 Agent 加载开发版本；返回 Agent 的回复（成功时）。"""
    project = load_project(root)
    metadata = {
        "name": project.name,
        "version": project.version,
        "requires_python": project.requires_python,
        "nodes": scan_nodes(project),
    }
    validate_metadata(metadata)
    metadata["version"] = DEV_VERSION
    text = json.dumps(metadata, ensure_ascii=False, indent=2) + "\n"
    with tempfile.TemporaryDirectory() as tmp:
        wheel = build_wheel(
            name=project.name,
            version=_wheel_version(project.version),
            requires_python=project.requires_python,
            dependencies=project.dependencies,
            source=project.source,
            out_dir=Path(tmp),
            extra_metadata={METADATA_FILE: text.encode("utf-8")},
            editable_root=project.source_root,
        )
        reply = request(
            socket_path,
            {
                "command": "dev",
                "package": project.name,
                "source": str(project.root.resolve()),
                "wheel": str(wheel),
                "metadata": metadata,
            },
        )
    if not reply.get("ok"):
        raise DevError(
            str(reply.get("message") or "Agent 拒绝了请求"), str(reply.get("output", ""))
        )
    return reply
