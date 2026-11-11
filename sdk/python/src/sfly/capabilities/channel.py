"""SDK → 自己所在的 Agent：经 Agent 的本地 socket（`SFLY_AGENT_SOCKET`）发起一次能力调用。
只用标准库（ADR 0002）。

协议（agent/src/calls/mod.rs）：每次调用一个连接。SDK 发一行 JSON 请求
`{"command": "call", "task_id", "attempt", "agent", "method", "args", "timeout_ms"}`，
Agent 回复若干行 JSON：

- `{"item": ...}`：流式方法的一项；
- `{"data": N}` 之后紧跟 N 个原始字节：传输文件内容的方法（读取）；
- 最后一行 `{"result": ...}` 或 `{"error": {"kind", "message", "agent"}}`，之后关闭连接。

往对方传数据的方法（流式写入）在请求之后接着发 `{"data": N}` + N 个字节的帧（`Call.send_data`），
最后发 `{"end": true}`（`Call.send_end`），再读回复。

超时由 Agent 负责（`timeout_ms`，等对方回应的上限）；SDK 这边多等 `REPLY_MARGIN` 秒兜底，
Agent 自己卡住时也不会永远等下去。任务被取消时：主线程里的调用被 SIGTERM 打断
（执行器把它变成 `Cancelled`），后台线程里的调用由 Agent 回复 `cancelled`，同样抛出
`Cancelled`。关掉连接（`close()`、提前停止迭代）即放弃调用，Agent 随之放弃。
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Iterator
from typing import Any

from sfly.capabilities.errors import AgentTimeout, AgentUnreachable, error_for
from sfly.context import Cancelled

#: 调用的默认超时（秒）。
DEFAULT_TIMEOUT = 30.0

#: 一块数据最多多少字节：流式写入时每帧最多发这么多，本地调试时读文件每次读这么多
#: （与 Agent 的块大小相同）。
MAX_DATA = 256 * 1024

#: Agent 应该在 `timeout` 内回复；SDK 默认多等这么久才认为 Agent 自己卡住了。
REPLY_MARGIN = 5.0


class AgentSocket:
    """自己所在的 Agent 的本地 socket；`task_id` + `attempt` 告诉 Agent 是哪个任务在调用。"""

    def __init__(
        self,
        path: str | os.PathLike[str],
        task_id: str,
        attempt: int,
        cancelled: Callable[[], bool],
    ) -> None:
        self.path = os.fspath(path)
        self._task_id = task_id
        self._attempt = attempt
        self._cancelled = cancelled

    def call(
        self,
        agent: str | None,
        method: str,
        args: dict[str, Any],
        timeout: float | None,
        *,
        margin: float | None = None,
    ) -> Call:
        """发起调用（`agent` 为 None 时是自己所在的 Agent），返回还没读回复的 `Call`。
        `margin`：Agent 应该在 `timeout` 之后多久之内回复，SDK 等到这时才认为 Agent 自己卡住了；
        None 为 `REPLY_MARGIN`。"""
        import socket

        if self._cancelled():
            raise Cancelled("任务已取消")
        if margin is None:
            margin = REPLY_MARGIN
        request = {
            "command": "call",
            "task_id": self._task_id,
            "attempt": self._attempt,
            "agent": agent or "",
            "method": method,
            "args": args,
            "timeout_ms": 0 if timeout is None else max(1, round(timeout * 1000)),
        }
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.settimeout(None if timeout is None else timeout + margin)
        try:
            conn.connect(self.path)
            conn.sendall(json.dumps(request, ensure_ascii=False).encode("utf-8") + b"\n")
        except OSError as error:
            conn.close()
            raise AgentUnreachable(
                f"连不上本机 Agent 的本地 socket {self.path}（{error.strerror or error}）："
                "Agent 是否已退出？",
                agent=agent,
            ) from error
        return Call(conn, agent, method, timeout)


class Call:
    """一次进行中的调用：按顺序读 Agent 的回复。用完（或放弃时）`close()`；也可以用 `with`。"""

    def __init__(self, conn: Any, agent: str | None, method: str, timeout: float | None) -> None:
        self._conn = conn
        self._file = conn.makefile("rb")
        self._agent = agent
        self._method = method
        self._timeout = timeout
        self._done = False

    def __enter__(self) -> Call:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._file.close()
        self._conn.close()

    def send_data(self, data: bytes | bytearray | memoryview) -> bool:
        """发一段数据（流式写入）：`{"data": N}` 一行之后紧跟这 N 个字节，N 不超过 `MAX_DATA`。
        Agent 已经结束这次调用（例如出错了）、不再接收时返回 False：接着用 `result()` 读出原因。"""
        header = json.dumps({"data": len(data)}).encode("utf-8") + b"\n"
        return self._send(header, data)

    def send_end(self) -> bool:
        """数据发完了（`{"end": true}`）。返回值同 `send_data`。"""
        return self._send(b'{"end": true}\n')

    def _send(self, *parts: bytes | bytearray | memoryview) -> bool:
        try:
            for part in parts:
                self._conn.sendall(part)
        except TimeoutError:
            raise self._timed_out() from None
        except OSError:
            # Agent 已经回复并关闭了连接（回复还能读到）。
            return False
        return True

    def frames(self) -> Iterator[dict[str, Any]]:
        """逐帧读回复：`item`、`data`（带 `bytes`：读出的原始字节）帧原样给出；
        读到 `result` 时结束（最后给出这一帧），读到 `error` 时抛出对应的异常。"""
        while not self._done:
            frame = self._read_frame()
            if "data" in frame:
                frame["bytes"] = self._read_exact(int(frame["data"]))
            elif "error" in frame:
                self._done = True
                error = frame["error"] if isinstance(frame["error"], dict) else {}
                raise error_for(
                    str(error.get("kind", "failed")),
                    str(error.get("message", "")),
                    error.get("agent") or self._agent,
                )
            elif "result" in frame:
                self._done = True
            yield frame

    def items(self) -> Iterator[Any]:
        """流式方法：逐项给出 `item`，调用成功结束时停止。"""
        for frame in self.frames():
            if "item" in frame:
                yield frame["item"]

    def result(self) -> Any:
        """一次性方法：等调用结束，返回结果。"""
        for frame in self.frames():
            if "result" in frame:
                return frame["result"]
        raise self._broken()

    def _read_frame(self) -> dict[str, Any]:
        try:
            line = self._file.readline()
        except TimeoutError:
            raise self._timed_out() from None
        if not line.endswith(b"\n"):
            raise self._broken()
        frame = json.loads(line)
        if not isinstance(frame, dict):
            raise self._broken()
        return frame

    def _read_exact(self, size: int) -> bytes:
        try:
            data = self._file.read(size)
        except TimeoutError:
            raise self._timed_out() from None
        if len(data) != size:
            raise self._broken()
        return bytes(data)

    def _timed_out(self) -> AgentTimeout:
        return AgentTimeout(
            f"本机 Agent 超过 {self._timeout} 秒没有回应 {self._method}", agent=self._agent
        )

    def _broken(self) -> AgentUnreachable:
        self._done = True
        return AgentUnreachable(
            f"本机 Agent 中断了 {self._method} 调用：Agent 是否已退出？", agent=self._agent
        )
