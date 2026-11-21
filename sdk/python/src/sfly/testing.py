"""`sfly.testing`：在 pytest 里执行节点（本地调试）。只用标准库（ADR 0002）。

    from sfly.testing import run_node
    from my_pkg import check

    def test_check(tmp_path):
        result = run_node(check, {"url": "http://example.com"}, work_dir=tmp_path)
        assert result.status == "success"
        assert result.outputs == {"ok": True}
        assert [line.message for line in result.logs if line.source == "sdk"] == [...]

节点和在 Agent 上一样在执行器子进程里运行（见 `sfly.local`），结果 `Execution` 里有输出、
失败原因、日志、进度、指标、产物、`ctx.notify` 的通知（`notifications`：机器人名和请求体，
不真的发送）和 `ctx.action`、`ctx.mark` 记录的动作与标记（`actions`、`action_summary`）。
用 `cancel_when` / `cancel_after` 模拟取消：节点里抛出 `sfly.Cancelled`，`finally` 里的清理
代码执行，结果的 `status` 为 `cancelled`。

读运行状态（`sfly.RunState`，场景里写 `${{ run.state }}`）的节点，用 `run_state` 用简写造一份：

    from sfly.testing import run_node, run_state

    state = run_state(
        nodes={
            "fetch": "success",
            "check": ("failed", "ValueError: 余额不足"),
            "report": "dispatched",
        },
        self_node="report",
    )
    result = run_node(run_summary, {"run": state})
"""

from __future__ import annotations

import inspect
import os
import sys
import tempfile
import time
import typing
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from sfly.local import (
    DEFAULT_GRACE,
    ActionCount,
    ActionRecord,
    ActionSummary,
    Cancellation,
    Execution,
    LogLine,
    MetricPoint,
    NodeError,
    Notification,
    Progress,
    execute,
)
from sfly.run_state import (
    NodeStatus,
    RunState,
    RunStateChain,
    RunStateError,
    RunStateNode,
    RunStatus,
)
from sfly.runner import load_entry

__all__ = [
    "ActionCount",
    "ActionRecord",
    "ActionSummary",
    "Execution",
    "LogLine",
    "MetricPoint",
    "NodeError",
    "Notification",
    "Progress",
    "run_node",
    "run_state",
]


def run_node(
    node: Callable[..., Any] | str,
    inputs: Mapping[str, Any] | None = None,
    *,
    cancel_when: Callable[[Execution], bool] | None = None,
    cancel_after: float | None = None,
    grace: float = DEFAULT_GRACE,
    work_dir: str | os.PathLike[str] | None = None,
    downloads: Mapping[str, bytes | str | os.PathLike[str]] | None = None,
    agents: Mapping[str, str | os.PathLike[str]] | None = None,
) -> Execution:
    """执行一个节点，等它结束并返回结果。

    - `node`：`@node` 声明的函数（必须定义在模块顶层），或入口字符串 `模块:函数`；
    - `inputs`：节点的输入（JSON 对象），先按节点的类型注解校验，不通过、或有节点没有声明的名字时
      `status` 为 failed、`error.kind` 为 config_error，节点不会执行；
    - `cancel_when`：执行期间定期以到目前为止的结果调用，返回 True 时取消；
      `cancel_after`：开始后这么多秒取消。取消与平台相同：写取消标记、发 SIGTERM，
      宽限期 `grace` 秒后强制杀掉；
    - `work_dir`：任务工作目录（产物在其中的 `artifacts/`），默认新建一个临时目录，不会自动删除；
    - `downloads`：产物引用 → 本地内容，节点用 `ctx.artifacts.download` 下载这些引用时得到
      这份内容，不访问网络。内容是 bytes / str（按 UTF-8）时就是产物的内容，是路径时取该文件
      （与 `ctx.artifacts.save` 的写法相同）；
    - `agents`：Agent 名称 → 本地目录，测试「访问另一台 Agent」的节点用：节点用
      `ctx.agent(名称)` 访问那台 Agent 时，那台 Agent 上的绝对路径落在这个目录里
      （`/var/log/app.log` 是 `<目录>/var/log/app.log`），返回的路径仍是那台 Agent 上的写法。
      名称要通过「Agent」类型的参数传给节点。`ctx.agent()`（自己所在的 Agent）就是本机。

    执行器子进程使用当前解释器，模块搜索路径与当前进程相同。
    """
    from sfly.cli.scan import input_schema

    fn = load_entry(node) if isinstance(node, str) else node
    module = getattr(fn, "__module__", None)
    qualname = getattr(fn, "__qualname__", "")
    if isinstance(node, str):
        entry = node
    elif not module or "." in qualname or "<" in qualname:
        raise ValueError(f"节点必须是模块顶层的函数：{fn!r}")
    else:
        entry = f"{module}:{qualname}"
    if not inspect.isfunction(fn):
        raise TypeError(f"节点必须是函数：{fn!r}")
    schema = input_schema(fn, f"节点 {entry}")

    started = time.monotonic()
    cancellation = Cancellation()

    def tick(partial: Execution) -> None:
        if cancel_after is not None and time.monotonic() - started >= cancel_after:
            cancellation.cancel()
        elif cancel_when is not None and cancel_when(partial):
            cancellation.cancel()

    return execute(
        entry,
        inputs or {},
        work_dir if work_dir is not None else tempfile.mkdtemp(prefix="sfly-node-"),
        schema=schema,
        pythonpath=[p for p in sys.path if p],
        grace=grace,
        cancellation=cancellation,
        on_tick=tick,
        downloads=downloads,
        agents=agents,
    )


