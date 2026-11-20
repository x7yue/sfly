"""本地执行：不经过控制面和 Agent，在开发机上执行一个节点（本地调试）。只用标准库（ADR 0002）。

`sfly.testing` 和 `sfly debug` 共用这里。和 Agent 一样按本地协议（docs/ARCHITECTURE.md §5.4）
启动执行器子进程 `python -u -m sfly.runner`，只把读取事件、存放产物的一端换成本地实现：

- 事件：和 Agent 一样经工作目录里的命名管道 `events.fifo` 读取（ADR 0015），不写事件文件；

- 参数校验：按节点类型的输入 schema 检查必填和类型（与控制面派发前的检查相同，
  packages/orchestration/src/inputs.ts），不通过时以 `config_error` 失败，不启动执行器；
- 输出上限、指标声明检查、产物引用：由执行器和 `Context` 负责，与 Agent 上完全相同
  （本地没有产物下载地址，产物引用是本地文件路径）；
- 日志：标准输出 → 来源 stdout、级别 info，标准错误 → 来源 stderr、级别 error，
  事件管道里的日志 → 来源 sdk、级别取 SDK 记录的级别，不认识的行原样记成 sdk info 日志
  （agent/src/logs.rs）；进度和指标保留每一次上报（Agent 上报前按秒合并）；
- 任务信息与后台进程目录：task.json 里任务 ID 是 `local`、attempt 是 1，
  运行 ID 和节点 ID 由调用方给出；
  `SFLY_PROCS` 默认是工作目录下的 `procs/`
  （`sfly debug` 改为项目下的 `.sfly/procs/<运行目录名>/`）；
- 下载产物：本地没有控制面，`SFLY_DOWNLOADS` 指向下载内容表 `downloads.json`
  （产物引用 → 本地文件路径，只有本地执行会设置），`ctx.artifacts.download` 遇到表里的引用时
  直接复制对应的文件；本地保存的产物的引用是本地文件路径，不用登记就能下载；
- Agent 能力：本地没有 Agent，`ctx.agent()` 直接操作本机的文件系统；`SFLY_LOCAL_AGENTS`
  指向映射表 `local-agents.json`（「Agent」类型的输入引用的每台 Agent → 本地目录，没有映射的
  为 null；只有本地执行会设置），`ctx.agent(名称)` 把那台 Agent 上的路径落到映射的目录里，
  不在表里的名称不能访问（见 `sfly.capabilities.local`）；
- 飞书通知：本地没有控制面，`ctx.notify` 不真的发送。和控制面一样只认「飞书机器人」类型的
  输入引用的机器人，按同样的规则组装请求体、校验原始消息（`sfly.feishu`，镜像
  apps/server/src/feishu/messages.ts），记成 `Notification`；其他机器人、不合格的原始消息不记，
  日志里写一行来源 system、级别 warn 的警告（apps/server/src/feishu/task-notifications.ts）；
- 动作和标记：`ctx.action`、`ctx.mark` 写的四种事件（格式见 `sfly.context`）记成
  `Execution.actions`（动作和标记，按 ID 排列）和 `Execution.action_summary`（最新的一份摘要）；
  节点结束时还没结束的动作记为 `unfinished`，结束时间取节点结束的时刻，摘要里「正在做」同时清空
  （和控制面在任务结束时做的一样）；
- 取消：先写取消标记，再向进程组发 SIGTERM，宽限期过后 SIGKILL；强制取消时立即杀掉
  （agent/src/executor.rs、process_tree.rs，docs/SEMANTICS.md §3.4）。
"""

from __future__ import annotations

import bisect
import dataclasses
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any, Literal

from sfly.context import ACTION_RESULTS, ActionResult, monotonic_ms
from sfly.feishu import raw_message_problem, text_message

#: 取消时从 SIGTERM 到强制杀掉的默认宽限期（秒，docs/SEMANTICS.md §3.4）。
DEFAULT_GRACE = 10.0
#: 处理读到的日志与事件、检查取消和进程状态的间隔（秒）。
_TICK = 0.05
#: 一行日志的最大字节数；更长的行被拆成多行（与 Agent 相同）。
_MAX_LINE_BYTES = 64 * 1024
#: 执行器退出后，等待仍持有标准输出（或事件管道）的后台子进程关闭管道的最长时间（秒）。
_DRAIN_TIMEOUT = 2.0
#: 失败时附带的标准错误尾部的最大字节数。
_STDERR_TAIL_BYTES = 8 * 1024

Status = Literal["running", "success", "failed", "cancelled"]


@dataclass(frozen=True)
class LogLine:
    """一行日志。`source`：stdout | stderr | sdk | system（平台写的提示）；
    `level`：debug | info | warn | error。"""

    ts: int
    source: str
    level: str
    message: str


