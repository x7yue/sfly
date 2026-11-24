"""任务上下文 `Context`：节点函数的首个参数。只用标准库（ADR 0002）。

- `ctx.log`：带级别的结构化日志，`ctx.log.info("checking %s", url)`，
  也可以 `ctx.log("...", level="warn")`；
- `ctx.progress(当前值, 总数, 说明)`：上报进度，总数未知时省略；
- `ctx.metric(指标名, 数值, labels={...})`：上报节点类型声明的指标，可以带标签
  （见 `Context.metric`）；
- `ctx.artifacts`：保存产物，返回可以写进输出的产物引用；按产物引用下载产物（见 `Artifacts`）；
- `ctx.cancelled()`：任务是否进入了收尾时间——被取消、超时、被停止子流程节点停止时 Agent 都先写
  取消标记（`SFLY_CANCEL` 文件），它存在就是真（不说明原因，任务的结局由原因决定）；
- `ctx.task`：当前任务的运行 ID、节点 ID、任务 ID、attempt（见 `TaskInfo`）；
- `ctx.procs_dir`：这次运行的后台进程目录（见 `Context.procs_dir`）；
- `ctx.agent()` / `ctx.agent(名称)`：自己所在的 Agent / 通过「Agent」类型的参数拿到的
  另一台 Agent 的能力（见 `Context.agent`、`sfly.capabilities`）；
- `ctx.notify(机器人, 文本)` / `ctx.notify(机器人, message=...)`：发一条飞书通知（文本或原始消息），
  由控制面发出，投递失败不抛异常（见 `Context.notify`、`sfly.feishu`）；
- `ctx.action(名称, **字段)` / `ctx.action.start(...)` / `ctx.mark(名称, **字段)`：记录节点正在做的
  事（动作）和某个时刻（标记）（见 `sfly.actions`）。

取消、超时、被停止子流程节点停止时，Agent 先写入取消标记，再向进程树发 SIGTERM；
执行器把 SIGTERM 变成节点里的 `Cancelled` 异常
（`BaseException` 的子类，`except Exception` 不会吞掉它），`finally` 和 `with` 里的清理代码会执行，
宽限期（默认 10 秒）过后整棵进程树被强制杀掉。一次取消，主线程里只抛一次 `Cancelled`：
清理代码不会被再打断一次。在后台线程里可以轮询 `ctx.cancelled()`。

日志和进度都追加写入本地协议的事件文件 `SFLY_EVENTS`
（JSONL，每行一个事件，Agent 持续读取新增内容）：

- 日志 `{"type": "log", "ts": <Unix 毫秒>, "level": "debug|info|warn|error", "message": "..."}`
- 进度 `{"type": "progress", "ts": ..., "current": 1, "total": 3, "message": "..."}`
  （`total` 可以是 null）
- 指标 `{"type": "metric", "ts": ..., "name": "tps", "kind": "gauge|counter", "value": 1.5}`，
  带标签时加 `"labels": {"pid": "1234"}`（值都是字符串；不带标签时没有这个字段）
- 通知 `{"type": "notify", "ts": ..., "bot": "ops", "text": "...", "at_all": false}`，发原始消息时是
  `{"type": "notify", "ts": ..., "bot": "ops", "message": {...}}`：Agent 不解析，
  原样转给控制面（Notification 消息），由控制面校验、组装请求体并写进发送队列
- 动作和标记（`ctx.action`、`ctx.mark`，规格 #345）有四种事件，见下一节。

`print` 和子进程的输出不经过这里：Agent 直接读取执行器的标准输出 / 标准错误，
与事件文件合并成同一条日志流。

动作和标记的四种事件
--------------------

动作有开始和结束，用 `action_start`、`action_end` 两种事件；标记只记一个时刻，用 `mark` 一种事件；
`action_summary` 汇总动作和标记的个数，并列出动作的现状。下面每条规则都写明管的是动作、标记，
还是两者。

每一行是一个 JSON 对象，字符串里的中文不转义。`ts` 是 Agent 时间（SDK 读系统时钟，Unix 毫秒，
整数），`mono` 是同一时刻 Agent 系统级单调时钟的读数（毫秒，整数，大于 0）：Linux 上是
`CLOCK_BOOTTIME`，其他平台是 `CLOCK_MONOTONIC`，和 Agent 的 `clock::monotonic_ms` 是同一个时钟
（ADR 0018）。
控制面用 `mono` 折算控制面时间、计算耗时，系统时间被改动时耗时不受影响。各行的 `ts`、`mono` 是事件
发生的时刻，不一定随行的先后递增（下面「补发」的 `action_start` 就比前面的行早）。

- `{"type": "action_start", "ts", "mono", "id": 7, "parent": 3, "depth": 1, "name": "下单",
  "fields": {"订单": "1001"}}`：一个动作开始。`id`、`parent`、`depth`、`name`、`fields` 的规则，
  标记（`mark`）也一样。
  - `id`：整数，任务内从 1 开始递增，由 SDK 分配；动作和标记共用这一个序列，同一个任务里
    ID 不重复。多个线程同时记录动作或标记时，先发生的不一定先拿到 ID：ID 的先后和时间的先后可能
    不一致。比较谁先发生要比较 `mono`，不比较 `id`；例如选「最外层、开始得最早的动作」时，
    在 `depth` 为 0 的动作里取 `mono` 最小的（`action_summary` 的 `running` 只有 50 个，见下面）。
  - `parent`：父动作的 `id`，最外层是 null；标记的 `parent` 是它属于哪个动作。父动作不一定有明细
    （超过上限时不上报它的 `action_start`；`start()` 的父动作也可能已经结束），所以读取方不能要求
    `parent` 指向一个已有的动作。
  - `depth`：整数，祖先的个数，最外层是 0，由 SDK 按 `parent` 算出（父动作没有明细时也准确）。
  - `name`：字符串，至少 1 个字符。`fields`：对象，最多 8 个键，键是字符串，值一律是字符串
    （SDK 已转成字符串）；没有字段时是 `{}`。名称、字段的键最长 64 个字符，字段值最长 256 个字符，
    由读取事件的一方（控制面、本地调试）截到这个上限，截断之前先把 secret 值打码：
    SDK 不知道哪些值是 secret，所以不在上限处截断，只在比上限多 4096 个字符处截断
    （传输的保护，`sfly.actions` 的 `TRANSPORT_MARGIN_CHARS`）。
  - `late`：只在补发的 `action_start` 上有，值是 `true`；平时没有这个字段。有它说明这个动作
    超过了每种名称的上限、没有在开始时上报，因为失败才补上（见下面「补发」）；读取方收到它就知道
    这个动作已经失败了，它的 `action_end` 紧跟在后面（中间不会有别的动作和标记的事件）。
- `{"type": "action_end", "ts", "mono", "id": 7, "result": "failed", "reason": "ValueError: 拒单",
  "fields": {"回报": "rejected"}}`：一个动作结束，只有动作有。
  - `result`：`success`、`failed`、`unfinished` 三者之一。`unfinished` 是 `with` 里抛出了
    `Cancelled`（已经调用过 `fail()` 的除外，那是 `failed`）；还有一种来源见下面「没有结束的动作」。
  - `reason`：失败的原因，其他结果是 null。有两种格式：`with` 里抛出的异常导致的失败是
    `<异常类型>: <消息>`（异常没有消息时只有 `<异常类型>`；先调用过 `fail()` 的也以异常为准）；
    调用 `fail()` 导致的失败是 `fail()` 给的文字原样（不是字符串的先转成字符串）。
    两种都最长 4096 个字符，由读取事件的一方截断（末尾是「…」），
    SDK 只在比它多 4096 个字符处截断，末尾同样是「…」（理由同 `name`）。
  - `fields`：这个动作上 `note()` 补充的字段，没有时是 `{}`。动作最终的字段是 `action_start` 的
    `fields` 再用它覆盖同名的键，合计仍不超过 8 个键。
  - 没有结束的动作不发 `action_end`：节点进程被强制终止、或者任务结束时还没结束的动作，由读取事件
    的一方（控制面、本地调试）记为 `unfinished`，结束时间取任务结束的时刻（标记没有这回事）。
  - 超过上限的动作（见下面「上限」）`action_start` 和 `action_end` 都不写，只计数；失败的例外，
    见下面「补发」。
- `{"type": "mark", "ts", "mono", "id": 8, "parent": 3, "depth": 1, "name": "收到第一笔成交",
  "fields": {}}`：一个标记，`ts`、`mono` 是它发生的时刻。没有持续时间，也没有结果，所以没有对应的
  结束事件，也不会出现在 `action_summary` 的 `running`、`recent`、`recent_failed` 里。
  标记发生时发这一行，之后不再发别的；超过上限的标记不写这一行，只计数，也不补发。
- `{"type": "action_summary", "ts", "mono", ...}`：目前为止的汇总，`ts`、`mono` 是发出这一行的时刻。
  发出时机：有变化时才发，每秒最多一次（距上一次不到一秒时推迟到满一秒），节点进程退出时，有还没发出的变化就尽力再发一次，写不出去就放弃。
  每一份都是完整的，只有最新一份有用。内容不受上限影响，超过上限之后仍然准确：

  ```
  {"type": "action_summary", "ts", "mono",
   "total": 120345, "marks": 2, "reported": 100000,
   "capped_ts": 1700000000000, "capped_mono": 123456789,
   "names": [{"name": "下单", "total": 120000, "failed": 12, "reported": 50012,
              "capped_ts": 1700000000000, "capped_mono": 123456789}],
   "running": [{"id", "parent", "depth", "name", "fields", "ts", "mono"}],
   "recent": [{"id", "parent", "depth", "name", "fields", "ts", "mono",
               "end_ts", "end_mono", "result", "reason"}],
   "recent_failed": [同 recent 的每一项]}
  ```

  - `total`：到目前为止记录的动作和标记的个数（不论有没有明细），`marks`：其中标记的个数；
    `reported`：已经上报明细（
    `action_start` 或 `mark`，包括补发的）的个数，最多 100000。
    `capped_ts`、`capped_mono`：第一个因为合计已满（100000 个）而被丢弃明细的动作或标记的时刻，
    动作取开始的时刻，标记取它发生的时刻（包括补发时发现合计已满、被丢弃的失败动作）。它不是明细的
    终点：这个时刻之后仍可能有已经上报的明细（例如更早开始、之后才补发的失败动作）。还没有因为合计
    已满丢弃过任何一个时是 null，合计正好达到 100000 个而没有丢弃时也是 null。
  - `names`：每种名称一项（动作和标记的名称在一起），按第一次出现的先后排列。`total`：这个名称的
    动作和标记的个数；`failed`：失败的动作的个数（标记没有结果）；`reported`：这个名称已经上报
    明细的个数，包括补发的，所以 `total` 减 `reported` 就是这个名称只计数、没有明细的个数
    （各名称的 `reported` 加起来等于外面的 `reported`）；`capped_ts`、`capped_mono`：这个名称从
    什么时候起只计数（超过 50000 个，或合计超过 100000 个以后；起点是第一个没有上报明细的动作或
    标记的时刻，动作取开始的时刻，标记取它发生的时刻），没有时是 null。失败的动作除外：超过这个
    名称的上限以后，失败的动作仍会补上明细，直到合计已满（见下面的补发）。
  - `running`：正在做的动作，只有动作，没有标记。最多 50 个，优先取层级浅的、同一层级里 `id` 小的，
    列表按 `id` 排列（不一定是开始的先后，见上面 `id`；要按开始的先后用 `mono`）。每一项有 `id`、
    `parent`、`depth`、`name`、`fields`（开始时的字段加上 `note()` 补充的）、`ts`、`mono`（开始的
    时刻）。最外层（`depth` 为 0）的动作同时进行的超过 50 个时，留下的是 `id` 最小的 50 个，而
    `id` 的先后不一定是开始的先后，所以真正开始得最早的那个可能不在 `running` 里。列表里正好
    50 个时，读取方要当作可能有遗漏（最外层的、更深层的都可能漏掉）；不到 50 个时是全部正在做的
    动作。
  - `recent`：最近结束的 20 个动作（任何结果），只有动作，最近结束的在前，每一项是 `running` 的
    字段再加 `end_ts`、`end_mono`（结束的时刻）、`result`、`reason`。`recent_failed`：最近失败的
    5 个，格式相同，最近失败的在前。
  - 超过上限没有明细的动作也在 `running`、`recent`、`recent_failed` 里，所以读取方会碰到没有明细的
    `id`：事件里没有它的 `action_start`，也可能没有 `action_end`。
  - 标记算进 `total`、`reported`、`names` 和 `capped_*`，不在 `running`、`recent`、`recent_failed`
    里。

上限：每种名称最多上报 50000 个明细，全部名称合计最多 100000 个，动作和标记都算，超过以后只计数。
摘要的 `names` 最多 1000 种，按第一次出现的先后；第 1001 种起新的名称不进摘要、不单独计数，
它们的明细照常上报（受合计的上限约束，没有每种名称的上限）。
动作超过上限时不写 `action_start` 和 `action_end`（失败的见「补发」），标记超过上限时不写 `mark`。

补发：只管动作。超过每种名称的上限（50000 个）、没有上报 `action_start` 的动作，如果以失败结束，
SDK 在结束时把明细补上（直到合计 100000 个）：连续写一行 `action_start`，时间是动作真正开始的
时刻，并带 `"late": true`，再写一行 `action_end`；除了 `late`，格式与平时完全相同。合计已经满了时
不补，这个失败动作的明细被丢弃，和开始时就超过合计上限的动作一样只计数，摘要里的 `capped_ts` 在
这时也会有值。标记没有结果，不补发。
"""

