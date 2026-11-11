"""调用 Agent 能力失败时抛出的异常（ADR 0019）。只用标准库（ADR 0002）。

都是 `AgentError` 的子类，`kind` 区分原因，`agent` 是目标 Agent 的名称；同时是对应的内置异常的子类，
`except FileNotFoundError` 这样的写法也能捕获。任务被取消时抛出的是 `sfly.Cancelled`，
不是这里的异常。

| 异常 | `kind` | 原因 |
|---|---|---|
| `AgentUnreachable`（`ConnectionError`） | unreachable | 连不通：连不上另一台 Agent 或本机 Agent |
| `AgentUnsupported` | unsupported | 对方不支持：目标 Agent 的版本没有这项能力 |
| `AgentFileNotFound`（`FileNotFoundError`） | not_found | 文件或目录不存在 |
| `AgentFileMoved` | moved | 下载续传时源文件已经不在原来的路径上（移到了别的目录） |
| `AgentPermissionDenied`（`PermissionError`） | permission_denied | 没有权限 |
| `AgentTimeout`（`TimeoutError`） | timeout | 超过 `timeout` 秒没有回应 |
| `AgentNotReferenced` | not_referenced | 目标 Agent 不是通过「Agent」类型的参数拿到的 |
| `AgentError` | invalid、failed | 参数不合法（例如要列出的不是目录）、其它失败 |
"""

from __future__ import annotations


class AgentError(Exception):
    """调用 Agent 能力失败。`kind` 是原因，`agent` 是目标 Agent 的名称（自己所在的 Agent 也写名称，
    本地调试时为 None）。"""

    kind = "failed"

    def __init__(self, message: str, *, agent: str | None = None, kind: str | None = None) -> None:
        super().__init__(message)
        self.agent = agent
        if kind is not None:
            self.kind = kind


class AgentUnreachable(AgentError, ConnectionError):
    """连不通：消息里写明从哪台 Agent 到哪台、地址和端口。"""

    kind = "unreachable"


class AgentUnsupported(AgentError):
    """对方不支持：目标 Agent 的版本没有这项能力（升级那台 Agent）。"""

    kind = "unsupported"


class AgentFileNotFound(AgentError, FileNotFoundError):
    """文件或目录不存在。"""

    kind = "not_found"


class AgentFileMoved(AgentError):
    """下载（`files.download`）连接中断后续传时，源文件已经不在原来的路径上：路径上换成了另一个文件，
    原来的文件在同一目录里也找不到（被移到了别的目录或被删除）。知道它去了哪里时，用新路径重新下载。"""

    kind = "moved"


class AgentPermissionDenied(AgentError, PermissionError):
    """没有权限：路径的权限就是目标 Agent 进程的权限。"""

    kind = "permission_denied"


class AgentTimeout(AgentError, TimeoutError):
    """超过调用的 `timeout` 秒没有回应。"""

    kind = "timeout"


class AgentNotReferenced(AgentError):
    """目标 Agent 不是通过「Agent」类型的参数（`sfly.AgentName`）拿到的：
    节点只能访问这样拿到的 Agent 和自己所在的 Agent。"""

    kind = "not_referenced"


_BY_KIND: dict[str, type[AgentError]] = {
    cls.kind: cls
    for cls in (
        AgentUnreachable,
        AgentUnsupported,
        AgentFileNotFound,
        AgentFileMoved,
        AgentPermissionDenied,
        AgentTimeout,
        AgentNotReferenced,
    )
}


def error_for(kind: str, message: str, agent: str | None) -> BaseException:
    """按 Agent 回复的错误原因构造异常；`cancelled` 是 `sfly.Cancelled`。"""
    if kind == "cancelled":
        from sfly.context import Cancelled

        return Cancelled(message)
    cls = _BY_KIND.get(kind)
    if cls is None:
        return AgentError(message, agent=agent, kind=kind or "failed")
    return cls(message, agent=agent)
