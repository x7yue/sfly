"""Agent 能力（ADR 0019）：节点在执行中调用 Agent 自身提供的操作。只用标准库（ADR 0002）。

`ctx.agent()` 是节点自己所在的 Agent，`ctx.agent(名称)` 是通过「Agent」类型的参数拿到的
另一台 Agent，两者是同一种对象（`Agent`），能力按组挂在上面（`files`）。调用另一台 Agent 时，
SDK 把调用交给自己所在的 Agent（本地 socket，`channel.py`），由它连到那台 Agent，
数据不经过控制面。本地调试时没有 Agent，直接操作本机的文件系统（`local.py`）。

模块：

- `errors.py`：调用失败的异常；
- `channel.py`：经本地 socket 调用自己所在的 Agent；
- `local.py`：本地调试时的 Agent（名称映射到本地目录）；
- `files.py`、`files_list.py`：能力 files；
- `files_watch.py`、`files_watch_local.py`：监听目录（`files.watch`）；
- `exec.py`：能力 exec（执行命令）。

加一项能力：新建模块写它的类（构造时拿到 `Agent`，用 `Agent._call` 调用、
用 `Agent._local` 判断是不是本地调试），在 `Agent.__init__` 里挂上。
给已有能力加一组操作见 `files.py`。
"""

from __future__ import annotations

import os
from collections.abc import Collection, Mapping
from typing import Any

from sfly.capabilities.errors import (
    AgentError,
    AgentFileNotFound,
    AgentNotReferenced,
    AgentPermissionDenied,
    AgentTimeout,
    AgentUnreachable,
    AgentUnsupported,
)
from sfly.capabilities.exec import Exec
from sfly.capabilities.files import FileId, FileInfo, Files
from sfly.capabilities.files_watch import FileEvent, WatchSnapshot

__all__ = [
    "Agent",
    "AgentError",
    "AgentFileNotFound",
    "AgentNotReferenced",
    "AgentPermissionDenied",
    "AgentTimeout",
    "AgentUnreachable",
    "AgentUnsupported",
    "Exec",
    "FileEvent",
    "FileId",
    "FileInfo",
    "Files",
    "WatchSnapshot",
]


class Agent:
    """一台 Agent 的能力：`ctx.agent()`（自己所在的 Agent）或 `ctx.agent(名称)`（另一台）。

    - `name`：Agent 名称；自己所在的 Agent 为 None；
    - `files`：文件（见 `Files`）；
    - `exec`：执行命令（见 `Exec`）。
    """

    def __init__(
        self,
        name: str | None,
        *,
        socket: Any = None,
        local_mapping: Mapping[str, str] | None = None,
        referenced: Collection[str] = (),
    ) -> None:
        self.name = name
        # 在 Agent 上：本地 socket（`channel.AgentSocket`）；本地调试：映射表和参数里引用的 Agent。
        self._socket = socket
        self._mapping = local_mapping
        self._referenced = referenced
        self.files = Files(self)
        self.exec = Exec(self)

    def __repr__(self) -> str:
        return f"Agent({self.name!r})" if self.name is not None else "Agent(自己所在的 Agent)"

    def _local(self) -> Any:
        """本地调试时的这台 Agent（`local.LocalAgent`）；在 Agent 上为 None。"""
        if self._socket is not None:
            return None
        from sfly.capabilities.local import LocalAgent

        return LocalAgent.resolve(self.name, self._mapping or {}, self._referenced)

    def _call(
        self,
        method: str,
        args: dict[str, Any],
        timeout: float | None,
        *,
        margin: float | None = None,
    ) -> Any:
        """经自己所在的 Agent 发起调用，返回 `channel.Call`（用 `with` 管理）。
        `margin` 见 `channel.AgentSocket.call`，不给时用默认值。"""
        self._check_timeout(timeout)
        if margin is None:
            return self._socket.call(self.name, method, args, timeout)
        return self._socket.call(self.name, method, args, timeout, margin=margin)

    @staticmethod
    def _check_timeout(timeout: float | None) -> None:
        """调用的 `timeout`：大于 0 的秒数，或 None（不限）。"""
        if timeout is not None and not timeout > 0:
            raise ValueError(f"timeout 必须大于 0（不限时传 None），收到 {timeout!r}")


def connect(
    name: str | None,
    *,
    task_id: str,
    attempt: int,
    referenced: Collection[str],
    cancelled: Any,
) -> Agent:
    """按执行器的环境变量给出一台 Agent：有 `SFLY_AGENT_SOCKET`（在 Agent 上）时经本地 socket 调用；
    否则是本地调试，`SFLY_LOCAL_AGENTS` 是名称到本地目录的映射表（没有时只有本机）。"""
    if name is not None and (not isinstance(name, str) or not name):
        raise ValueError(
            f"Agent 名称必须是非空字符串（自己所在的 Agent 用 ctx.agent()），收到 {name!r}"
        )
    path = os.environ.get("SFLY_AGENT_SOCKET")
    if path:
        from sfly.capabilities.channel import AgentSocket

        return Agent(name, socket=AgentSocket(path, task_id, attempt, cancelled))
    from sfly.capabilities.local import read_mapping

    table = os.environ.get("SFLY_LOCAL_AGENTS")
    return Agent(name, local_mapping=read_mapping(table) if table else {}, referenced=referenced)
