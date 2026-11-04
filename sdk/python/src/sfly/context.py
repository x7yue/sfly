"""任务上下文 `Context`：节点函数的首个参数。只用标准库（ADR 0002）。

- `ctx.log`：带级别的结构化日志，`ctx.log.info("checking %s", url)`，
  也可以 `ctx.log("...", level="warn")`；
- `ctx.progress(当前值, 总数, 说明)`：上报进度，总数未知时省略；
- `ctx.artifacts`：保存产物，返回可以写进输出的产物引用（见 `Artifacts`）。

两者都追加写入本地协议的事件文件 `SFLY_EVENTS`（JSONL，每行一个事件，Agent 持续读取新增内容）：

- 日志 `{"type": "log", "ts": <Unix 毫秒>, "level": "debug|info|warn|error", "message": "..."}`
- 进度 `{"type": "progress", "ts": ..., "current": 1, "total": 3, "message": "..."}`
  （`total` 可以是 null）

`print` 和子进程的输出不经过这里：Agent 直接读取执行器的标准输出 / 标准错误，
与事件文件合并成同一条日志流。
取消检查由后续票据实现。
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import traceback
from pathlib import Path
from typing import Any
from urllib.parse import quote

#: 日志级别（与控制面、画布一致）。
LEVELS = ("debug", "info", "warn", "error")

_FROM_ENV: Any = object()


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


class Artifacts:
    """`ctx.artifacts`：把文件保存为产物。

    产物写在本地协议的产物目录 `SFLY_ARTIFACTS` 里，任务结束后由 Agent 上传到控制面，
    运行视图里可以下载。名称是产物目录内的相对路径（可以有子目录，用 `/` 分隔）。

    保存后得到**产物引用**：Agent 提供了下载地址前缀 `SFLY_ARTIFACTS_URL` 时，
    是这个产物的下载地址（前缀 + 按路径段百分号编码的名称），可以写进节点输出交给后续节点
    （例如 `urllib.request.urlopen(ref)`）；没有前缀时（本地调试）是本地文件路径。
    """

    def __init__(self, directory: str | os.PathLike[str] | None, url: str | None) -> None:
        self._dir = Path(directory) if directory is not None else None
        self._url = url or None

    def save(self, name: str, data: bytes | str | os.PathLike[str]) -> str:
        """保存一个产物并返回产物引用。

        `data` 为 bytes / str（按 UTF-8）时写入内容，为路径时复制该文件。
        """
        target = self.path(name)
        if isinstance(data, bytes):
            target.write_bytes(data)
        elif isinstance(data, str):
            target.write_text(data, encoding="utf-8")
        else:
            shutil.copyfile(data, target)
        return self.ref(name)

    def path(self, name: str) -> Path:
        """产物在本地的文件路径（父目录已创建），节点可以直接写入；写完用 `ref(name)` 得到引用。"""
        parts = _artifact_parts(name)
        if self._dir is None:
            raise RuntimeError("没有产物目录：执行器没有设置 SFLY_ARTIFACTS")
        target = self._dir.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        return target

    def ref(self, name: str) -> str:
        """产物引用：下载地址（没有 SFLY_ARTIFACTS_URL 时为本地文件路径）。"""
        parts = _artifact_parts(name)
        if self._url is not None:
            return self._url + "/".join(quote(p, safe="") for p in parts)
        if self._dir is None:
            raise RuntimeError("没有产物目录：执行器没有设置 SFLY_ARTIFACTS")
        return str(self._dir.joinpath(*parts))


def _artifact_parts(name: str) -> list[str]:
    """校验产物名称（与控制面一致），返回路径段。"""
    parts = name.split("/")
    bad = (
        not name
        or len(name) > 1024
        or any(c == "\\" or ord(c) < 0x20 or ord(c) == 0x7F for c in name)
        or any(p in ("", ".", "..") for p in parts)
    )
    if bad:
        raise ValueError(
            "产物名称必须是产物目录内的相对路径（用 / 分隔，不含空段、. 或 ..、反斜杠），"
            f"实际为 {name!r}"
        )
    return parts


class Context:
    """节点执行时由执行器传入的任务上下文。

    `events_path` 默认取环境变量 `SFLY_EVENTS`；为 None（或环境变量未设置）时日志和进度被丢弃。
    `artifacts_dir` / `artifacts_url` 默认取 `SFLY_ARTIFACTS` / `SFLY_ARTIFACTS_URL`。
    """

    def __init__(
        self,
        events_path: str | os.PathLike[str] | None = _FROM_ENV,
        artifacts_dir: str | os.PathLike[str] | None = _FROM_ENV,
        artifacts_url: str | None = _FROM_ENV,
    ) -> None:
        if events_path is _FROM_ENV:
            events_path = os.environ.get("SFLY_EVENTS")
        if artifacts_dir is _FROM_ENV:
            artifacts_dir = os.environ.get("SFLY_ARTIFACTS")
        if artifacts_url is _FROM_ENV:
            artifacts_url = os.environ.get("SFLY_ARTIFACTS_URL")
        self._events = _EventWriter(events_path)
        self.log = Log(self._events)
        self.artifacts = Artifacts(artifacts_dir, artifacts_url)

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