@dataclass(frozen=True)
class Progress:
    """一次 `ctx.progress` 上报。"""

    ts: int
    current: float
    total: float | None
    message: str


@dataclass(frozen=True)
class MetricPoint:
    """一次 `ctx.metric` 上报（未声明的指标、非有限数值和标签不合法的点已被 `Context` 丢弃）。

    `labels` 是这个点的标签（值都是字符串），不带标签时为空。
    """

    ts: int
    name: str
    kind: str
    value: float
    labels: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Notification:
    """一次 `ctx.notify`：发给哪个飞书机器人（名称），和控制面会发出的完整请求体。

    本地调试不真的发送。
    """

    ts: int
    bot: str
    body: dict[str, Any]


@dataclass(frozen=True)
class ActionRecord:
    """一次 `ctx.action` 或 `ctx.mark`。

    - `id`：任务内递增的 ID（动作和标记共用）；`kind`：`action` 或 `mark`；
    - `parent`：父动作的 ID，最外层是 None；`depth`：层级，最外层是 0；
    - `fields`：字段（值都是字符串）：动作开始（标记发生）时给的，加上动作的 `note()` 补充的；
    - `ts`：动作开始或标记发生的时间，Unix 毫秒，Agent 时间（本地调试就是本机的系统时间）；
      `mono`：同一时刻单调时钟的读数（毫秒）；
    - `result`：`success`、`failed`、`unfinished`；还在进行的动作是 None，标记总是 None；
    - `reason`：失败的原因（`ValueError: 消息`、或 `fail()` 给的文字），其余为 None；
    - `duration_ms`：动作的耗时（毫秒，按单调时钟算，系统时间被改动也不受影响）；还在进行的动作
      是 None，标记总是 None。
    """

    id: int
    kind: Literal["action", "mark"]
    name: str
    parent: int | None
    depth: int
    fields: Mapping[str, str]
    ts: int
    mono: int
    result: ActionResult | None = None
    reason: str | None = None
    duration_ms: int | None = None


@dataclass(frozen=True)
class ActionCount:
    """摘要里一种名称的计数：`total` 个（动作和标记合计），其中 `failed` 个动作失败，
    `reported` 个上报了明细（包括失败的动作补发的）。
    `capped_ts`（Agent 时间）从这个时刻起这个名称只计数、没有明细（超过上限），没有时为 None。"""

    name: str
    total: int
    failed: int
    reported: int
    capped_ts: int | None = None


@dataclass(frozen=True)
class ActionSummary:
    """一份动作和标记的摘要（`action_summary`）：到目前为止的汇总，超过明细上限之后仍然准确。

    - `ts`：发出这份摘要的时间（Unix 毫秒）；
    - `total`：记录的动作和标记的个数，`marks`：其中标记的个数，`reported`：上报了明细的个数；
      `capped_ts`：第一个因为合计已满而被丢弃明细的时刻（之后仍可能有已上报的明细），
      没有丢弃过时为 None；
    - `names`：每种名称的计数；
    - `running`：正在做的动作（最多 50 个，层级浅的优先，按 ID 排列）；
    - `recent`：最近结束的 20 个动作，最近的在前；`recent_failed`：最近失败的 5 个，最近的在前。

    标记算进 `total`、`reported`、`names` 和 `capped_ts`，不在 `running`、`recent` 里。
    """

    ts: int
    total: int
    marks: int
    reported: int
    capped_ts: int | None
    names: list[ActionCount]
    running: list[ActionRecord]
    recent: list[ActionRecord]
    recent_failed: list[ActionRecord]


@dataclass(frozen=True)
class NodeError:
    """失败原因。`kind` 与平台的错误类型相同：`node_error`（节点抛出异常、执行器异常退出）、
    `config_error`（参数校验失败）；`type` 是节点抛出的异常类名（只有 node_error 有）。"""

    kind: str
    message: str
    type: str | None = None
    traceback: str = ""


@dataclass
class Execution:
    """一次本地执行的结果（执行中是到目前为止的部分结果，`status` 为 running）。"""

    status: Status
    work_dir: Path
    outputs: dict[str, Any] | None = None
    error: NodeError | None = None
    logs: list[LogLine] = field(default_factory=list)
    progress: list[Progress] = field(default_factory=list)
    metrics: list[MetricPoint] = field(default_factory=list)
    notifications: list[Notification] = field(default_factory=list)
    actions: list[ActionRecord] = field(default_factory=list)
    action_summary: ActionSummary | None = None

    @property
    def artifacts_dir(self) -> Path:
        """产物目录（`ctx.artifacts` 保存的文件都在这里）。"""
        return self.work_dir / "artifacts"

    @property
    def artifacts(self) -> dict[str, Path]:
        """产物：名称（产物目录内用 / 分隔的相对路径）→ 本地文件路径，按名称排序。"""
        root = self.artifacts_dir
        if not root.is_dir():
            return {}
        files = sorted(p for p in root.rglob("*") if p.is_file())
        return {p.relative_to(root).as_posix(): p for p in files}


