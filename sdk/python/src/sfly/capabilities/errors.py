"""调用 Agent 能力失败时抛出的异常（ADR 0019）。只用标准库（ADR 0002）。

都是 `AgentError` 的子类，`kind` 区分原因，`agent` 是目标 Agent 的名称；同时是对应的内置异常的子类，
`except FileNotFoundError` 这样的写法也能捕获。任务被取消时抛出的是 `sfly.Cancelled`，
不是这里的异常。

| 异常 | `kind` | 原因 |
|---|---|---|
| `AgentUnreachable`（`ConnectionError`） | unreachable | 连不通：连不上另一台 Agent 或本机 Agent |
| `AgentUnsupported` | unsupported | 对方不支持：目标 Agent 的版本没有这项能力 |
| `AgentFileNotFound`（`FileNotFoundError`） | not_found | 文件或目录不存在 |
| `AgentPermissionDenied`（`PermissionError`） | permission_denied | 没有权限 |
| `AgentTimeout`（`TimeoutError`） | timeout | 超过 `timeout` 秒没有回应 |
| `AgentNotReferenced` | not_referenced | 目标 Agent 不是通过「Agent」类型的参数拿到的 |
| `AgentError` | invalid、failed | 参数不合法（例如要列出的不是目录）、其它失败 |
"""

from __future__ import annotations

from sfly.context import Cancelled


class Kind:
    """`AgentError.kind` 的取值，也是 Agent 回复的错误原因（agent/src/calls/mod.rs）。
    值是公开的（节点里写 `error.kind == "failed"`），不能改。"""

    UNREACHABLE = "unreachable"
    UNSUPPORTED = "unsupported"
    NOT_FOUND = "not_found"
    PERMISSION_DENIED = "permission_denied"
    TIMEOUT = "timeout"
    NOT_REFERENCED = "not_referenced"
    #: 参数不合法，例如要列出的路径不是目录、要读取的是目录。
    INVALID = "invalid"
    #: 其它失败，例如下载期间源文件被替换、被截短、大小变了。
    FAILED = "failed"
    #: 任务被取消：只在 Agent 的回复里出现，SDK 抛出 `sfly.Cancelled`。
    CANCELLED = "cancelled"


class AgentError(Exception):
    """调用 Agent 能力失败。`kind` 是原因，`agent` 是目标 Agent 的名称（自己所在的 Agent 也写名称，
    本地调试时为 None）。"""

    kind = Kind.FAILED

    def __init__(self, message: str, *, agent: str | None = None, kind: str | None = None) -> None:
        super().__init__(message)
        self.agent = agent
        if kind is not None:
            self.kind = kind


class AgentUnreachable(AgentError, ConnectionError):
    """连不通：消息里写明从哪台 Agent 到哪台、地址和端口。"""

    kind = Kind.UNREACHABLE


class AgentUnsupported(AgentError):
    """对方不支持：目标 Agent 的版本没有这项能力（升级那台 Agent）。"""

    kind = Kind.UNSUPPORTED


class AgentFileNotFound(AgentError, FileNotFoundError):
    """文件或目录不存在。"""

    kind = Kind.NOT_FOUND


class AgentPermissionDenied(AgentError, PermissionError):
    """没有权限：路径的权限就是目标 Agent 进程的权限。"""

    kind = Kind.PERMISSION_DENIED


class AgentTimeout(AgentError, TimeoutError):
    """超过调用的 `timeout` 秒没有回应。"""

    kind = Kind.TIMEOUT


class AgentNotReferenced(AgentError):
    """目标 Agent 不是通过「Agent」类型的参数（`sfly.AgentName`）拿到的：
    节点只能访问这样拿到的 Agent 和自己所在的 Agent。"""

    kind = Kind.NOT_REFERENCED


_BY_KIND: dict[str, type[AgentError]] = {
    cls.kind: cls
    for cls in (
        AgentUnreachable,
        AgentUnsupported,
        AgentFileNotFound,
        AgentPermissionDenied,
        AgentTimeout,
        AgentNotReferenced,
    )
}


def error_for(kind: str, message: str, agent: str | None) -> BaseException:
    """按 Agent 回复的错误原因构造异常；`cancelled` 是 `sfly.Cancelled`。"""
    if kind == Kind.CANCELLED:
        return Cancelled(message)
    cls = _BY_KIND.get(kind)
    if cls is None:
        return AgentError(message, agent=agent, kind=kind or Kind.FAILED)
    return cls(message, agent=agent)
