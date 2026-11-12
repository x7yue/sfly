"""`sfly.testing`：在 pytest 里执行节点（本地调试）。只用标准库（ADR 0002）。

    from sfly.testing import run_node
    from my_pkg import check

    def test_check(tmp_path):
        result = run_node(check, {"url": "http://example.com"}, work_dir=tmp_path)
        assert result.status == "success"
        assert result.outputs == {"ok": True}
        assert [line.message for line in result.logs if line.source == "sdk"] == [...]

节点和在 Agent 上一样在执行器子进程里运行（见 `sfly.local`），结果 `Execution` 里有输出、
失败原因、日志、进度、指标、产物和 `ctx.notify` 的通知（`notifications`：机器人名和请求体，
不真的发送）。用 `cancel_when` / `cancel_after` 模拟取消：节点里抛出
`sfly.Cancelled`，`finally` 里的清理代码执行，结果的 `status` 为 `cancelled`。
"""

from __future__ import annotations

import inspect
import os
import sys
import tempfile
import time
from collections.abc import Callable, Mapping
from typing import Any

from sfly.local import (
    DEFAULT_GRACE,
    Cancellation,
    Execution,
    LogLine,
    MetricPoint,
    NodeError,
    Notification,
    Progress,
    execute,
)
from sfly.runner import load_entry

__all__ = [
    "Execution",
    "LogLine",
    "MetricPoint",
    "NodeError",
    "Notification",
    "Progress",
    "run_node",
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
    - `inputs`：节点的输入（JSON 对象），先按节点的类型注解校验，不通过时 `status` 为 failed、
      `error.kind` 为 config_error，节点不会执行；
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
