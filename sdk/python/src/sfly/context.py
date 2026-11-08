"""任务上下文 `Context`：节点函数的首个参数。只用标准库（ADR 0002）。

- `ctx.log`：带级别的结构化日志，`ctx.log.info("checking %s", url)`，
  也可以 `ctx.log("...", level="warn")`；
- `ctx.progress(当前值, 总数, 说明)`：上报进度，总数未知时省略；
- `ctx.metric(指标名, 数值, labels={...})`：上报节点类型声明的指标，可以带标签
  （见 `Context.metric`）；
- `ctx.artifacts`：保存产物，返回可以写进输出的产物引用（见 `Artifacts`）；
- `ctx.cancelled()`：任务是否已被取消（取消标记文件 `SFLY_CANCEL` 是否存在）；
- `ctx.task`：当前任务的运行 ID、节点 ID、任务 ID、attempt（见 `TaskInfo`）；
- `ctx.procs_dir`：这次运行的后台进程目录（见 `Context.procs_dir`）。

取消时 Agent 先写入取消标记，再向进程树发 SIGTERM；执行器把 SIGTERM 变成节点里的 `Cancelled` 异常
（`BaseException` 的子类，`except Exception` 不会吞掉它），`finally` 和 `with` 里的清理代码会执行，
宽限期（默认 10 秒）过后整棵进程树被强制杀掉。在后台线程里可以轮询 `ctx.cancelled()`。

日志和进度都追加写入本地协议的事件文件 `SFLY_EVENTS`
（JSONL，每行一个事件，Agent 持续读取新增内容）：

- 日志 `{"type": "log", "ts": <Unix 毫秒>, "level": "debug|info|warn|error", "message": "..."}`
- 进度 `{"type": "progress", "ts": ..., "current": 1, "total": 3, "message": "..."}`
  （`total` 可以是 null）
- 指标 `{"type": "metric", "ts": ..., "name": "tps", "kind": "gauge|counter", "value": 1.5}`，
  带标签时加 `"labels": {"pid": "1234"}`（值都是字符串；不带标签时没有这个字段）

`print` 和子进程的输出不经过这里：Agent 直接读取执行器的标准输出 / 标准错误，
与事件文件合并成同一条日志流。
"""

from __future__ import annotations

import json
import math
import os
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

# 执行器每个任务启动一个进程（#76），导入 sfly 在每个任务的启动路径上：pathlib、threading、shutil、
# traceback、urllib.parse 只在构造 Context、保存产物、记录异常时才用到，推迟到用到时再导入。
if TYPE_CHECKING:
    from pathlib import Path

    from sfly.nodes import Metric

#: 日志级别（与控制面、画布一致）。
LEVELS = ("debug", "info", "warn", "error")

_FROM_ENV: Any = object()

#: 标签值的最大长度（字符数，与 packages/schema 一致）。
MAX_LABEL_VALUE_CHARS = 128

#: 每个任务所有指标的序列数上限（不带标签的指标各算 1 个，与 packages/schema 一致），不开放配置。
MAX_SERIES = 1000


class Cancelled(BaseException):
    """任务被取消（或超时）时，执行器收到 SIGTERM 后在节点代码里抛出。"""


class _EventWriter:
    """把事件逐行追加写入事件文件；多线程同时写也保证每行完整。"""

    def __init__(self, path: str | os.PathLike[str] | None) -> None:
        import threading

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
        import traceback

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
        from pathlib import Path

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
            import shutil

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
            from urllib.parse import quote

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


@dataclass(frozen=True)
class TaskInfo:
    """`ctx.task`：当前任务的基本信息。

    - `run_id`：运行 ID；`node_id`：场景里的节点 ID（同一个节点类型可以出现多次，
      各有不同的节点 ID）；
    - `task_id`：任务 ID；`attempt`：第几次尝试（从 1 开始，重试时加 1）。

    在 Agent 上取自 Agent 写的 task.json（`SFLY_TASK`）；本地调试（`sfly run`、`sfly.testing`）时
    任务 ID 是 `local`、attempt 是 1、节点 ID 是节点名，运行 ID 见 `sfly run` 与 `run_node` 的说明。
    没有 task.json 时（在执行器之外直接构造 Context）都取 `local` 和 1。
    """

    run_id: str = "local"
    node_id: str = "local"
    task_id: str = "local"
    attempt: int = 1


def _task_from_env() -> TaskInfo:
    from pathlib import Path

    path = os.environ.get("SFLY_TASK")
    try:
        spec = json.loads(Path(path).read_text(encoding="utf-8")) if path else {}
    except (OSError, ValueError):
        spec = {}
    if not isinstance(spec, dict):
        spec = {}
    default = TaskInfo()

    def text(key: str) -> str:
        value = spec.get(key)
        return value if isinstance(value, str) and value else str(getattr(default, key))

    attempt = spec.get("attempt")
    return TaskInfo(
        run_id=text("run_id"),
        node_id=text("node_id"),
        task_id=text("task_id"),
        attempt=attempt if isinstance(attempt, int) and attempt > 0 else default.attempt,
    )


