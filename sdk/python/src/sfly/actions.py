"""动作与标记：记录节点此刻在做什么（规格 #345）。只用标准库（ADR 0002）。

**动作**是节点做的一件有开始和结束的事，带名称、开始和结束的时间、结果和几个说明字段；
**标记**只记一个时刻。平台只记录和展示它们，不从动作计算指标，失败的动作也不改变节点的状态。

    with ctx.action("下单", 订单=oid, 价格=price) as a:     # 正常结束是成功
        ...
        a.note(回报="已成交")        # 动作进行中补充字段
        a.fail("拒单：余额不足")      # 标记失败，不抛异常；动作在离开 with 时结束

    handle = ctx.action.start("保持", 时长="4h")   # 开始和结束不在同一段代码里
    ...
    handle.end()                                  # 或 handle.fail("原因")，也可以 handle.note(...)

    ctx.mark("收到第一笔成交", 订单=oid)           # 一个时刻

结果：

- 成功：`with` 正常结束，或调用了 `end()`；
- 失败：调用了 `fail()`，或 `with` 里抛出了 `Cancelled` 以外的异常；原因写成 `<异常类型>: <消息>`，
  异常照常往外抛。已经调用过 `fail()` 的动作，之后即使抛出 `Cancelled` 也还是失败；
- 未结束：`with` 里抛出了 `Cancelled`；节点进程被强制终止、任务结束时还没结束的动作，由读取事件的
  一方（控制面、本地调试）记为未结束。

父动作：默认是当前上下文里最内层的 `with ctx.action(...)`，用 `contextvars` 实现，所以同一个线程、
同一个 asyncio 任务里自动嵌套，新线程从最外层开始。`start()` 返回的句柄不会自动成为别人的父动作，
需要时用 `parent=` 指定（`ctx.action.start(名称, parent=句柄)`、`ctx.mark(名称, parent=句柄)`）。

校验：名称为空（或只有空白）抛 `ValueError`，不是字符串抛 `TypeError`，调用时立即报错。
下面这些不报错，截断或丢弃，每种原因写一条 warn 日志：名称超过 64 个字符、字段超过 8 个
（多出的丢弃）、字段值（转成字符串后）超过 256 个字符。同一个句柄结束两次，第二次忽略，警告一次；
不同名称超过 100 种时警告一次（名称里带了订单号这类每次都不同的内容，变化的内容放进字段）。

上限：每种名称最多上报 50000 个明细，合计最多 100000 个；超过以后只计数，警告一次，建议按批或
按阶段记录、每一笔的延迟用指标。失败的动作不受每种名称上限的限制：结束时把开始和结束补上，
直到合计 100000 个。正在做的动作、最近结束的 20 个、最近失败的 5 个、每种名称的总数和失败数
始终准确，由 `action_summary` 汇总发出：有变化时才发，每秒最多一次，节点进程退出时尽力再发一次。

事件的格式（`action_start`、`action_end`、`mark`、`action_summary`）见 `sfly.context` 的模块说明。
"""

from __future__ import annotations

import atexit
import heapq
import itertools
import os
import threading
import time
from collections import deque
from collections.abc import Callable, Collection, Mapping
from contextvars import ContextVar, Token
from typing import Any, Literal

from sfly.context import Cancelled, _EventWriter, _now_ms, monotonic_ms

#: 名称最长的字符数，超过的截断。
MAX_NAME_CHARS = 64
#: 一个动作最多的字段数（开始时给的和 `note()` 补充的合计），多出的丢弃。
MAX_FIELDS = 8
#: 字段值（转成字符串后）最长的字符数，超过的截断。
MAX_VALUE_CHARS = 256
#: 失败原因最长的字符数，超过的截断：原因随摘要每秒发一次，不能无限长。
MAX_REASON_CHARS = 4096
#: 不同的名称超过这么多种时警告一次（不限制）。
MAX_NAMES = 100
#: 每种名称最多上报的明细个数。
MAX_PER_NAME = 50_000
#: 全部名称合计最多上报的明细个数。
MAX_TOTAL = 100_000
#: 摘要里「正在做」、「最近结束」、「最近失败」最多列出的个数。
RUNNING_LIMIT = 50
RECENT_LIMIT = 20
RECENT_FAILED_LIMIT = 5
#: 摘要最短的发送间隔（秒）。
SUMMARY_INTERVAL = 1.0