from __future__ import annotations

import _thread
import json
import math
import os
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, get_args

# 执行器每个任务启动一个进程（#76），导入 sfly 在每个任务的启动路径上：pathlib、threading、shutil、
# traceback、urllib.parse 只在构造 Context、保存产物、记录异常时才用到，推迟到用到时再导入。
if TYPE_CHECKING:
    from pathlib import Path

    from sfly.actions import Action, Actions, ActionScope
    from sfly.capabilities import Agent
    from sfly.nodes import Metric

#: 日志级别（与控制面、画布一致）。
LEVELS = ("debug", "info", "warn", "error")

#: 动作的结果，也是 `action_end` 里 `result` 的取值：写事件的 `sfly.actions` 和读事件的本地调试
#: （`sfly.local`、`sfly debug`）共用这一份。
ActionResult = Literal["success", "failed", "unfinished"]
#: 按事件里的文字查结果：读事件的一方遇到不认识的取值时抛 `KeyError`。
ACTION_RESULTS: dict[str, ActionResult] = {result: result for result in get_args(ActionResult)}

_FROM_ENV: Any = object()

#: 标签值的最大长度（字符数，与 packages/schema 一致）。
MAX_LABEL_VALUE_CHARS = 128

#: 每个任务所有指标的序列数上限（不带标签的指标各算 1 个，与 packages/schema 一致），不开放配置。
MAX_SERIES = 1000

