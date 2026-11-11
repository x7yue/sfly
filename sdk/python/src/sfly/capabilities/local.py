"""本地调试时的 Agent 能力（`sfly run`、`sfly.testing.run_node`）：没有 Agent，
直接操作本机的文件系统。只用标准库（ADR 0002）。

- 自己所在的 Agent（`ctx.agent()`）就是本机：路径原样使用；
- 其它 Agent 由测试工具映射到本地目录（`run_node(agents={名称: 目录})`、
  `sfly run --agent 名称=目录`）：那台 Agent 上的绝对路径 `/var/log/app.log` 对应
  `<目录>/var/log/app.log`，返回的路径再换回那台 Agent 上的写法；
- 和在 Agent 上一样只能访问通过「Agent」类型的参数拿到的 Agent：参数里没有的名称抛出
  `AgentNotReferenced`，参数里有但没有映射的抛出 `AgentUnreachable`（提示怎样映射）。

映射表是执行器的环境变量 `SFLY_LOCAL_AGENTS` 指向的 JSON 文件（名称 → 本地目录的绝对路径），
由 `sfly.local` 写；设置了它就是本地调试。每项能力在自己的模块里用 `LocalAgent` 实现本地版本。
"""

from __future__ import annotations

import json
import os
from collections.abc import Collection, Mapping

from sfly.capabilities.errors import (
    AgentError,
    AgentFileNotFound,
    AgentNotReferenced,
    AgentPermissionDenied,
    AgentUnreachable,
)


def read_mapping(path: str | os.PathLike[str]) -> dict[str, str]:
    """读映射表（名称 → 本地目录）；不认识的内容视为空表。"""
    try:
        with open(path, encoding="utf-8") as f:
            table = json.loads(f.read())
    except (OSError, ValueError):
        return {}
    if not isinstance(table, dict):
        return {}
    return {str(k): str(v) for k, v in table.items() if isinstance(v, str)}


class LocalAgent:
    """本地调试时的一台 Agent：`root` 为 None 时是本机，否则是映射到的本地目录。"""

    def __init__(self, name: str | None, root: str | None) -> None:
        self.name = name
        self.root = root

    @classmethod
    def resolve(
        cls, name: str | None, mapping: Mapping[str, str], referenced: Collection[str]
    ) -> LocalAgent:
        """按名称找本地调试时的 Agent；None 是自己所在的 Agent（本机）。"""
        if name is None:
            return cls(None, None)
        if name not in referenced:
            raise AgentNotReferenced(
                "节点只能访问通过「Agent」类型的参数拿到的 Agent 和自己所在的 Agent，"
                f"Agent {name} 不是：把它声明成节点的 AgentName 类型参数，在场景里选它",
                agent=name,
            )
        if name not in mapping:
            raise AgentUnreachable(
                f"本地调试时没有 Agent {name}：用 run_node(agents={{{name!r}: 目录}}) 或 "
                f"sfly run --agent {name}=<目录> 把它映射到本地目录",
                agent=name,
            )
        return cls(name, mapping[name])

    @property
    def label(self) -> str:
        """消息里怎样称呼这台 Agent。"""
        return f"Agent {self.name}" if self.name is not None else "本机"

    def real(self, path: str) -> str:
        """那台 Agent 上的绝对路径在本机上的位置。"""
        if self.root is None:
            return path
        relative = os.path.normpath(path).lstrip("/")
        return os.path.join(self.root, relative) if relative not in ("", ".") else self.root

    def agent_path(self, real: str) -> str:
        """本机上的位置换回那台 Agent 上的写法。"""
        if self.root is None:
            return real
        relative = os.path.relpath(real, self.root)
        return "/" if relative == "." else "/" + relative.replace(os.sep, "/")

    def error(self, error: OSError, path: str) -> AgentError:
        """文件系统错误转成和 Agent 上相同的异常（消息写明路径，`path` 是那台 Agent 上的写法）。"""
        if isinstance(error, FileNotFoundError):
            return AgentFileNotFound(f"{self.label}：{path} 不存在", agent=self.name)
        if isinstance(error, PermissionError):
            return AgentPermissionDenied(f"{self.label}：没有权限访问 {path}", agent=self.name)
        if isinstance(error, NotADirectoryError):
            return AgentError(f"{self.label}：{path} 不是目录", agent=self.name, kind="invalid")
        return AgentError(f"{self.label}：访问 {path} 失败：{error}", agent=self.name)