# ---- 造运行状态 ----

#: 节点的简写：状态；或 `(状态, 错误信息)`、`(状态, 错误信息, 错误类型)`
#: （只有 `failed` 的节点可以带错误）。
NodeSpec = str | tuple[str, str] | tuple[str, str, str]

_NODE_STATUSES: tuple[str, ...] = typing.get_args(NodeStatus)
_RUN_STATUSES: tuple[str, ...] = typing.get_args(RunStatus)
#: 还没结束、正在推进的节点状态（`pending` 是还没有尝试）。
_IN_PROGRESS = frozenset({"queued", "dispatched", "running", "waiting", "pending"})
#: 有尝试、已经开始：`running`、`waiting` 还没结束，`success`、`failed` 结束了。
_STARTED = frozenset({"running", "waiting", "success", "failed"})
_ENDED = frozenset({"success", "failed"})
#: 没有尝试的占位：还没有尝试，被跳过，没开始就被取消，所在子流程被停止。
_NO_ATTEMPT = frozenset({"pending", "skipped", "cancelled", "stopped"})

_START = datetime(2026, 1, 1, tzinfo=timezone.utc)
_TRACEBACK = "Traceback (most recent call last):"

#: 链上的一个节点：（节点 ID，种类，状态，错误）。
_Entry = tuple[str, str, str, "RunStateError | None"]


def _at(ms: int) -> str:
    """固定的时间：2026-01-01T00:00:00.000Z 之后过了 `ms` 毫秒。"""
    moment = _START + timedelta(milliseconds=ms)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def _exception_message(text: str) -> str:
    """错误信息里的异常信息（不含堆栈）：和控制面一样，第一个「空行 + `Traceback ...`」（堆栈的
    开头）之后是堆栈；整段就是堆栈时异常信息是空串。"""
    if text.startswith(_TRACEBACK):
        return ""
    at = text.find(f"\n\n{_TRACEBACK}")
    return text if at < 0 else text[:at]


def _error(text: str, kind: str) -> RunStateError:
    from sfly.cli.error_headline import error_headline

    message = _exception_message(text)
    return RunStateError(
        kind=kind,
        headline=error_headline(message),
        message=message,
        message_truncated=False,
        location=None,
    )


def _entry(where: str, node_id: str, spec: Any) -> _Entry:
    """一个节点的简写 → 链上的一个节点。`where` 是报错里的位置，例如「节点 a」。"""
    if isinstance(spec, str):
        status, text, kind = spec, None, "node_error"
    elif isinstance(spec, tuple) and len(spec) in (2, 3) and all(isinstance(x, str) for x in spec):
        status, text = spec[0], spec[1]
        kind = spec[2] if len(spec) == 3 else "node_error"
    else:
        raise ValueError(
            f"{where} 要写成状态（'success'）、(状态, 错误信息) 或 (状态, 错误信息, 错误类型)，"
            f"收到 {spec!r}"
        )
    if status not in _NODE_STATUSES:
        raise ValueError(f"{where} 的状态 {status!r} 不认识，可选：{'、'.join(_NODE_STATUSES)}")
    if text is not None and status != "failed":
        raise ValueError(f"{where} 的状态是 {status}，只有 failed 的节点可以带错误信息")
    error = _error(text or "", kind) if status == "failed" else None
    return node_id, "package", status, error