_NO_LABEL_KEYS: frozenset[str] = frozenset()


class Cancelled(BaseException):
    """任务被取消（或超时）时，执行器收到 SIGTERM 后在节点代码里抛出。"""


class _Sigterm:
    """主线程里 `DeferCancel` 的嵌套层数、推迟期间是否收到了 SIGTERM，
    以及主线程里是否已经抛出过 `Cancelled`。"""

    main = _thread.get_ident()
    depth = 0
    pending = False
    raised = False


def _handling_cancelled() -> bool:
    """主线程此刻是不是正在处理一个 `Cancelled`（在 `except Cancelled` 或因它而进入的
    `finally` 里，包括里面又嵌着的 `except`）。

    后台线程里的 `Cancelled` 经队列、`Future.result()` 交给主线程重新抛出时，不经过
    `cancelled_error`（它只在主线程里记「已经抛出过」），`_Sigterm.raised` 还是 False：随后
    送达的 SIGTERM 会在节点清理到一半时再抛一次（#678）。看当前正在处理的异常，不管这个
    `Cancelled` 是谁抛的、怎么到的主线程。

    清理里常常逐个停东西、每个外面包一层 `except Exception: 记一句`：执行到里面那个块时，最里面
    正在处理的是停东西时出的错。它是在处理 `Cancelled` 的过程中抛出的，所以顺着 `__context__`
    往外找，链上有 `Cancelled` 就算。
    """
    import sys

    error = sys.exc_info()[1]
    seen: set[int] = set()
    while error is not None and id(error) not in seen:
        if isinstance(error, Cancelled):
            return True
        seen.add(id(error))
        error = error.__context__
    return False