Result = Literal["success", "failed", "unfinished"]

#: 当前上下文里最内层的、还在进行的 `with ctx.action(...)`（线程、asyncio 任务各有各的）。
_CURRENT: ContextVar[ActionScope | None] = ContextVar("sfly_action", default=None)

#: 摘要有变化、还没发出的 Actions：进程退出时发出（这里持有引用，节点函数返回后它们不会先被回收）。
_PENDING: set[Actions] = set()


def _stamp() -> tuple[int, int]:
    """同一时刻的 Agent 时间（Unix 毫秒）和单调时钟读数（毫秒）。"""
    return _now_ms(), monotonic_ms()


def _reason(message: object) -> str:
    text = message if isinstance(message, str) else str(message)
    if len(text) > MAX_REASON_CHARS:
        return text[: MAX_REASON_CHARS - 1] + "…"
    return text


def _exception_reason(exc_type: type[BaseException], exc: BaseException | None) -> str:
    detail = str(exc) if exc is not None else ""
    return _reason(f"{exc_type.__name__}: {detail}" if detail else exc_type.__name__)


class _NameStats:
    """一种名称的计数。"""

    __slots__ = ("capped", "failed", "reported", "total")

    def __init__(self) -> None:
        self.total = 0
        self.failed = 0
        #: 已上报明细的个数（不含失败时补发的）。
        self.reported = 0
        #: 从什么时候起只计数：第一个没有上报明细的动作开始的 (Agent 时间, 单调时钟读数)。
        self.capped: tuple[int, int] | None = None


class _Record:
    """一个动作或标记的状态。"""

    __slots__ = (
        "depth",
        "end_mono",
        "end_ts",
        "fields",
        "id",
        "mono",
        "name",
        "notes",
        "parent",
        "reason",
        "reported",
        "result",
        "ts",
    )

    def __init__(
        self,
        id: int,
        parent: int | None,
        depth: int,
        name: str,
        fields: dict[str, str],
        ts: int,
        mono: int,
    ) -> None:
        self.id = id
        self.parent = parent
        self.depth = depth
        self.name = name
        #: 开始时给的字段；`note()` 补充的放在 `notes`。
        self.fields = fields
        self.notes: dict[str, str] = {}
        self.ts = ts
        self.mono = mono
        #: 是否上报了 `action_start`（超过上限的没有）。
        self.reported = False
        self.result: Result | None = None
        self.reason: str | None = None
        self.end_ts = 0
        self.end_mono = 0


def _depth_then_id(rec: _Record) -> tuple[int, int]:
    return rec.depth, rec.id


def _by_id(rec: _Record) -> int:
    return rec.id


def _capped(stamp: tuple[int, int] | None) -> dict[str, int | None]:
    return {
        "capped_ts": stamp[0] if stamp else None,
        "capped_mono": stamp[1] if stamp else None,
    }


def _entry(rec: _Record) -> dict[str, Any]:
    """摘要里的一项：正在做的动作没有 `end_*`、`result`、`reason`。"""
    entry: dict[str, Any] = {
        "id": rec.id,
        "parent": rec.parent,
        "depth": rec.depth,
        "name": rec.name,
        "fields": {**rec.fields, **rec.notes},
        "ts": rec.ts,
        "mono": rec.mono,
    }
    if rec.result is not None:
        entry["end_ts"] = rec.end_ts
        entry["end_mono"] = rec.end_mono
        entry["result"] = rec.result
        entry["reason"] = rec.reason
    return entry