def _entries(owner: str, specs: Mapping[str, NodeSpec]) -> list[_Entry]:
    """一条链上的节点，按映射的顺序。`owner`：主链是空串，子流程是「子流程 回放 的」。"""
    return [_entry(f"{owner}节点 {node_id}", node_id, spec) for node_id, spec in specs.items()]


def _chain_status(statuses: list[str]) -> RunStatus:
    """一个链实例此刻的状态：还有节点在进行就是 running，否则有节点失败是 failed，有节点被取消是
    cancelled，其余 success。"""
    if _IN_PROGRESS.intersection(statuses):
        return "running"
    if "failed" in statuses:
        return "failed"
    if "cancelled" in statuses:
        return "cancelled"
    return "success"


def _node(entry: _Entry, slot: int) -> RunStateNode:
    """链上的一个节点；`slot` 是它在整次运行里的序号（从 1 起），决定它的时间。"""
    node_id, kind, status, error = entry
    started = status in _STARTED
    return RunStateNode(
        node_id=node_id,
        display_name=None,
        kind=kind,
        status=typing.cast(NodeStatus, status),
        attempts=0 if status in _NO_ATTEMPT else 1,
        started_at=_at(slot * 1000) if started else None,
        ended_at=_at(slot * 1000 + 500) if status in _ENDED else None,
        error=error,
    )