def cancelled_error(message: str) -> Cancelled:
    """SDK 自己发现任务该收尾了（取消标记出现：取消、超时、被停止子流程节点停止；Agent 回复
    `cancelled`）时要抛出的 `Cancelled`。

    取消时这些和 SIGTERM 几乎同时到，谁先到不一定。主线程里先由 SDK 抛出时记下来，随后送达的
    SIGTERM 不再抛第二次：节点的 `except Cancelled` / `finally` 已经在执行，再抛一次会把清理打断。
    """
    if _thread.get_ident() == _Sigterm.main:
        _Sigterm.raised = True
    return Cancelled(message)


def on_sigterm(signum: int, frame: object) -> None:
    """执行器装的 SIGTERM 处理函数（只在主线程里执行）：在节点代码里抛出 `Cancelled`；
    正在 `DeferCancel` 里时推迟到离开它。主线程里已经抛出过 `Cancelled` 时什么都不做
    （见 `cancelled_error`）：一次取消，节点只收到一次 `Cancelled`。"""
    if _Sigterm.raised:
        return
    if _Sigterm.depth:
        _Sigterm.pending = True
        return
    _Sigterm.raised = True
    if _handling_cancelled():
        # 主线程已经在处理一个 Cancelled（后台线程的交给它重新抛出的）：清理在执行，不再抛第二次。
        return
    raise Cancelled("任务被终止（SIGTERM）")


class DeferCancel:
    """`with DeferCancel():` 这一段里收到的 SIGTERM 推迟到离开这一段时才变成 `Cancelled`。

    SDK 拿到要清理的资源（文件描述符、临时文件、子进程）时用，取消不会落在「拿到资源」和
    「登记好清理」之间（拿到之后、进入 `try` 之前被打断，资源就没人清理了）：

        resource = None
        try:
            with DeferCancel():
                resource = acquire()
            ...
        finally:
            if resource is not None:
                release(resource)

    只推迟主线程里的取消：其它线程里收不到 `Cancelled`。
    """

    def __enter__(self) -> None:
        self._counted = _thread.get_ident() == _Sigterm.main
        if self._counted:
            _Sigterm.depth += 1

    def __exit__(self, *exc: object) -> None:
        if not self._counted:
            return
        _Sigterm.depth -= 1
        if _Sigterm.depth == 0 and _Sigterm.pending:
            _Sigterm.pending = False
            if not _Sigterm.raised:
                _Sigterm.raised = True
                if not _handling_cancelled():
                    raise Cancelled("任务被终止（SIGTERM）")


class ArtifactLimitExceeded(Exception):
    """`ctx.artifacts.save` 保存的文件会让这个任务的产物合计超过上限（每个任务的合计，部署者用
    `SFLY_ARTIFACT_LIMIT_MB` 设置）：文件没有写，之前保存的产物不受影响。节点可以接住它，把文件留在
    这台机器上、在输出里给出路径；不接住，任务就在保存的那一行失败。

    属性：`name`（要保存的产物名称）、`size`（它的字节数）、`saved`（已保存的合计字节数，同名的旧文件
    不算）、`limit`（上限的字节数）。
    """

    def __init__(self, name: str, size: int, saved: int, limit: int) -> None:
        self.name = name
        self.size = size
        self.saved = saved
        self.limit = limit
        super().__init__(
            f"产物 {name} 没有保存：它 {size} 字节，这个任务已保存 {saved} 字节，"
            f"加起来超过产物合计的上限 {limit} 字节（部署者用 SFLY_ARTIFACT_LIMIT_MB 设置）。"
            "大文件留在这台机器上，在节点的输出里给出它在哪台 Agent 的哪个路径；"
            "保存前可以看 ctx.artifacts.limit_bytes，或者接住这个异常再改成留在本机"
        )

    def __reduce__(self) -> tuple[type[ArtifactLimitExceeded], tuple[str, int, int, int]]:
        """跨进程传递：`multiprocessing.Pool`、`ProcessPoolExecutor` 把子进程里的异常 pickle 传回
        父进程，重建要用四个参数。基类按 `self.args`（只有拼好的那一句话）重建会 `TypeError`，
        父进程收不到异常，进程池一直等到节点超时、或者报进程池损坏，都会按 `retries` 重试。"""
        return (type(self), (self.name, self.size, self.saved, self.limit))


class ArtifactDownloadError(Exception):
    """`ctx.artifacts.download` 失败：产物引用无效、产物不存在或已过保留期被清理、
    连不上控制面（重试之后仍然失败）。消息里写明是哪一种和产物引用。"""


