"""任务上下文 `Context`：节点函数的首个参数。只用标准库（ADR 0002）。

- `ctx.log`：带级别的结构化日志，`ctx.log.info("checking %s", url)`，
  也可以 `ctx.log("...", level="warn")`；
- `ctx.progress(当前值, 总数, 说明)`：上报进度，总数未知时省略；
- `ctx.cancelled()`：任务是否已被取消（取消标记文件 `SFLY_CANCEL` 是否存在）。

取消时 Agent 先写入取消标记，再向进程树发 SIGTERM；执行器把 SIGTERM 变成节点里的 `Cancelled` 异常
（`BaseException` 的子类，`except Exception` 不会吞掉它），`finally` 和 `with` 里的清理代码会执行，
宽限期（默认 10 秒）过后整棵进程树被强制杀掉。在后台线程里可以轮询 `ctx.cancelled()`。

两者都追加写入本地协议的事件文件 `SFLY_EVENTS`（JSONL，每行一个事件，Agent 持续读取新增内容）：

- 日志 `{"type": "log", "ts": <Unix 毫秒>, "level": "debug|info|warn|error", "message": "..."}`
- 进度 `{"type": "progress", "ts": ..., "current": 1, "total": 3, "message": "..."}`
  （`total` 可以是 null）

`print` 和子进程的输出不经过这里：Agent 直接读取执行器的标准输出 / 标准错误，
与事件文件合并成同一条日志流。
产物由后续票据实现。
"""

from __future__ import annotations

import json
import os
import threading
import time
import traceback
from typing import Any

#: 日志级别（与控制面、画布一致）。
LEVELS = ("debug", "info", "warn", "error")

_FROM_ENV: Any = object()


class Cancelled(BaseException):
    """任务被取消（或超时）时，执行器收到 SIGTERM 后在节点代码里抛出。"""


class _EventWriter:
    """把事件逐行追加写入事件文件；多线程同时写也保证每行完整。"""

    def __init__(self, path: str | os.PathLike[str] | None) -> None:
        self._path = path
        self._fd: int | None = None
        self._lock = threading.Lock()

    def write(self, event: dict[str, Any]) -> None:
        if self._path is None:
            return
        line = (json.dumps(event, ensure_ascii=False, default=str) + "\n").encode("utf-8")
        with self._lock:
            if self._fd is None:
                self._fd = os.open(self._path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
            view = memoryview(line)
            while view:
                view = view[os.write(self._fd, view) :]


def _now_ms() -> int:
    return int(time.time() * 1000)


class Log:
    """`ctx.log`：带级别的日志。消息按 `%` 格式化参数（与标准库 logging 相同）。"""

    def __init__(self, writer: _EventWriter) -> None:
        self._writer = writer

    def __call__(self, message: object, *args: object, level: str = "info") -> None:
        if level == "warning":
            level = "warn"
        if level not in LEVELS:
            raise ValueError(f"日志级别必须是 {', '.join(LEVELS)} 之一，实际为 {level!r}")
        text = str(message) % args if args else str(message)
        self._writer.write({"type": "log", "ts": _now_ms(), "level": level, "message": text})

    def debug(self, message: object, *args: object) -> None:
        self(message, *args, level="debug")

    def info(self, message: object, *args: object) -> None:
        self(message, *args, level="info")

    def warning(self, message: object, *args: object) -> None:
        self(message, *args, level="warn")

    warn = warning

    def error(self, message: object, *args: object) -> None:
        self(message, *args, level="error")

    def exception(self, message: object, *args: object) -> None:
        """在 except 块里调用：error 级别，消息后附上当前异常的 traceback。"""
        text = str(message) % args if args else str(message)
        self(text + "\n" + traceback.format_exc().rstrip(), level="error")


class Context:
    """节点执行时由执行器传入的任务上下文。

    `events_path` 默认取环境变量 `SFLY_EVENTS`；为 None（或环境变量未设置）时日志和进度被丢弃。
    `cancel_path` 默认取 `SFLY_CANCEL`；为 None 时 `cancelled()` 总是 False。
    """

    def __init__(
        self,
        events_path: str | os.PathLike[str] | None = _FROM_ENV,
        cancel_path: str | os.PathLike[str] | None = _FROM_ENV,
    ) -> None:
        if events_path is _FROM_ENV:
            events_path = os.environ.get("SFLY_EVENTS")
        if cancel_path is _FROM_ENV:
            cancel_path = os.environ.get("SFLY_CANCEL")
        self._events = _EventWriter(events_path)
        self._cancel = cancel_path
        self.log = Log(self._events)

    def cancelled(self) -> bool:
        """任务是否已被取消（Agent 已写入取消标记）。"""
        return self._cancel is not None and os.path.exists(self._cancel)

    def progress(self, current: float, total: float | None = None, message: str = "") -> None:
        """上报进度：当前值、总数（未知时省略）和说明。Agent 端合并，每秒最多上报一次。"""
        self._events.write(
            {
                "type": "progress",
                "ts": _now_ms(),
                "current": current,
                "total": total,
                "message": str(message),
            }
        )