def _default_procs_dir(task: TaskInfo) -> Path:
    """Agent 没有给出 `SFLY_PROCS`（低于 0.0.4 的 Agent）时的后台进程目录：Agent 默认布局下的位置
    `$SFLY_HOME/procs/<运行 ID>/`（`SFLY_HOME` 默认 `~/.sfly`）。旧 Agent 不会清理它。"""
    from pathlib import Path

    home = os.environ.get("SFLY_HOME") or os.path.join(os.path.expanduser("~"), ".sfly")
    return Path(home).absolute() / "procs" / task.run_id


class Context:
    """节点执行时由执行器传入的任务上下文。

    `events_path` 默认取环境变量 `SFLY_EVENTS`；为 None（或环境变量未设置）时日志和进度被丢弃。
    `cancel_path` 默认取 `SFLY_CANCEL`；为 None 时 `cancelled()` 总是 False。
    `artifacts_dir` / `artifacts_url` 默认取 `SFLY_ARTIFACTS` / `SFLY_ARTIFACTS_URL`。
    `task` 默认读 `SFLY_TASK` 指向的 task.json（见 `TaskInfo`）；`procs_dir` 默认取 `SFLY_PROCS`。
    `metrics` 是节点类型声明的指标（`sfly.Metric` 列表），执行器从 `@node` 的声明传入；
    为 None（不知道声明，例如在节点之外直接构造）时不检查指标名和标签键，都按 `gauge` 上报。
    """

    def __init__(
        self,
        events_path: str | os.PathLike[str] | None = _FROM_ENV,
        cancel_path: str | os.PathLike[str] | None = _FROM_ENV,
        artifacts_dir: str | os.PathLike[str] | None = _FROM_ENV,
        artifacts_url: str | None = _FROM_ENV,
        metrics: Sequence[Metric] | None = None,
        task: TaskInfo | None = None,
        procs_dir: str | os.PathLike[str] | None = None,
    ) -> None:
        if events_path is _FROM_ENV:
            events_path = os.environ.get("SFLY_EVENTS")
        if cancel_path is _FROM_ENV:
            cancel_path = os.environ.get("SFLY_CANCEL")
        if artifacts_dir is _FROM_ENV:
            artifacts_dir = os.environ.get("SFLY_ARTIFACTS")
        if artifacts_url is _FROM_ENV:
            artifacts_url = os.environ.get("SFLY_ARTIFACTS_URL")
        from pathlib import Path

        self.task = task if task is not None else _task_from_env()
        if procs_dir is None:
            procs_dir = os.environ.get("SFLY_PROCS") or _default_procs_dir(self.task)
        self._procs_dir = Path(procs_dir)
        self._events = _EventWriter(events_path)
        self._cancel = cancel_path
        self.log = Log(self._events)
        self.artifacts = Artifacts(artifacts_dir, artifacts_url)
        # 指标名 → (类型, 声明的标签键)。
        self._metrics = (
            {m.name: (m.kind, frozenset(m.labels)) for m in metrics}
            if metrics is not None
            else None
        )
        self._warned: set[tuple[str, str]] = set()
        # 已经上报过的带标签的序列（指标名, 排好序的标签）。
        # 不带标签的指标各占 1 个名额，总是能上报：知道声明时预留声明了的个数，
        # 不知道时（metrics 为 None）按上报过的个数计。
        self._series: set[tuple[str, tuple[tuple[str, str], ...]]] = set()
        self._unlabeled: set[str] = (
            {m.name for m in metrics if not m.labels} if metrics is not None else set()
        )

    @property
    def procs_dir(self) -> Path:
        """这次运行的后台进程目录：节点启动的、要在节点结束后继续运行的进程（例如标准节点
        `start_process`）把日志等文件放在这里，任务目录被清理时它们不受影响。

        同一次运行的所有任务共用一个目录（不同节点用节点 ID 区分文件名），目录不一定已经存在，
        使用前自己创建（`mkdir(parents=True, exist_ok=True)`）。

        - Agent 上是 `$SFLY_HOME/procs/<运行 ID>/`（`SFLY_PROCS`），和任务目录按同一个保留期清理，
          运行还有任务在 Agent 手上时不动；
        - `sfly run` 时是项目下的 `.sfly/procs/<运行目录名>/`，
          `sfly.testing.run_node` 时是任务工作目录下的 `procs/`。
        """
        return self._procs_dir

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

    def metric(
        self, name: str, value: float, labels: Mapping[str, str | int | float] | None = None
    ) -> None:
        """上报一个指标的当前值。可以随意频繁调用：Agent 按「序列 × 秒」合并后每秒最多上报一次
        （`gauge` 取这一秒最后一个值并带最小 / 最大值，`counter` 取这一秒结束时的值）。

        `labels` 是这个点的标签（键 → 值），一组标签值是一个序列，运行监控页的折线和面积图里
        每个序列画一条线。指标在 `Metric(labels=[...])` 里声明了标签键时，每次都要给全这些键；
        没声明标签键的指标不能带标签。值是不超过 128 个字符的非空字符串，数字自动转成字符串。

        以下点被丢弃，并写一条警告日志（每个指标名、每种原因只警告一次）：节点类型没有声明的指标名、
        非有限数值（NaN、无穷大）、缺少声明过的标签键、带了未声明的标签键、给没声明标签键的指标带标签、
        标签值为空或超过 128 个字符。

        每个任务所有指标合计最多 1000 个序列（`MAX_SERIES`，不带标签的指标各算 1 个，总是能上报）：
        超出后不再建立新序列，新序列的点被丢弃，每个指标警告一次；已有序列照常上报。控制面也按同一上限兜底。
        """
        kind = "gauge"
        keys: frozenset[str] = frozenset()
        if self._metrics is not None:
            declared = self._metrics.get(name)
            if declared is None:
                self._warn_once(
                    "undeclared",
                    name,
                    f"指标 {name!r} 未声明，已丢弃（在 @node(metrics=...) 中声明后才能上报）",
                )
                return
            kind, keys = declared
        try:
            number = float(value)
        except (TypeError, ValueError):
            number = math.nan
        if not math.isfinite(number):
            self._warn_once(
                "non-finite", name, f"指标 {name!r} 的值必须是有限数值，实际为 {value!r}，已丢弃"
            )
            return
        event: dict[str, Any] = {
            "type": "metric",
            "ts": _now_ms(),
            "name": name,
            "kind": kind,
            "value": number,
        }
        checked: dict[str, str] | None = {}
        if labels or keys:
            checked = self._check_labels(name, keys, labels or {})
            if checked is None:
                return
        if checked:
            if not self._admit(name, checked):
                return
            event["labels"] = checked
        elif self._metrics is None:
            self._unlabeled.add(name)
        self._events.write(event)

    def _admit(self, name: str, labels: dict[str, str]) -> bool:
        """带标签的点：已有序列照常上报；新序列在没超出序列上限时建立，超出时丢弃并警告。"""
        series = (name, tuple(sorted(labels.items())))
        if series in self._series:
            return True
        if len(self._series) + len(self._unlabeled) >= MAX_SERIES:
            self._warn_once(
                "series-cap",
                name,
                f"任务的序列数已达上限 {MAX_SERIES}，指标 {name!r} 新出现的序列的点已丢弃"
                "（已有序列照常上报；标签值用来区分少量对象，不要用请求 ID、时间这类取值很多的值）",
            )
            return False
        self._series.add(series)
        return True

    def _check_labels(
        self, name: str, keys: frozenset[str], labels: Mapping[str, Any]
    ) -> dict[str, str] | None:
        """校验并规范化标签（值转成字符串）；不合法时警告并返回 None。"""
        if self._metrics is not None:
            if not keys:
                self._warn_once(
                    "unexpected-labels",
                    name,
                    f"指标 {name!r} 没有声明标签键，不能带标签，已丢弃"
                    "（在 Metric(labels=[...]) 中声明标签键后才能带标签上报）",
                )
                return None
            missing = sorted(keys.difference(labels))
            if missing:
                self._warn_once(
                    "missing-labels",
                    name,
                    f"指标 {name!r} 的点缺少标签 {', '.join(missing)}，已丢弃"
                    f"（声明的标签键：{', '.join(sorted(keys))}）",
                )
                return None
            extra = sorted(str(k) for k in labels if k not in keys)
            if extra:
                self._warn_once(
                    "undeclared-labels",
                    name,
                    f"指标 {name!r} 的点带了未声明的标签键 {', '.join(extra)}，已丢弃"
                    f"（声明的标签键：{', '.join(sorted(keys))}）",
                )
                return None
        result: dict[str, str] = {}
        for key, raw in labels.items():
            if isinstance(raw, str):
                text = raw
            elif isinstance(raw, (int, float)) and not isinstance(raw, bool):
                text = str(raw)
            else:
                self._warn_once(
                    "label-type",
                    name,
                    f"指标 {name!r} 的标签 {key} 的值必须是字符串或数字，实际为 {raw!r}，已丢弃",
                )
                return None
            if not text:
                self._warn_once("empty-label", name, f"指标 {name!r} 的标签 {key} 的值为空，已丢弃")
                return None
            if len(text) > MAX_LABEL_VALUE_CHARS:
                self._warn_once(
                    "long-label",
                    name,
                    f"指标 {name!r} 的标签 {key} 的值超过 {MAX_LABEL_VALUE_CHARS} 个字符，已丢弃"
                    "（标签值用来区分对象，不要放请求体、堆栈这类内容）",
                )
                return None
            result[str(key)] = text
        return result

    def _warn_once(self, reason: str, name: str, message: str) -> None:
        if (reason, name) in self._warned:
            return
        self._warned.add((reason, name))
        self.log.warn(message)