def non_finite_places(value: object) -> list[tuple[str, float]]:
    """`value`（嵌套的 dict、list、tuple）里的 NaN 和无穷：（位置, 值），按出现的先后。
    位置写成节点代码里取到它的写法：`ratio`、`stats["items"][2]`。JSON 里没有这些值，
    返回值、`ctx.notify` 的原始消息里有它们时用来告诉节点作者是哪一个（#481）。"""
    found: list[tuple[str, float]] = []
    seen: set[int] = set()
    # 栈里每一项是（位置，值）；孩子倒着压栈，弹出的顺序就是它们在容器里的先后。
    stack: list[tuple[str, object]] = [("", value)]
    while stack:
        where, item = stack.pop()
        if isinstance(item, float):
            if not math.isfinite(item):
                found.append((where, item))
        elif isinstance(item, (dict, list, tuple)):
            if id(item) in seen:
                continue
            seen.add(id(item))
            if isinstance(item, dict):
                children = [
                    (_place(where, key, top=not where), child) for key, child in item.items()
                ]
            else:
                children = [(f"{where}[{i}]", child) for i, child in enumerate(item)]
            stack.extend(reversed(children))
    return found


def _place(parent: str, key: object, *, top: bool) -> str:
    if top and isinstance(key, str) and key.isidentifier():
        return key
    try:
        written = json.dumps(key, ensure_ascii=False)
    except (TypeError, ValueError):
        # bytes、object() 这类 JSON 写不了的键：位置只是附带的信息，写成 repr，不能自己抛异常。
        written = repr(key)
    return f"{parent}[{written}]"


def non_finite_name(number: float) -> str:
    """NaN、无穷在 Python 里的写法，用在错误信息里。"""
    if math.isnan(number):
        return "NaN"
    return "Infinity" if number > 0 else "-Infinity"


def describe_non_finite(places: list[tuple[str, float]]) -> str:
    """`non_finite_places` 的结果写成一句话：`a（NaN）、b[0]（-Infinity）`，
    超过 5 处时只列前 5 处，后面接「等」。"""
    listed = "、".join(f"{place}（{non_finite_name(number)}）" for place, number in places[:5])
    return listed + ("等" if len(places) > 5 else "")


def _is_finite(value: object) -> bool:
    """None 和不是数的值（不在这里管）算有限；大到转不成浮点数的整数（`10**400`）算非有限：
    它写进 JSON 以后 Agent 按双精度数读，读出来是无穷。"""
    try:
        return math.isfinite(value)  # type: ignore[arg-type]
    except OverflowError:
        return False
    except TypeError:
        return True


def _shown(value: object) -> str:
    """警告里引用的值：不长的原样（完整的 secret 值由控制面打码）；很长的（`10**400`、
    写错了类型的长字符串）
    只写类型和长度，不写截断后的内容（截断会把 secret 值切成两半，前半截认不出来）；
    位数超过解释器限制转不成文字的也不抛异常。"""
    try:
        text = repr(value)
    except ValueError:
        return f"<{type(value).__name__}，位数太多>"
    return text if len(text) <= 60 else f"<{type(value).__name__}，{len(text)} 个字符>"


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


#: 和 Agent 的 `clock::monotonic_ms`（agent/src/clock.rs）同一个系统级单调时钟：Linux 上是开机以来的
#: 时间、包括休眠（`CLOCK_BOOTTIME`），其他 Unix 是 `CLOCK_MONOTONIC`。`time.monotonic()` 不行：
#: 它在 macOS 上不是同一个时钟，Agent 和 SDK 的读数要能互相折算。没有系统级单调时钟的平台
#: （Agent 不支持的 Windows）取本进程的 `time.monotonic_ns()`，和 Agent 在那里的做法一样。
_MONOTONIC_CLOCK: int | None = getattr(
    time, "CLOCK_BOOTTIME", getattr(time, "CLOCK_MONOTONIC", None)
)