def run_state(
    nodes: Mapping[str, NodeSpec],
    *,
    scenario: str = "测试场景",
    status: str = "running",
    cancel: str | None = None,
    self_node: str | None = None,
    subflows: Mapping[str, Mapping[str, NodeSpec]] | None = None,
) -> RunState:
    """用简写造一份合法的运行状态（`sfly.RunState`），给读 `${{ run.state }}` 的节点单测用。

        state = run_state(
            nodes={"a": "success", "b": ("failed", "ValueError: 余额不足"), "c": "skipped"},
            scenario="巡检",
        )
        run_node(run_summary, {"run": state})

    - `nodes`：主链上的节点，节点 ID → 状态，字典的顺序就是链上的顺序。状态是
      `success`、`failed`、`skipped`、`cancelled`、`stopped`、`pending`、`running`、`waiting`、
      `queued`、`dispatched`；失败的节点可以带错误：`("failed", "ValueError: 余额不足")`，
      第三项指定错误类型（默认 `node_error`）：`("failed", "任务执行超时", "timeout")`。
      错误信息可以带堆栈（异常信息、空行、`Traceback (most recent call last):` 开头的堆栈）：
      `error.message` 只取异常信息，`error.headline` 取它第一行有内容的文字；
    - `scenario`：场景名称；`status`：运行的状态（`running`、`success`、`failed`、`cancelled`），
      默认 `running`（引用它的节点自己还没结束，运行总是 `running`）；
    - `cancel`：请求取消的人（昵称），给了就有 `cancel`，`result_so_far` 是 `cancelled`；
    - `self_node`：引用这份状态的节点的 ID，给了就填上 `self`，这个节点的状态是 `dispatched`
      （写在 `nodes` 里的状态被它覆盖，习惯上写 `dispatched`）；
    - `subflows`：子流程，名称 → 节点（写法同 `nodes`）。每个子流程是一个深一层的链实例，
      由主链开头自动加的一个异步任务节点触发（节点 ID `async_<名称>`，kind 是 `async`，状态
      `success`）。

    其余字段按规则算出或给固定值：`failures` 是失败的节点（`failed`，按主链、子流程、链上的顺序），
    `result_so_far` 已请求取消是 `cancelled`、否则有节点失败是 `failed`、否则 `success`，
    运行已结束时就是 `status`；时间从 2026-01-01T00:00:00.000Z 起按节点的顺序递增；
    链实例的状态由节点算出（还有节点在进行是 `running`）。`cancelled`、`stopped` 当作没开始的占位，
    没有尝试、没有起止时间。

    参数自相矛盾时抛出 `ValueError`：不认识的状态、写法不对的节点、节点 ID 重复、已经结束的运行里
    还有进行中的节点、`success` 的运行里有失败的节点或取消。
    """
    if status not in _RUN_STATUSES:
        raise ValueError(f"运行的状态 {status!r} 不认识，可选：{'、'.join(_RUN_STATUSES)}")
    flows = dict(subflows or {})
    if not nodes:
        raise ValueError("nodes 里至少要有一个节点")
    for flow, specs in flows.items():
        if not specs:
            raise ValueError(f"子流程 {flow} 里至少要有一个节点")
    # 链实例：主链，再是各子流程；子流程由主链开头的异步任务节点触发。
    chains: list[tuple[str | None, list[_Entry]]] = [
        (
            None,
            [(f"async_{name}", "async", "success", None) for name in flows] + _entries("", nodes),
        ),
        *((name, _entries(f"子流程 {name} 的", specs)) for name, specs in flows.items()),
    ]
    ids = [entry[0] for _, entries in chains for entry in entries]
    for node_id in dict.fromkeys(ids):
        if ids.count(node_id) > 1:
            raise ValueError(f"节点 ID {node_id} 重复：一次运行里节点 ID 不能重复")
    if self_node is not None:
        if self_node not in ids:
            raise ValueError(f"self_node {self_node!r} 不是任何一个节点的 ID")
        # 引用者自己：已经派发、还没开始。
        chains = [
            (name, [_as_self(entry) if entry[0] == self_node else entry for entry in entries])
            for name, entries in chains
        ]

    every = [entry for _, entries in chains for entry in entries]
    failed = any(entry[2] == "failed" for entry in every)
    if status != "running":
        busy = next((entry for entry in every if entry[2] in _IN_PROGRESS), None)
        if busy is not None:
            raise ValueError(
                f"运行已经是 {status}，不能还有进行中的节点：节点 {busy[0]} 的状态是 {busy[2]}"
            )
    if status == "success" and failed:
        raise ValueError("运行的 status 是 success，不能有失败的节点")
    if status == "success" and cancel is not None:
        raise ValueError("运行的 status 是 success，不能有 cancel（请求取消）")

    total = len(every)
    ended = _at((total + 1) * 1000)
    run_chains: list[RunStateChain] = []
    self_chain: str | None = None
    slot = 0
    for index, (name, entries) in enumerate(chains):
        chain_nodes = []
        for entry in entries:
            slot += 1
            chain_nodes.append(_node(entry, slot))
        chain_id = f"c{index + 1}"
        if self_node is not None and any(entry[0] == self_node for entry in entries):
            self_chain = chain_id
        chain_status = _chain_status([entry[2] for entry in entries])
        run_chains.append(
            RunStateChain(
                id=chain_id,
                chain_id=entries[0][0],
                name=name,
                depth=0 if name is None else 1,
                parent_chain_instance_id=None if name is None else "c1",
                async_node_id=None if name is None else f"async_{name}",
                status=chain_status,
                # 子流程在触发它的异步任务节点开始的那一刻创建。
                started_at=_at(0) if name is None else _at(index * 1000),
                ended_at=None if chain_status == "running" else ended,
                nodes=chain_nodes,
            )
        )

    if status != "running":
        result: Literal["success", "failed", "cancelled"] = typing.cast(Any, status)
    elif cancel is not None:
        result = "cancelled"
    else:
        result = "failed" if failed else "success"
    state: RunState = {
        "run_id": "11111111-1111-4111-8111-111111111111",
        "scenario": {"id": "22222222-2222-4222-8222-222222222222", "name": scenario, "version": 1},
        "status": typing.cast(RunStatus, status),
        "result_so_far": result,
        "triggered_by": "测试",
        "triggered_via": None,
        "started_at": _at(0),
        "ended_at": None if status == "running" else _at((total + 2) * 1000),
        "cancel": None
        if cancel is None
        else {
            "requested_by": cancel,
            "requested_via": None,
            "requested_at": ended,
            "forced_at": None,
        },
        "failures": [
            n["node_id"] for chain in run_chains for n in chain["nodes"] if n["status"] == "failed"
        ],
        "self": None
        if self_chain is None or self_node is None
        else {"chain_instance_id": self_chain, "node_id": self_node},
        "truncated": False,
        "chains": run_chains,
    }
    return state


def _as_self(entry: _Entry) -> _Entry:
    node_id, kind, status, error = entry
    if error is not None:
        raise ValueError(f"self_node {node_id} 的状态会被改成 dispatched，不能带错误信息")
    return node_id, kind, "dispatched", None
