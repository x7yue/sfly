"""本地调试时的 Agent 能力（`sfly debug`、`sfly.testing.run_node`）：没有 Agent，
直接操作本机的文件系统。只用标准库（ADR 0002）。

- 自己所在的 Agent（`ctx.agent()`）就是本机：路径原样使用；
- 其它 Agent 由测试工具映射到本地目录（`run_node(agents={名称: 目录})`、
  `sfly debug --agent 名称=目录`）：那台 Agent 上的绝对路径 `/var/log/app.log` 对应
  `<目录>/var/log/app.log`，返回的路径再换回那台 Agent 上的写法；
- 和在 Agent 上一样只能访问通过「Agent」类型的参数拿到的 Agent：参数里没有的名称抛出
  `AgentNotReferenced`，参数里有但没有映射的抛出 `AgentUnreachable`（提示怎样映射）。

映射表是执行器的环境变量 `SFLY_LOCAL_AGENTS` 指向的 JSON 文件，由 `sfly.local` 写：
参数里引用的每台 Agent 一项，名称 → 本地目录的绝对路径，没有映射的为 null。设置了它就是本地调试。
每项能力在自己的模块里用 `LocalAgent` 实现本地版本。
"""

from __future__ import annotations

import json
import os
import stat as stat_module
from collections.abc import Iterator, Mapping
from typing import BinaryIO

from sfly.capabilities.errors import (
    AgentError,
    AgentFileNotFound,
    AgentNotReferenced,
    AgentPermissionDenied,
    AgentUnreachable,
    Kind,
)
from sfly.context import DeferCancel


def read_mapping(path: str | os.PathLike[str]) -> dict[str, str | None]:
    """读映射表（参数里引用的 Agent → 本地目录，没有映射的为 None）；不认识的内容视为空表。"""
    try:
        with open(path, encoding="utf-8") as f:
            table = json.loads(f.read())
    except (OSError, ValueError):
        return {}
    if not isinstance(table, dict):
        return {}
    return {str(k): v if isinstance(v, str) else None for k, v in table.items()}


class LocalAgent:
    """本地调试时的一台 Agent：`root` 为 None 时是本机，否则是映射到的本地目录。"""

    def __init__(self, name: str | None, root: str | None) -> None:
        self.name = name
        self.root = root

    @classmethod
    def resolve(cls, name: str | None, mapping: Mapping[str, str | None]) -> LocalAgent:
        """按名称找本地调试时的 Agent（`mapping` 见 `read_mapping`）；None 是自己所在的 Agent
        （本机，`HERE`）。"""
        if name is None:
            return HERE
        if name not in mapping:
            raise AgentNotReferenced(
                "节点只能访问通过「Agent」类型的参数拿到的 Agent 和自己所在的 Agent，"
                f"Agent {name} 不是：把它声明成节点的 AgentName 类型参数，在场景里选它",
                agent=name,
            )
        root = mapping[name]
        if root is None:
            raise AgentUnreachable(
                f"本地调试时没有 Agent {name}：用 run_node(agents={{{name!r}: 目录}}) 或 "
                f"sfly debug --agent {name}=<目录> 把它映射到本地目录",
                agent=name,
            )
        return cls(name, root)

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

    def error(
        self,
        error: OSError,
        path: str,
        *,
        missing: str | None = None,
        denied: str | None = None,
        not_dir: str | None = None,
    ) -> AgentError:
        """文件系统错误转成和 Agent 上相同的异常（消息写明路径，`path` 是那台 Agent 上的写法）。
        `missing`、`denied`、`not_dir`：不存在、没有权限、不是目录时换成这条消息
        （与 Agent 上这个操作的消息相同）。"""
        if isinstance(error, FileNotFoundError):
            return AgentFileNotFound(self._message(missing or f"{path} 不存在"), agent=self.name)
        if isinstance(error, PermissionError):
            message = self._message(denied or f"没有权限访问 {path}")
            return AgentPermissionDenied(message, agent=self.name)
        if isinstance(error, NotADirectoryError):
            return self.invalid(not_dir or f"{path} 不是目录")
        return AgentError(self._message(f"访问 {path} 失败：{error}"), agent=self.name)

    def invalid(self, message: str) -> AgentError:
        """参数不合法（`kind` 为 invalid），例如要读取的是目录。"""
        return AgentError(self._message(message), agent=self.name, kind=Kind.INVALID)

    def _message(self, text: str) -> str:
        return f"{self.label}：{text}"

    def open_file(self, path: str, *, regular: bool = False) -> _OpenFile:
        """以只读方式打开这台 Agent 上的文件 `path`（跟随符号链接），用 `with`。
        错误与 Agent 上相同：是目录时不能读取，`regular` 时不是普通文件都不行（上传时）。"""
        return _OpenFile(self, path, regular)


#: 节点所在的机器：自己所在的 Agent，路径原样使用，消息里称为「本机」。
HERE = LocalAgent(None, None)


class _OpenFile:
    """`LocalAgent.open_file`：打开和登记关闭之间不会被取消打断（`DeferCancel`）。"""

    def __init__(self, local: LocalAgent, path: str, regular: bool) -> None:
        self._local = local
        self._path = path
        self._regular = regular
        self._file: BinaryIO | None = None

    def __enter__(self) -> BinaryIO:
        local, path = self._local, self._path
        not_file = f"{path} 不是文件" if self._regular else f"{path} 是目录，不能读取"
        try:
            with DeferCancel():
                self._file = open(local.real(path), "rb")  # noqa: SIM115 — __exit__ 关闭
            mode = os.fstat(self._file.fileno()).st_mode
        except IsADirectoryError:
            raise local.invalid(not_file) from None
        except BaseException as error:
            self.__exit__()
            if isinstance(error, OSError):
                raise local.error(error, path) from None
            raise
        if not stat_module.S_ISREG(mode) and (self._regular or stat_module.S_ISDIR(mode)):
            self.__exit__()
            raise local.invalid(not_file)
        return self._file

    def __exit__(self, *exc: object) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None


def read_chunks(f: BinaryIO, size: int, length: int | None = None) -> Iterator[bytes]:
    """从 `f` 的当前位置起逐块读出，每块最多 `size` 字节，读到 `length` 字节为止
    （None 为读到末尾）。"""
    remaining = length
    while remaining is None or remaining > 0:
        data = f.read(size if remaining is None else min(size, remaining))
        if not data:
            return
        if remaining is not None:
            remaining -= len(data)
        yield data