class Cancellation:
    """取消请求：`cancel()` 优雅取消（取消标记 + SIGTERM + 宽限期），`cancel(force=True)` 立即杀掉。

    可以在其他线程或信号处理函数里调用。
    """

    def __init__(self) -> None:
        self.requested = False
        self.forced = False

    def cancel(self, force: bool = False) -> None:
        self.requested = True
        if force:
            self.forced = True


# ---- 参数校验（与 packages/orchestration/src/inputs.ts 一致）----


def _show(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _describe(schema: Mapping[str, Any]) -> str:
    if isinstance(schema.get("enum"), list):
        return f"{' | '.join(_show(e) for e in schema['enum'])} 之一"
    if isinstance(schema.get("anyOf"), list):
        return " | ".join(_describe(s) for s in schema["anyOf"])
    if isinstance(schema.get("type"), str):
        return str(schema["type"])
    if isinstance(schema.get("type"), list):
        return " | ".join(schema["type"])
    return "任意值"


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _matches_type(kind: Any, value: Any) -> bool:
    if kind == "string":
        return isinstance(value, str)
    if kind == "integer":
        return _is_number(value) and float(value).is_integer()
    if kind == "number":
        return _is_number(value) and float(value) not in (float("inf"), float("-inf"))
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "null":
        return value is None
    if kind == "array":
        return isinstance(value, list)
    if kind == "object":
        return isinstance(value, dict)
    return True


def _matches(schema: Mapping[str, Any], value: Any) -> bool:
    enum = schema.get("enum")
    if isinstance(enum, list) and not any(_show(e) == _show(value) for e in enum):
        return False
    any_of = schema.get("anyOf")
    if isinstance(any_of, list) and not any(_matches(s, value) for s in any_of):
        return False
    if "type" in schema:
        kinds = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_matches_type(k, value) for k in kinds):
            return False
    items = schema.get("items")
    if isinstance(value, list) and isinstance(items, dict):
        if not all(_matches(items, item) for item in value):
            return False
    if isinstance(value, dict):
        properties = schema.get("properties") or {}
        if any(name not in value for name in schema.get("required") or []):
            return False
        extra = schema.get("additionalProperties")
        for key, item in value.items():
            sub = properties.get(key, extra if isinstance(extra, dict) else None)
            if sub is not None and not _matches(sub, item):
                return False
    return True


def input_problems(schema: Mapping[str, Any], inputs: Mapping[str, Any]) -> list[str]:
    """输入是否符合节点类型的输入 schema；返回问题列表（空表示通过）。

    与控制面派发前的检查相同：必填输入要给出，声明了的输入要符合类型，没有声明的输入不检查。
    """
    properties: Mapping[str, Any] = schema.get("properties") or {}
    problems = [
        f"缺少必填输入 {name}" for name in schema.get("required") or [] if name not in inputs
    ]
    for name, value in inputs.items():
        sub = properties.get(name)
        if sub is not None and not _matches(sub, value):
            problems.append(f"输入 {name} 应为 {_describe(sub)}，实际是 {_show(value)}")
    return problems


def _has_type(schema: Mapping[str, Any], kind: str) -> bool:
    """扩展类型的输入（例如 `sfly.AgentName` 或 `AgentName | None`）：带 `x-sfly-type: <kind>`。"""
    if schema.get("x-sfly-type") == kind:
        return True
    members = schema.get("anyOf")
    return isinstance(members, list) and any(
        isinstance(m, dict) and m.get("x-sfly-type") == kind for m in members
    )


def _referenced(schema: Mapping[str, Any], inputs: Mapping[str, Any], kind: str) -> list[str]:
    properties: Mapping[str, Any] = schema.get("properties") or {}
    names: list[str] = []
    for name, value in inputs.items():
        sub = properties.get(name)
        if isinstance(sub, dict) and _has_type(sub, kind) and isinstance(value, str) and value:
            if value not in names:
                names.append(value)
    return names


def referenced_agents(schema: Mapping[str, Any], inputs: Mapping[str, Any]) -> list[str]:
    """输入通过「Agent」类型的参数引用的 Agent 名称（去重，按参数顺序，空值不算）。"""
    return _referenced(schema, inputs, "agent")