class Action:
    """`ctx.action.start(...)` 返回的句柄：之后调用 `end()` 或 `fail(原因)` 结束动作，
    动作进行中可以用 `note(**字段)` 补充字段。

    它不会自动成为别人的父动作；要让别的动作挂在它下面，给 `parent=`。
    同一个句柄只能结束一次：第二次调用被忽略并警告一次。
    """

    __slots__ = ("_actions", "_rec")

    def __init__(self, actions: Actions, rec: _Record) -> None:
        self._actions = actions
        self._rec = rec

    def note(self, **fields: object) -> None:
        """补充字段（与开始时给的字段合计最多 8 个，同名的覆盖）。"""
        self._actions._note(self._rec, fields)

    def end(self) -> None:
        """动作成功结束。"""
        self._actions._finish(self._rec, "success", None)

    def fail(self, message: object) -> None:
        """动作失败结束，`message` 是失败的原因。不抛异常。"""
        self._actions._finish(self._rec, "failed", _reason(message))


class ActionScope:
    """`with ctx.action(名称, **字段) as a:` 里的 `a`（也是 `ctx.action(...)` 的返回值）。

    `a.note(**字段)` 补充字段；`a.fail(原因)` 把动作标记为失败但不抛异常，动作在离开 `with` 时才结束
    （多次调用保留第一次的原因）。
    """

    __slots__ = ("_actions", "_failure", "_fields", "_name", "_outer", "_rec", "_token")

    def __init__(self, actions: Actions, name: str, fields: dict[str, str]) -> None:
        self._actions = actions
        self._name = name
        self._fields = fields
        self._rec: _Record | None = None
        self._failure: str | None = None
        self._outer: ActionScope | None = None
        self._token: Token[ActionScope | None] | None = None

    def _started(self) -> _Record:
        if self._rec is None:
            raise RuntimeError("动作还没有开始：写成 `with ctx.action(...) as a:`，在 with 里用 a")
        return self._rec

    def note(self, **fields: object) -> None:
        """补充字段（与开始时给的字段合计最多 8 个，同名的覆盖）。"""
        self._actions._note(self._started(), fields)

    def fail(self, message: object) -> None:
        """把动作标记为失败，不抛异常；动作在离开 `with` 时结束。"""
        rec = self._started()
        if rec.result is not None:
            self._actions._ignored(rec)
        elif self._failure is None:
            self._failure = _reason(message)

    def __enter__(self) -> ActionScope:
        if self._rec is not None:
            raise RuntimeError("同一个动作只能进入一次：每次用 `ctx.action(...)` 新建")
        actions = self._actions
        self._outer = _CURRENT.get()
        parent = actions._default_parent(self._outer)
        self._rec = actions._begin(self._name, self._fields, parent, mark=False)
        self._token = _CURRENT.set(self)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: object,
    ) -> None:
        rec = self._started()
        if self._token is not None:
            try:
                _CURRENT.reset(self._token)
            except ValueError:
                # 在另一个上下文里退出（例如异步生成器的清理）：不能还原，直接设回外层。
                _CURRENT.set(self._outer)
        result: Result
        reason = self._failure
        if exc_type is None:
            result = "failed" if reason is not None else "success"
        elif issubclass(exc_type, Cancelled) and reason is None:
            result = "unfinished"
        elif issubclass(exc_type, Cancelled):
            result = "failed"
        else:
            result, reason = "failed", _exception_reason(exc_type, exc)
        self._actions._finish(rec, result, reason)