def monotonic_ms() -> int:
    """单调时钟的读数（毫秒），不受系统时间被修改的影响，只用来算差值和交给 Agent 折算。
    总是大于 0：协议里 0 表示没有读数。"""
    if _MONOTONIC_CLOCK is None:
        return time.monotonic_ns() // 1_000_000 + 1
    return max(1, time.clock_gettime_ns(_MONOTONIC_CLOCK) // 1_000_000)


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
    是这个产物的下载地址（前缀 + 按路径段百分号编码的名称），可以写进节点输出交给后续节点，
    后续节点用 `download(ref, 目标路径)` 下载；没有前缀时（本地调试）是本地文件路径。

    `cancelled` 是「任务是否进入了收尾时间」的判断（`Context.cancelled`：被取消、超时、被停止子流程
    节点停止时都为真），下载时用来及时停止：进入收尾时间之后新的下载一开始就抛出 `sfly.Cancelled`。
    `downloads_path` 是本地调试时的下载内容表（`SFLY_DOWNLOADS`，见 `sfly.local`）：
    一个 JSON 文件，产物引用 → 本地文件路径，表里有的引用不访问网络。

    `limit_bytes` 是这个任务的产物合计最多能有多少字节（控制面的 `SFLY_ARTIFACT_LIMIT_MB`，
    Agent 通过 `SFLY_ARTIFACT_LIMIT_BYTES` 交给执行器；每个任务的合计，不是单个文件的上限）。
    本地调试（`sfly debug`、`sfly.testing`）和旧版本的控制面没有这个数：是 None，不检查。
    """

    def __init__(
        self,
        directory: str | os.PathLike[str] | None,
        url: str | None,
        *,
        cancelled: Callable[[], bool] | None = None,
        downloads_path: str | os.PathLike[str] | None = None,
        limit_bytes: int | None = None,
    ) -> None:
        from pathlib import Path

        self._limit = limit_bytes
        self._dir = Path(directory) if directory is not None else None
        self._url = url or None
        self._cancelled = cancelled
        self._downloads_path = downloads_path
        self._downloads: dict[str, str] | None = None
        # `save` 把「数已保存的合计 + 写入」包在一把锁里：不然多个线程同时保存会都通过检查、
        # 合起来超限（#477）。
        self._save_lock = _thread.allocate_lock()

    def download(
        self,
        ref: str,
        dest: str | os.PathLike[str],
        *,
        retries: int = 3,
        timeout: float = 30.0,
    ) -> Path:
        """把产物引用 `ref` 指向的产物下载到本地路径 `dest`，返回写入的路径（`Path(dest)`）。

        - 流式读写，内存占用与产物大小无关；`dest` 的父目录不存在时创建，已有的文件被覆盖。
          内容先写到旁边的 `<文件名>.part`，全部写完才改名成 `dest`：失败或取消时不留下半个文件。
        - 连不上控制面、连接中断、控制面返回 5xx 时自动重试，最多 `retries` 次
          （间隔 0.5 秒起每次加倍）；`timeout` 是连接和每次读取的超时秒数。
        - 失败时抛出 `sfly.ArtifactDownloadError`，消息写明原因：产物引用无效、产物不存在
          （404）、产物已过保留期被清理（410）、连不上控制面或连接中断（重试耗尽）。
        - 任务进入收尾时间（取消、超时、被停止子流程节点停止：取消标记出现）之后立即停止并抛出
          `sfly.Cancelled`：新的下载一开始就抛出，已经在下载的（在后台线程里下载时）在两次读取之间停止。
          超时的节点在自己的 `finally` 里也下载不了，要拿的东西放在 always 节点里下载。

        产物在保存它的任务结束后才上传到控制面：只能下载前面的节点保存的产物。
        下载地址在控制面上，任何一台 Agent 上的节点都能下载。本地调试时产物引用是本地文件路径，
        直接复制；`sfly.testing.run_node(downloads=...)` 和 `sfly debug --download` 可以给某个
        引用指定本地内容。
        """
        from sfly.download import download

        return download(
            ref,
            dest,
            retries=retries,
            timeout=timeout,
            local=self._local_downloads(),
            cancelled=self._cancelled or (lambda: False),
        )

    def _local_downloads(self) -> dict[str, str]:
        if self._downloads is None:
            table: object = {}
            if self._downloads_path is not None:
                with open(self._downloads_path, encoding="utf-8") as f:
                    table = json.loads(f.read())
            self._downloads = (
                {str(k): str(v) for k, v in table.items()} if isinstance(table, dict) else {}
            )
        return self._downloads

    @property
    def limit_bytes(self) -> int | None:
        """这个任务的产物合计最多能有多少字节（只读）；没有上限（本地调试、旧版本控制面）时是 None。

        产物在任务结束后才上传，合计超过上限时超出的文件传不上去、任务失败：节点要保存大文件之前
        可以先和它比（估计的大小超过时，把文件留在这台机器上，在输出里给出路径），也可以接住
        `save` 抛出的 `ArtifactLimitExceeded`。
        """
        return self._limit

    def save(self, name: str, data: bytes | str | os.PathLike[str]) -> str:
        """保存一个产物并返回产物引用。

        `data` 为 bytes / str（按 UTF-8）时写入内容，为路径时复制该文件。

        有上限（`limit_bytes`）时先检查：已保存的合计（产物目录里的文件，包括直接写进目录的；同名的旧
        文件不算）加上这个文件超过上限时，抛出 `ArtifactLimitExceeded`：这个文件不写，
        同名的旧文件也不动。检查和写入是一起做的（一把锁）：多个线程同时 `save` 不会都通过检查、
        合起来超限；代价是同一个任务里的 `save` 一个接一个写。直接写进 `path(...)` 的文件
        不经过这里，由 Agent 上传前的检查兜住。
        """
        target = self.path(name)
        with self._save_lock:
            if self._limit is not None:
                size = _data_size(data)
                saved = self._saved_bytes(excluding=target)
                if saved + size > self._limit:
                    raise ArtifactLimitExceeded(name, size, saved, self._limit)
            if isinstance(data, bytes):
                target.write_bytes(data)
            elif isinstance(data, str):
                target.write_text(data, encoding="utf-8")
            else:
                import shutil

                shutil.copyfile(data, target)
        return self.ref(name)

    def _saved_bytes(self, excluding: Path) -> int:
        """产物目录里已有的文件的字节数合计（和 Agent 上传时数的一样：只数普通文件，不跟随链接）；
        `excluding` 是要被覆盖的那个文件，不算。"""
        from pathlib import Path

        total = 0
        if self._dir is None or not self._dir.is_dir():
            return total
        for root, _dirs, names in os.walk(self._dir):
            for file_name in names:
                path = Path(root, file_name)
                if path == excluding or path.is_symlink():
                    continue
                try:
                    total += path.stat().st_size
                except OSError:
                    continue
        return total

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


def _data_size(data: bytes | str | os.PathLike[str]) -> int:
    """`Artifacts.save` 要写的内容有多少字节：bytes 的长度，str 按 UTF-8，路径是文件的大小。"""
    if isinstance(data, bytes):
        return len(data)
    if isinstance(data, str):
        return len(data.encode("utf-8"))
    return os.path.getsize(data)


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

    在 Agent 上取自 Agent 写的 task.json（`SFLY_TASK`）；本地调试（`sfly debug`、`sfly.testing`）时
    任务 ID 是 `local`、attempt 是 1、节点 ID 是节点名，
    运行 ID 见 `sfly debug` 与 `run_node` 的说明。
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


def _limit_from_env(value: str | None) -> int | None:
    """`SFLY_ARTIFACT_LIMIT_BYTES`：正整数；没有、空、不是整数或不大于 0 都当作没有上限。"""
    if not value:
        return None
    try:
        limit = int(value)
    except ValueError:
        return None
    return limit if limit > 0 else None


class Context:
    """节点执行时由执行器传入的任务上下文。

    `events_path` 默认取环境变量 `SFLY_EVENTS`；为 None（或环境变量未设置）时日志和进度被丢弃。
    `cancel_path` 默认取 `SFLY_CANCEL`；为 None 时 `cancelled()` 总是 False。
    `artifacts_dir` / `artifacts_url` 默认取 `SFLY_ARTIFACTS` / `SFLY_ARTIFACTS_URL`；
    `artifact_limit_bytes`（产物合计的上限）默认取 `SFLY_ARTIFACT_LIMIT_BYTES`，没有或不是正整数时
    是 None。
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
        artifact_limit_bytes: int | None = _FROM_ENV,
    ) -> None:
        if events_path is _FROM_ENV:
            events_path = os.environ.get("SFLY_EVENTS")
        if cancel_path is _FROM_ENV:
            cancel_path = os.environ.get("SFLY_CANCEL")
        if artifacts_dir is _FROM_ENV:
            artifacts_dir = os.environ.get("SFLY_ARTIFACTS")
        if artifacts_url is _FROM_ENV:
            artifacts_url = os.environ.get("SFLY_ARTIFACTS_URL")
        if artifact_limit_bytes is _FROM_ENV:
            artifact_limit_bytes = _limit_from_env(os.environ.get("SFLY_ARTIFACT_LIMIT_BYTES"))
        from pathlib import Path

        self.task = task if task is not None else _task_from_env()
        if procs_dir is None:
            procs_dir = os.environ.get("SFLY_PROCS") or _default_procs_dir(self.task)
        self._procs_dir = Path(procs_dir)
        self._events = _EventWriter(events_path)
        self._cancel = cancel_path
        self.log = Log(self._events)
        # 动作用到时才创建（sfly.actions 不在每个任务的启动路径上导入）。
        self._actions: Actions | None = None
        self._actions_lock = _thread.allocate_lock()
        self.artifacts = Artifacts(
            artifacts_dir,
            artifacts_url,
            cancelled=self.cancelled,
            downloads_path=os.environ.get("SFLY_DOWNLOADS"),
            limit_bytes=artifact_limit_bytes,
        )
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
        - `sfly debug` 时是项目下的 `.sfly/procs/<运行目录名>/`，
          `sfly.testing.run_node` 时是任务工作目录下的 `procs/`。
        """
        return self._procs_dir

    def agent(self, name: str | None = None) -> Agent:
        """一台 Agent 的能力（ADR 0019）：不给名称时是节点自己所在的 Agent，给名称时是
        通过「Agent」类型的参数（`sfly.AgentName`）拿到的另一台 Agent。两者的能力和写法相同，
        例如 `ctx.agent(source).files.list(...)`。

        只能访问自己所在的 Agent 和参数里选的 Agent：访问其它名称时调用抛出
        `sfly.AgentNotReferenced`。调用另一台 Agent 时由自己所在的 Agent 代为连接，
        数据不经过控制面。本地调试（`sfly debug`、`sfly.testing`）时直接操作本机的文件系统，
        其它 Agent 由测试工具映射到本地目录。
        """
        from sfly.capabilities import connect

        return connect(
            name, task_id=self.task.task_id, attempt=self.task.attempt, cancelled=self.cancelled
        )

    def notify(
        self,
        bot: str,
        text: str | None = None,
        *,
        at_all: bool = False,
        message: Mapping[str, Any] | None = None,
    ) -> None:
        """给飞书机器人 `bot` 发一条通知（ADR 0020），调用后立即返回。

        - `ctx.notify(bot, text)` 发文本，`at_all=True` 时在正文末尾加上「@所有人」；正文里自己写的
          `<at user_id="ou_xxx">名字</at>` 原样发出；
        - `ctx.notify(bot, message=...)` 发原始消息：完整的飞书请求体，原样发出，富文本、自己设计的
          卡片、模板卡片都走这一种；Markdown 卡片用 `sfly.feishu.card(...)` 组装：
          `ctx.notify(bot, message=sfly.feishu.card("标题", "**正文**", "green"))`。
          校验规则（`testdata/feishu-raw-cases.json`）：只检查它是一个对象、`msg_type` 是 text、
          post、image、share_chat、interactive 之一、不超过 20 KB（不截断）；不合格的不发送，
          任务日志里写一条警告说明原因，调用不抛异常；
        - `bot` 是飞书机器人的名称，要通过「飞书机器人」类型的参数（`sfly.FeishuBot`）传给节点：
          平台只发给任务的这种参数引用的机器人，其他名称不发送，任务日志里写一条警告。

        消息由控制面发出：这里只把通知写进事件管道，由 Agent 转给控制面写进发送队列，
        不访问网络、不等结果。**投递失败永远不会抛出异常**，节点不会因为通知失败或变慢；
        投递结果写在这个任务的日志里。只有调用的写法不对时抛出 `TypeError`：`bot` 不是字符串，
        `text` 和 `message` 同时给或都不给，`text` 不是字符串，`at_all` 不是布尔值，
        或者发原始消息时还给了 `at_all`（它只对文本有意义）。

        本地调试时不真的发送：`sfly debug` 打印请求体，`sfly.testing.run_node` 的结果里
        有 `notifications`。
        """
        if not isinstance(bot, str):
            raise TypeError(f"ctx.notify 的 bot 必须是飞书机器人的名称（字符串），实际为 {bot!r}")
        if text is not None and message is not None:
            raise TypeError(
                "ctx.notify 不能同时给 text 和 message：发文本用 text，发原始消息用 message"
            )
        if text is None and message is None:
            raise TypeError("ctx.notify 需要给 text（文本）或 message（原始消息）")
        if not isinstance(at_all, bool):
            raise TypeError(f"ctx.notify 的 at_all 必须是 True 或 False，实际为 {at_all!r}")
        if message is not None:
            if at_all:
                raise TypeError("ctx.notify 发原始消息时不能用 at_all：要 @所有人，写在消息里")
            content: dict[str, Any] = {"message": message}
            places = non_finite_places(message)
            if places:
                # JSON 里没有 NaN 和无穷：写进事件管道是非法的一行，Agent 读不了，
                # 通知会悄悄丢掉。
                self.log.warn(
                    "ctx.notify 的消息没有发送：原始消息里有 NaN 或无穷（JSON 里没有这些值）：%s",
                    describe_non_finite(places),
                )
                return
        else:
            if not isinstance(text, str):
                raise TypeError(f"ctx.notify 的 text 必须是字符串，实际为 {text!r}")
            content = {"text": text, "at_all": at_all}
        self._events.write({"type": "notify", "ts": _now_ms(), "bot": bot, **content})

    @property
    def action(self) -> Actions:
        """`ctx.action`：记录节点正在做的一件有开始和结束的事（动作）。

            with ctx.action("下单", 订单=oid, 价格=price) as a:
                ...
                a.note(回报="已成交")          # 动作进行中补充字段
                a.fail("拒单：余额不足")        # 记为失败，不抛异常

            handle = ctx.action.start("保持", 时长="4h")   # 开始和结束不在同一段代码里
            ...
            handle.end()                                  # 或 handle.fail("原因")

        用法、结果的规则、嵌套、上限见 `sfly.actions`。
        """
        actions = self._actions
        if actions is None:
            with self._actions_lock:
                actions = self._actions
                if actions is None:
                    from sfly.actions import Actions

                    actions = self._actions = Actions(self._events, self._warn_once)
        return actions

    def mark(
        self,
        name: str,
        /,
        *,
        parent: Action | ActionScope | None = None,
        **fields: object,
    ) -> None:
        """记一个时刻（标记），例如 `ctx.mark("收到第一笔成交", 订单=oid)`。
        没有持续时间，也没有结果。

        `parent` 是它属于哪个动作，默认是当前最内层的 `with ctx.action(...)`。名称和字段的规则
        同动作，见 `sfly.actions`。
        """
        self.action.mark(name, parent=parent, **fields)

    def cancelled(self) -> bool:
        """任务是否进入了收尾时间（Agent 已写入取消标记）。

        取消、超时、被停止子流程节点停止时 Agent 都先写取消标记再发 SIGTERM（Agent 自己退出时
        也一样），所以这些情况下它在收尾时间里都是真；它不说明原因（超时的任务仍然记成超时，
        不是取消）。清理代码靠它把宽限期压短。
        """
        return self._cancel is not None and os.path.exists(self._cancel)

    def progress(self, current: float, total: float | None = None, message: str = "") -> None:
        """上报进度：当前值、总数（未知时省略）和说明。Agent 端合并，每秒最多上报一次。

        `current`、`total` 是 NaN 或无穷时这一次上报被丢弃，并写一条警告日志（只写一次）：
        JSON 里没有这些值。"""
        if not (_is_finite(current) and _is_finite(total)):
            # 原因名和指标的 "non-finite" 不同：名叫 progress 的指标的警告不会被它盖住。
            self._warn_once(
                "progress-non-finite",
                "progress",
                f"ctx.progress 的 current、total 必须是有限数值，实际为 current={_shown(current)}、"
                f"total={_shown(total)}，已丢弃",
            )
            return
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
        metrics = self._metrics
        if metrics is None:
            kind, keys = "gauge", _NO_LABEL_KEYS
        else:
            declared = metrics.get(name)
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
        except (TypeError, ValueError, OverflowError):
            number = math.nan
        if not math.isfinite(number):
            self._warn_once(
                "non-finite",
                name,
                f"指标 {name!r} 的值必须是有限数值，实际为 {_shown(value)}，已丢弃",
            )
            return
        # 不带标签、也没声明标签键（最常见，节点可能每秒调用上万次）：直接写，不经过标签检查。
        if not labels and not keys:
            if metrics is None:
                self._unlabeled.add(name)
            self._events.write(
                {"type": "metric", "ts": _now_ms(), "name": name, "kind": kind, "value": number}
            )
            return
        checked = self._check_labels(name, keys, labels or {})
        if checked is None or not self._admit(name, checked):
            return
        self._events.write(
            {
                "type": "metric",
                "ts": _now_ms(),
                "name": name,
                "kind": kind,
                "value": number,
                "labels": checked,
            }
        )

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