def referenced_feishu_bots(schema: Mapping[str, Any], inputs: Mapping[str, Any]) -> list[str]:
    """输入通过「飞书机器人」类型的参数引用的机器人名称（去重，按参数顺序，空值不算）。"""
    return _referenced(schema, inputs, "feishu_bot")


# ---- 执行 ----


def _now_ms() -> int:
    return int(time.time() * 1000)


_SDK_LEVELS = {
    "debug": "debug",
    "info": "info",
    "warn": "warn",
    "warning": "warn",
    "error": "error",
}


class _EventsPipe:
    """SDK 写入事件的命名管道（`SFLY_EVENTS`，与 Agent 相同，ADR 0015）。

    在启动执行器之前创建：先以非阻塞方式打开读端，再自己持有一个写端（没有任何写者时读端读到
    EOF），然后把读端改回阻塞模式交给读取线程。执行器退出后 `close_writer()`，其余写者也都关闭后
    读取线程结束。
    """

    def __init__(self, path: Path) -> None:
        path.unlink(missing_ok=True)
        os.mkfifo(path, 0o600)
        self.read_fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        self._write_fd: int | None = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
        _grow_pipe(self.read_fd)
        os.set_blocking(self.read_fd, True)

    def close_writer(self) -> None:
        if self._write_fd is not None:
            os.close(self._write_fd)
            self._write_fd = None


def _grow_pipe(fd: int) -> None:
    """把管道容量调到 `/proc/sys/fs/pipe-max-size`；不支持或失败时保持默认。"""
    try:
        import fcntl

        size = int(Path("/proc/sys/fs/pipe-max-size").read_text(encoding="ascii"))
        fcntl.fcntl(fd, fcntl.F_SETPIPE_SZ, size)
    except (ImportError, AttributeError, OSError, ValueError):
        pass


def _optional_int(value: Any) -> int | None:
    return None if value is None else int(value)


def _fields(value: Any) -> dict[str, str]:
    return {str(k): str(v) for k, v in (value or {}).items()}


def _result(value: Any) -> ActionResult:
    return ACTION_RESULTS[str(value)]


def _action_index(actions: list[ActionRecord], action_id: int) -> int:
    """`actions`（按 ID 升序）里 ID 不小于 `action_id` 的第一项的位置。"""
    return bisect.bisect_left(actions, action_id, key=lambda record: record.id)


def _action_record(
    entry: Mapping[str, Any], kind: Literal["action", "mark"], ts: int
) -> ActionRecord:
    """事件或摘要里的一项（不含结果）：`ts` 由调用方给，读事件时取事件里的 `ts`，事件没有 `ts` 时取
    读到它的时刻（见 `_event`），摘要里的项取它自己的 `ts`。"""
    return ActionRecord(
        id=int(entry["id"]),
        kind=kind,
        name=str(entry["name"]),
        parent=_optional_int(entry.get("parent")),
        depth=int(entry.get("depth") or 0),
        fields=_fields(entry.get("fields")),
        ts=ts,
        mono=int(entry["mono"]),
    )


def _summary_record(entry: Mapping[str, Any]) -> ActionRecord:
    """摘要里的一项（正在做的、最近结束的）。"""
    record = _action_record(entry, "action", int(entry["ts"]))
    if "end_mono" not in entry:
        return record
    return dataclasses.replace(
        record,
        result=_result(entry["result"]),
        reason=entry.get("reason"),
        duration_ms=max(0, int(entry["end_mono"]) - record.mono),
    )


def _action_summary(ts: int, event: Mapping[str, Any]) -> ActionSummary:
    return ActionSummary(
        ts=ts,
        total=int(event["total"]),
        marks=int(event["marks"]),
        reported=int(event["reported"]),
        capped_ts=_optional_int(event.get("capped_ts")),
        names=[
            ActionCount(
                str(n["name"]),
                int(n["total"]),
                int(n["failed"]),
                int(n["reported"]),
                _optional_int(n.get("capped_ts")),
            )
            for n in event["names"]
        ],
        running=[_summary_record(e) for e in event["running"]],
        recent=[_summary_record(e) for e in event["recent"]],
        recent_failed=[_summary_record(e) for e in event["recent_failed"]],
    )