class Actions:
    """`ctx.action`：`ctx.action(名称, **字段)` 返回 `with` 用的上下文管理器，
    `ctx.action.start(名称, parent=None, **字段)` 返回句柄，`ctx.mark(名称, ...)` 记标记。
    用法见模块说明（`sfly.actions`）。

    `writer` 是事件管道的写入端，`warn(原因, 名称, 消息)` 写一条警告日志
    （同一个原因和名称只写一次）。
    """

    def __init__(self, writer: _EventWriter, warn: Callable[[str, str, str], None]) -> None:
        self._events = writer
        self._warn = warn
        self._pid = os.getpid()
        self._lock = threading.Lock()
        self._ids = itertools.count(1)
        self._names: dict[str, _NameStats] = {}
        self._total = 0
        self._reported = 0
        self._capped: tuple[int, int] | None = None
        self._running: dict[int, _Record] = {}
        self._recent: deque[_Record] = deque(maxlen=RECENT_LIMIT)
        self._recent_failed: deque[_Record] = deque(maxlen=RECENT_FAILED_LIMIT)
        # 摘要：有变化还没发出时 _dirty；至多一个定时器在等着发。
        self._dirty = False
        self._last_sent = -SUMMARY_INTERVAL
        self._timer: threading.Timer | None = None

    # ---- 公开接口 ----

    def __call__(self, name: str, /, **fields: object) -> ActionScope:
        """`with ctx.action("下单", 订单=oid) as a:`：块里做的是一个动作，进入开始，退出结束。"""
        name = self._check_name(name, "动作")
        return ActionScope(self, name, self._check_fields(fields, ()))

    def start(
        self,
        name: str,
        /,
        *,
        parent: Action | ActionScope | None = None,
        **fields: object,
    ) -> Action:
        """开始一个动作，返回句柄，之后调用 `end()` 或 `fail(原因)`。

        父动作默认是当前最内层的 `with ctx.action(...)`，`parent=` 显式指定。
        """
        name = self._check_name(name, "动作")
        clean = self._check_fields(fields, ())
        rec = self._begin(name, clean, self._parent_of(parent), mark=False)
        return Action(self, rec)

    def mark(
        self,
        name: str,
        /,
        *,
        parent: Action | ActionScope | None = None,
        **fields: object,
    ) -> None:
        """记一个时刻（标记）。"""
        name = self._check_name(name, "标记")
        clean = self._check_fields(fields, ())
        self._begin(name, clean, self._parent_of(parent), mark=True)

    # ---- 校验 ----

    def _check_name(self, name: object, what: str) -> str:
        if not isinstance(name, str):
            raise TypeError(f"{what}的名称必须是字符串，实际为 {name!r}")
        if not name.strip():
            raise ValueError(f"{what}的名称不能为空")
        if len(name) > MAX_NAME_CHARS:
            self._warn(
                "name-too-long",
                "",
                f"{what}的名称超过 {MAX_NAME_CHARS} 个字符，已截断"
                f"（名称写这件事是什么，细节放进字段）：{name[:MAX_NAME_CHARS]!r}…",
            )
            return name[:MAX_NAME_CHARS]
        return name

    def _check_fields(self, fields: Mapping[str, object], taken: Collection[str]) -> dict[str, str]:
        """字段值转成字符串、截断；字段超过上限时丢弃多出的。`taken` 是已经有的键。"""
        clean: dict[str, str] = {}
        if not fields:
            return clean
        keys = set(taken)
        for key, value in fields.items():
            if key not in keys:
                if len(keys) >= MAX_FIELDS:
                    self._warn(
                        "too-many-fields",
                        "",
                        f"动作的字段超过 {MAX_FIELDS} 个，多出的已丢弃"
                        "（字段留给要查的内容，不要放整份数据）",
                    )
                    continue
                keys.add(key)
            text = value if isinstance(value, str) else str(value)
            if len(text) > MAX_VALUE_CHARS:
                self._warn(
                    "value-too-long",
                    "",
                    f"动作的字段值超过 {MAX_VALUE_CHARS} 个字符，已截断（字段 {key!r}）",
                )
                text = text[:MAX_VALUE_CHARS]
            clean[key] = text
        return clean

    def _parent_of(self, parent: Action | ActionScope | None) -> _Record | None:
        """显式的父动作，没有给时取当前上下文里最内层的 `with` 动作。"""
        if parent is None:
            return self._default_parent(_CURRENT.get())
        if not isinstance(parent, (Action, ActionScope)):
            raise TypeError(f"parent 必须是 ctx.action 给出的动作，实际为 {parent!r}")
        if parent._actions is not self:
            raise ValueError("parent 是另一个任务上下文里的动作")
        rec = parent._rec
        if rec is None:
            raise ValueError("parent 这个动作还没有开始")
        return rec

    def _default_parent(self, innermost: ActionScope | None) -> _Record | None:
        # 当前上下文里的 with 动作可能属于另一个 Context（同一进程里有两个）：只认自己的。
        while innermost is not None and innermost._actions is not self:
            innermost = innermost._outer
        return innermost._rec if innermost is not None else None

    # ---- 开始、补充、结束 ----

    def _begin(
        self, name: str, fields: dict[str, str], parent: _Record | None, *, mark: bool
    ) -> _Record:
        ts, mono = _stamp()
        with self._lock:
            stats = self._names.get(name)
            if stats is None:
                stats = self._names[name] = _NameStats()
                if len(self._names) == MAX_NAMES + 1:
                    self._warn(
                        "too-many-names",
                        "",
                        f"动作的名称已超过 {MAX_NAMES} 种：名称里是不是带了订单号这类"
                        "每次都不同的内容？变化的内容放进字段"
                        "（ctx.action(名称, 订单=订单号)），名称只写这是一件什么事",
                    )
            stats.total += 1
            self._total += 1
            rec = _Record(
                next(self._ids),
                parent.id if parent is not None else None,
                parent.depth + 1 if parent is not None else 0,
                name,
                fields,
                ts,
                mono,
            )
            if stats.reported < MAX_PER_NAME and self._reported < MAX_TOTAL:
                stats.reported += 1
                self._reported += 1
                rec.reported = True
                self._events.write(self._start_event(rec, "mark" if mark else "action_start"))
            else:
                self._count_only(stats, rec)
            if not mark:
                self._running[rec.id] = rec
            self._changed()
        return rec

    def _count_only(self, stats: _NameStats, rec: _Record) -> None:
        """这个动作超过了上限，不上报明细：记下从什么时候起只计数，第一次时警告。"""
        if stats.capped is None:
            stats.capped = (rec.ts, rec.mono)
            if stats.reported >= MAX_PER_NAME:
                self._warn(
                    "name-cap",
                    rec.name,
                    f"{rec.name!r} 已记录 {MAX_PER_NAME} 个，之后只计数、不再上报明细"
                    f"（失败的动作仍会补上明细，直到合计 {MAX_TOTAL} 个）。"
                    "每一笔都记成动作会拖慢节点、也看不过来：按批或按阶段记录动作，"
                    "每一笔的延迟用指标",
                )
        if self._reported >= MAX_TOTAL and self._capped is None:
            self._capped = (rec.ts, rec.mono)
            self._warn(
                "total-cap",
                "",
                f"动作和标记已记录 {MAX_TOTAL} 个，之后只计数、不再上报明细"
                "（正在做的动作、最近的动作和各名称的计数仍然准确）。"
                "按批或按阶段记录动作，每一笔的延迟用指标",
            )

    def _note(self, rec: _Record, fields: Mapping[str, object]) -> None:
        with self._lock:
            if rec.result is not None:
                self._ignored(rec)
                return
            rec.notes.update(self._check_fields(fields, rec.fields.keys() | rec.notes.keys()))
            self._changed()

    def _finish(self, rec: _Record, result: Result, reason: str | None) -> None:
        ts, mono = _stamp()
        with self._lock:
            if rec.result is not None:
                self._ignored(rec)
                return
            rec.result, rec.reason, rec.end_ts, rec.end_mono = result, reason, ts, mono
            del self._running[rec.id]
            self._recent.append(rec)
            if result == "failed":
                self._names[rec.name].failed += 1
                self._recent_failed.append(rec)
            if rec.reported:
                self._events.write(self._end_event(rec))
            elif result == "failed" and self._reported < MAX_TOTAL:
                # 超过每种名称的上限、没有上报开始的动作，失败了就补上：
                # 先补开始（动作真正开始的时刻），再写结束。
                self._reported += 1
                self._events.write(self._start_event(rec, "action_start"))
                self._events.write(self._end_event(rec))
            self._changed()

    def _ignored(self, rec: _Record) -> None:
        self._warn(
            "already-ended",
            rec.name,
            f"动作 {rec.name!r} 已经结束，再次结束（或 note、fail）被忽略",
        )

    # ---- 事件 ----

    @staticmethod
    def _start_event(rec: _Record, kind: str) -> dict[str, Any]:
        return {
            "type": kind,
            "ts": rec.ts,
            "mono": rec.mono,
            "id": rec.id,
            "parent": rec.parent,
            "depth": rec.depth,
            "name": rec.name,
            "fields": rec.fields,
        }

    @staticmethod
    def _end_event(rec: _Record) -> dict[str, Any]:
        return {
            "type": "action_end",
            "ts": rec.end_ts,
            "mono": rec.end_mono,
            "id": rec.id,
            "result": rec.result,
            "reason": rec.reason,
            "fields": rec.notes,
        }

    def _summary_event(self) -> dict[str, Any]:
        ts, mono = _stamp()
        running = heapq.nsmallest(RUNNING_LIMIT, self._running.values(), key=_depth_then_id)
        running.sort(key=_by_id)
        return {
            "type": "action_summary",
            "ts": ts,
            "mono": mono,
            "total": self._total,
            "reported": self._reported,
            **_capped(self._capped),
            "names": [
                {"name": name, "total": s.total, "failed": s.failed, **_capped(s.capped)}
                for name, s in self._names.items()
            ],
            "running": [_entry(rec) for rec in running],
            "recent": [_entry(rec) for rec in reversed(self._recent)],
            "recent_failed": [_entry(rec) for rec in reversed(self._recent_failed)],
        }

    # ---- 摘要：有变化时发，每秒最多一次，退出时再发一次 ----

    def _changed(self) -> None:
        """摘要有变化了（持有 `_lock`）：距上一次满一秒就立即发，否则排一个定时器，到点再发。"""
        if not self._dirty:
            self._dirty = True
            _PENDING.add(self)
        if self._timer is not None or os.getpid() != self._pid:
            return
        self._send_or_wait()

    def _send_or_wait(self) -> None:
        wait = self._last_sent + SUMMARY_INTERVAL - time.monotonic()
        if wait <= 0:
            self._send_summary()
            return
        self._timer = threading.Timer(wait, self._on_timer)
        self._timer.daemon = True
        self._timer.start()

    def _send_summary(self) -> None:
        self._dirty = False
        _PENDING.discard(self)
        self._last_sent = time.monotonic()
        self._events.write(self._summary_event())

    def _on_timer(self) -> None:
        with self._lock:
            self._timer = None
            if self._dirty:
                try:
                    self._send_or_wait()
                except OSError:
                    # 管道已经断了（Agent 不在）：节点自己下一次写入会报错，这个线程里不用再报一次。
                    pass

    def flush(self) -> None:
        """进程退出时：还有没发出的变化就立即发出（尽力：写不出去时放弃）。"""
        if os.getpid() != self._pid:
            return
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            if self._dirty:
                try:
                    self._send_summary()
                except OSError:
                    pass


def _flush_pending() -> None:
    for actions in list(_PENDING):
        actions.flush()


atexit.register(_flush_pending)