class _Pump:
    """读取执行器的标准输出 / 标准错误和事件管道，转成日志、进度、指标。"""

    def __init__(
        self,
        execution: Execution,
        events: _EventsPipe,
        on_log: Callable[[LogLine], None] | None,
        on_progress: Callable[[Progress], None] | None,
        on_metric: Callable[[MetricPoint], None] | None,
        on_notify: Callable[[Notification], None] | None,
        on_action: Callable[[ActionRecord], None] | None,
        feishu_bots: list[str] | None,
    ) -> None:
        self._execution = execution
        self._events = events
        #: 读到的标准输出 / 标准错误的行和事件管道的行，各带读到它时的单调时钟读数（毫秒）。
        self._lines: queue.Queue[tuple[int, LogLine]] = queue.Queue()
        self._event_lines: queue.Queue[tuple[int, bytes]] = queue.Queue()
        self._readers: list[threading.Thread] = []
        self._on_log = on_log
        self._on_progress = on_progress
        self._on_metric = on_metric
        self._on_notify = on_notify
        self._on_action = on_action
        #: 这一次 `poll` 里读到的日志行、动作和标记的变化：(读到它时的单调时钟读数, 内容)，
        #: 按读到的先后交错着回调。
        self._changes: list[tuple[int, LogLine | ActionRecord]] = []
        #: 任务引用的飞书机器人；None 表示不知道输入的类型，不检查。
        self._feishu_bots = feishu_bots
        #: 标准错误最后的 `_STDERR_TAIL_BYTES` 字节（错误摘要用，不读 stderr.log）。
        self.stderr_tail = bytearray()
        self._start(self._read_events)

    def _start(self, target: Callable[[], None]) -> None:
        thread = threading.Thread(target=target, daemon=True)
        thread.start()
        self._readers.append(thread)

    def _read_events(self) -> None:
        partial = b""
        fd = self._events.read_fd
        try:
            while data := os.read(fd, 64 * 1024):
                read_at = monotonic_ms()
                complete, sep, partial = (partial + data).rpartition(b"\n")
                if not sep:
                    continue
                for line in complete.split(b"\n"):
                    if line:
                        self._event_lines.put((read_at, line))
        finally:
            os.close(fd)

    def read_pipe(self, pipe: IO[bytes], copy: Path, source: str, level: str) -> None:
        tail = self.stderr_tail if source == "stderr" else None

        def run() -> None:
            with pipe, copy.open("wb") as out:
                for raw in iter(pipe.readline, b""):
                    if tail is not None:
                        tail.extend(raw)
                        del tail[:-_STDERR_TAIL_BYTES]
                    out.write(raw)
                    out.flush()
                    line = raw[:-1] if raw.endswith(b"\n") else raw
                    if line.endswith(b"\r"):
                        line = line[:-1]
                    for start in range(0, max(len(line), 1), _MAX_LINE_BYTES):
                        chunk = line[start : start + _MAX_LINE_BYTES]
                        text = chunk.decode("utf-8", errors="replace")
                        self._lines.put((monotonic_ms(), LogLine(_now_ms(), source, level, text)))

        self._start(run)

    def poll(self) -> None:
        """读出新增的事件和管道里的行；同一批内按读到的先后（单调时钟）排，和 Agent 一样：
        事件里的 `ts` 是 SDK 读的系统时钟，往回跳时不能拿它当先后。"""
        while True:
            try:
                self._changes.append(self._lines.get_nowait())
            except queue.Empty:
                break
        while True:
            try:
                read_at, raw = self._event_lines.get_nowait()
            except queue.Empty:
                break
            self._event(raw, read_at)
        changes, self._changes = self._changes, []
        # 日志和动作、标记的变化一起排（读到的时刻相同的保持读到的先后），打印时交错显示。
        for _, item in sorted(changes, key=lambda pair: pair[0]):
            if isinstance(item, LogLine):
                self._execution.logs.append(item)
                if self._on_log is not None:
                    self._on_log(item)
            elif self._on_action is not None:
                self._on_action(item)

    def drain(self) -> None:
        """执行器已退出：关掉自己的事件管道写端，等各个管道关闭（最多等一会儿），读完剩余内容。"""
        self._events.close_writer()
        deadline = time.monotonic() + _DRAIN_TIMEOUT
        for thread in self._readers:
            thread.join(max(0.0, deadline - time.monotonic()))
        self.poll()
        self._end_unfinished_actions()

    def _event(self, raw: bytes, read_at: int) -> None:
        """处理事件管道里的一行；`read_at` 是读到它时的单调时钟读数。"""
        try:
            event = json.loads(raw)
            handler = _EVENT_HANDLERS.get(event["type"])
            if handler is not None:
                handler(self, read_at, int(event.get("ts") or _now_ms()), event)
                return
        except (ValueError, TypeError, KeyError, AttributeError):
            pass
        # 不认识的内容原样记成一行 SDK 日志。
        line = LogLine(_now_ms(), "sdk", "info", raw.decode("utf-8", errors="replace"))
        self._changes.append((read_at, line))

    def _log(self, read_at: int, ts: int, event: Mapping[str, Any]) -> None:
        level = _SDK_LEVELS.get(str(event.get("level", "")), "info")
        line = LogLine(ts, "sdk", level, str(event.get("message", "")))
        self._changes.append((read_at, line))

    def _progress(self, read_at: int, ts: int, event: Mapping[str, Any]) -> None:
        total = event.get("total")
        progress = Progress(
            ts,
            float(event["current"]),
            None if total is None else float(total),
            str(event.get("message", "")),
        )
        self._execution.progress.append(progress)
        if self._on_progress is not None:
            self._on_progress(progress)

    def _metric(self, read_at: int, ts: int, event: Mapping[str, Any]) -> None:
        metric_kind = "counter" if event.get("kind") == "counter" else "gauge"
        labels = event.get("labels") or {}
        point = MetricPoint(
            ts,
            str(event["name"]),
            metric_kind,
            float(event["value"]),
            {str(k): str(v) for k, v in labels.items()},
        )
        self._execution.metrics.append(point)
        if self._on_metric is not None:
            self._on_metric(point)

    def _summary(self, read_at: int, ts: int, event: Mapping[str, Any]) -> None:
        self._execution.action_summary = _action_summary(ts, event)

    def _action_started(self, read_at: int, ts: int, event: Mapping[str, Any]) -> None:
        """`action_start` 和 `mark` 各记一项（动作开始、标记发生）。"""
        record = _action_record(event, "action" if event["type"] == "action_start" else "mark", ts)
        actions = self._execution.actions
        # 一般按 ID 递增到达；超过每种名称的上限、失败时补发的开始比后面的行早，插到该在的位置。
        if not actions or record.id > actions[-1].id:
            actions.append(record)
        else:
            actions.insert(_action_index(actions, record.id), record)
        self._changes.append((read_at, record))

    def _action_ended(self, read_at: int, ts: int, event: Mapping[str, Any]) -> None:
        actions = self._execution.actions
        index = _action_index(actions, int(event["id"]))
        if index == len(actions) or actions[index].id != int(event["id"]):
            return
        started = actions[index]
        reason = event.get("reason")
        ended = dataclasses.replace(
            started,
            fields={**started.fields, **_fields(event.get("fields"))},
            result=_result(event["result"]),
            reason=None if reason is None else str(reason),
            duration_ms=max(0, int(event["mono"]) - started.mono),
        )
        actions[index] = ended
        self._changes.append((read_at, ended))

    def _end_unfinished_actions(self) -> None:
        """节点结束时还没结束的动作记为 `unfinished`，结束时间取现在；摘要里「正在做」清空。"""
        now_mono = monotonic_ms()
        actions = self._execution.actions
        for index, record in enumerate(actions):
            if record.kind == "action" and record.result is None:
                ended = dataclasses.replace(
                    record, result="unfinished", duration_ms=max(0, now_mono - record.mono)
                )
                actions[index] = ended
                if self._on_action is not None:
                    self._on_action(ended)
        summary = self._execution.action_summary
        if summary is not None:
            self._execution.action_summary = dataclasses.replace(summary, running=[])

    def _notify(self, read_at: int, ts: int, event: Mapping[str, Any]) -> None:
        """一次 `ctx.notify`：与控制面相同，只认任务引用的机器人，原始消息要合格，
        不发送的写一行警告。"""
        bot = str(event["bot"])
        if self._feishu_bots is not None and bot not in self._feishu_bots:
            return self._not_sent(
                read_at,
                ts,
                f"飞书机器人「{bot}」不是通过「飞书机器人」类型的参数传给这个节点的，"
                "把它声明成 sfly.FeishuBot 类型的参数",
            )
        if "message" in event:
            problem = raw_message_problem(event["message"])
            if problem is not None:
                return self._not_sent(read_at, ts, problem)
            body = event["message"]
        else:
            body = text_message(str(event["text"]), bool(event.get("at_all")))
        notification = Notification(ts, bot, body)
        self._execution.notifications.append(notification)
        if self._on_notify is not None:
            self._on_notify(notification)

    def _not_sent(self, read_at: int, ts: int, reason: str) -> None:
        line = LogLine(ts, "system", "warn", f"ctx.notify 的消息没有发送：{reason}")
        self._changes.append((read_at, line))


#: 读取端认识的事件类型 → 处理函数（`_Pump` 的方法；参数是读到这一行时的单调时钟读数、事件时间、
#: 解析后的事件）。
#: 事件类型的集合与 Agent 相同，两端对着 `testdata/local-protocol-cases.json` 核对：
#: 只在一端加一种事件，两端的测试会红。
_EVENT_HANDLERS: dict[str, Callable[[_Pump, int, int, Mapping[str, Any]], None]] = {
    "log": _Pump._log,
    "progress": _Pump._progress,
    "metric": _Pump._metric,
    "notify": _Pump._notify,
    "action_start": _Pump._action_started,
    "action_end": _Pump._action_ended,
    "mark": _Pump._action_started,
    "action_summary": _Pump._summary,
}
EVENT_TYPES = frozenset(_EVENT_HANDLERS)


def _signal_group(pgid: int, sig: int) -> None:
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def _group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def execute(
    entry: str,
    inputs: Mapping[str, Any],
    work_dir: str | os.PathLike[str],
    *,
    schema: Mapping[str, Any] | None = None,
    pythonpath: Iterable[str | os.PathLike[str]] = (),
    python: str = sys.executable,
    grace: float = DEFAULT_GRACE,
    cancellation: Cancellation | None = None,
    on_log: Callable[[LogLine], None] | None = None,
    on_progress: Callable[[Progress], None] | None = None,
    on_metric: Callable[[MetricPoint], None] | None = None,
    on_notify: Callable[[Notification], None] | None = None,
    on_action: Callable[[ActionRecord], None] | None = None,
    on_tick: Callable[[Execution], None] | None = None,
    run_id: str = "local",
    node_id: str | None = None,
    procs_dir: str | os.PathLike[str] | None = None,
    downloads: Mapping[str, bytes | str | os.PathLike[str]] | None = None,
    agents: Mapping[str, str | os.PathLike[str]] | None = None,
) -> Execution:
    """在 `work_dir`（不存在时创建）里执行节点入口 `模块:函数`，等它结束并返回结果。

    - `schema`：节点类型的输入 schema（`sfly build` 生成的 inputs），给出时先校验参数；
    - `pythonpath`：执行器子进程额外的模块搜索路径（放在 PYTHONPATH 最前面）；
    - `cancellation`：取消请求；`on_tick` 在执行期间定期以部分结果调用，可以在里面请求取消；
    - `on_log` / `on_progress` / `on_metric` / `on_notify`：每读到一条就调用（实时显示用）；
      `on_action`：动作开始、标记发生、动作结束时调用，参数是变化后的记录（`kind` 为 `mark` 的是
      标记，只调用一次；`kind` 为 `action` 的，没有 `result` 是开始，有 `result` 是结束）；
      节点结束时还没结束的动作也以 `unfinished` 调用一次；
    - `run_id`、`node_id`（默认取入口的函数名）：写进 task.json，节点里是 `ctx.task`；
    - `procs_dir`：后台进程目录（`ctx.procs_dir`），默认 `work_dir/procs`；
    - `downloads`：产物引用 → 本地内容（bytes / str 是内容，str 按 UTF-8；路径是本地文件）。
      节点用 `ctx.artifacts.download` 下载表里的引用时得到这份内容，不访问网络。
    - `agents`：Agent 名称 → 本地目录：节点用 `ctx.agent(名称)` 访问那台 Agent 时，
      那台 Agent 上的绝对路径落在这个目录里（`/var/log` 是 `<目录>/var/log`）。
    """
    work = Path(work_dir)
    execution = Execution(status="running", work_dir=work)

    def fail(kind: str, message: str) -> Execution:
        execution.status = "failed"
        execution.error = NodeError(kind, message)
        return execution

    if not isinstance(inputs, Mapping):
        return fail("config_error", "任务输入不是 JSON 对象")
    try:
        inputs = json.loads(json.dumps(dict(inputs), ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError) as error:
        return fail("config_error", f"任务输入不能序列化为 JSON：{error}")
    if schema is not None:
        problems = input_problems(schema, inputs)
        if problems:
            return fail("config_error", "; ".join(problems))

    (work / "artifacts").mkdir(parents=True, exist_ok=True)
    task = work / "task.json"
    task.write_text(
        json.dumps(
            {
                "task_id": "local",
                "attempt": 1,
                "run_id": run_id,
                "node_id": node_id or entry.rpartition(":")[2].rpartition(".")[2],
                "entry": entry,
                "inputs": inputs,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    output, cancel_marker = work / "output.json", work / "cancel"
    events = _EventsPipe(work / "events.fifo")
    env = {k: v for k, v in os.environ.items() if not k.startswith("SFLY_")}
    paths = [os.fspath(p) for p in pythonpath]
    if os.environ.get("PYTHONPATH"):
        paths.append(os.environ["PYTHONPATH"])
    if paths:
        env["PYTHONPATH"] = os.pathsep.join(paths)
    env.update(
        SFLY_TASK=str(task),
        SFLY_OUTPUT=str(output),
        SFLY_ARTIFACTS=str(work / "artifacts"),
        SFLY_EVENTS=str(work / "events.fifo"),
        SFLY_CANCEL=str(cancel_marker),
        SFLY_PROCS=str(
            Path(procs_dir).absolute() if procs_dir is not None else work.absolute() / "procs"
        ),
    )
    if downloads:
        env["SFLY_DOWNLOADS"] = str(_write_downloads(work, downloads))
    local_agents = work.absolute() / "local-agents.json"
    mapped = {name: str(Path(root).absolute()) for name, root in (agents or {}).items()}
    referenced = referenced_agents(schema, inputs) if schema is not None else []
    local_agents.write_text(
        json.dumps({name: mapped.get(name) for name in referenced}, ensure_ascii=False),
        encoding="utf-8",
    )
    env["SFLY_LOCAL_AGENTS"] = str(local_agents)
    feishu_bots = referenced_feishu_bots(schema, inputs) if schema is not None else None
    pump = _Pump(
        execution, events, on_log, on_progress, on_metric, on_notify, on_action, feishu_bots
    )
    # 执行器自成一个进程组（不在终端的前台进程组里，Ctrl-C 不会直接打到它），取消时整组终止。
    try:
        proc = subprocess.Popen(
            [python, "-u", "-m", "sfly.runner"],
            cwd=work,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except BaseException:
        events.close_writer()
        raise
    assert proc.stdout is not None and proc.stderr is not None
    pump.read_pipe(proc.stdout, work / "stdout.log", "stdout", "info")
    pump.read_pipe(proc.stderr, work / "stderr.log", "stderr", "error")
    cancellation = cancellation or Cancellation()

    try:
        while proc.poll() is None and not cancellation.requested:
            pump.poll()
            if on_tick is not None:
                on_tick(execution)
            if not cancellation.requested:
                time.sleep(_TICK)
    except BaseException:
        # 回调抛出异常（或测试被中断）时不留下孤儿进程。
        _signal_group(proc.pid, signal.SIGKILL)
        proc.wait()
        events.close_writer()
        raise

    if cancellation.requested and proc.poll() is None:
        how = _cancel(proc, cancel_marker, cancellation, grace, pump)
        pump.drain()
        execution.status = "cancelled"
        execution.error = NodeError("cancelled", f"任务已取消，{how}")
        return execution

    pump.drain()
    try:
        result = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        result = None
    if isinstance(result, dict) and result.get("status") == "success" and proc.returncode == 0:
        execution.status = "success"
        execution.outputs = result.get("outputs") or {}
    elif isinstance(result, dict) and result.get("status") == "failed":
        failure = result.get("error") or {}
        execution.status = "failed"
        execution.error = NodeError(
            "node_error",
            str(failure.get("message", "")),
            failure.get("type"),
            str(failure.get("traceback", "")),
        )
    else:
        fail(
            "node_error",
            f"执行器异常退出（退出码 {proc.returncode}），没有写出结果\n\n"
            + pump.stderr_tail[-_STDERR_TAIL_BYTES:].decode("utf-8", errors="replace").rstrip(),
        )
    return execution


def _write_downloads(work: Path, downloads: Mapping[str, bytes | str | os.PathLike[str]]) -> Path:
    """写下载内容表 `downloads.json`（产物引用 → 本地文件的绝对路径），返回它的路径。

    直接给出的内容存成 `work/downloads/<序号>`；给出路径的文件不复制。
    """
    table: dict[str, str] = {}
    for index, (ref, content) in enumerate(downloads.items()):
        if isinstance(content, (bytes, str)):
            path = work.absolute() / "downloads" / str(index)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content.encode("utf-8") if isinstance(content, str) else content)
        else:
            path = Path(content).absolute()
        table[ref] = str(path)
    target = work.absolute() / "downloads.json"
    target.write_text(json.dumps(table, ensure_ascii=False), encoding="utf-8")
    return target


def _cancel(
    proc: subprocess.Popen[bytes],
    marker: Path,
    cancellation: Cancellation,
    grace: float,
    pump: _Pump,
) -> str:
    """取消：写取消标记，向进程组发 SIGTERM，等整组退出，最多等 grace 秒，仍未退出的强制杀掉。"""
    try:
        marker.write_text("", encoding="utf-8")
    except OSError as error:
        print(f"无法写入取消标记 {marker}：{error}", file=sys.stderr)
    pgid = proc.pid
    terminated = not cancellation.forced
    if terminated:
        _signal_group(pgid, signal.SIGTERM)
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline and not cancellation.forced:
            # 先回收组长，否则它的僵尸进程会让进程组一直“活着”。
            if proc.poll() is not None and not _group_alive(pgid):
                break
            pump.poll()
            time.sleep(_TICK)
        terminated = not cancellation.forced
    _signal_group(pgid, signal.SIGKILL)
    proc.wait()
    return "已终止进程树" if terminated else "已强制杀掉进程树"
