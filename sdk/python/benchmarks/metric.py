"""基准测试（ARCHITECTURE §7.6）：SDK 单次 `ctx.metric()` 和单次 `ctx.action()` 的开销。

只用标准库 `timeit`，不给 SDK 增加依赖（ADR 0002）。只在本地运行，不进 CI：pytest 只收集
sdk/python/tests；`pnpm perf` 顺带运行并汇总进报告
（apps/server/perf/items/07-bench-sdk-metric.ts）。

单独运行（仓库根目录）：

    uv run --locked python sdk/python/benchmarks/metric.py

`--json` 输出机器可读的结果（`pnpm perf` 用）。

测的是节点里一次 `ctx.metric()`：检查声明（和标签）、转换数值、序列化成一行 JSON、写入事件文件。
这里写普通文件（每轮开始前清空）而不是 Agent 的 FIFO，测到的是 SDK 自己的开销，
不受 Agent 读取快慢影响。timeit 先自动选定每轮的调用次数（每轮至少 0.2 秒），再重复若干轮。
测两种情况：

- `metric`：`ctx.metric("seq", 值)`，不带标签的指标；
- `labeled_metric`：4 个带标签（`pid`、`name`）的指标 × 50 个进程轮流上报
  （`ctx.metric("cpu_by_process", 值, labels={"pid": "1000", "name": "worker-0"})`，与标准节点
  `process_monitor` 按进程上报时相同），每个进程的标签字典事先建好，取的是平均到每次调用的耗时；
- `action`：`with ctx.action("下单", 订单="1001", 价格="10.5"): pass`，一次完整的动作：校验名称
  和字段、开始和结束各写一行事件（两行 JSON）、更新计数和摘要。每轮用新建的 `Context` 并固定
  2 万次：每种名称超过 5 万个以后 SDK 不再写明细，那时测到的是计数的开销，不是平时的开销。
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import tempfile
import timeit
from typing import Any

from sfly.context import Context
from sfly.nodes import Metric

LABELED_METRICS = ("cpu_by_process", "rss_by_process", "fds_by_process", "io_by_process")
PROCESSES = 50


#: `action` 每轮的次数：不超过每种名称的明细上限（5 万个），见模块说明。
ACTION_CALLS = 20_000


def measure_action(repeat: int) -> tuple[int, list[float]]:
    """返回每轮的执行次数，以及各轮平均到每次 `with ctx.action()` 的耗时（微秒）。"""
    with tempfile.TemporaryDirectory() as tmp:
        events = os.path.join(tmp, "events.jsonl")
        open(events, "wb").close()
        timer = timeit.Timer(
            "with ctx.action('下单', 订单='1001', 价格='10.5'): pass",
            setup=(
                "os.truncate(events, 0)\n"
                "ctx = Context(events_path=events, cancel_path=None, artifacts_dir=None,"
                " artifacts_url=None)"
            ),
            globals={"os": os, "events": events, "Context": Context},
        )
        times = timer.repeat(repeat=repeat, number=ACTION_CALLS)
    return ACTION_CALLS, [t / ACTION_CALLS * 1e6 for t in times]


def measure(repeat: int, case: str) -> tuple[int, list[float]]:
    """返回每轮的执行次数，以及各轮平均到每次 `ctx.metric()` 的耗时（微秒）。"""
    if case == "action":
        return measure_action(repeat)
    with tempfile.TemporaryDirectory() as tmp:
        events = os.path.join(tmp, "events.jsonl")
        open(events, "wb").close()
        if case == "metric":
            metrics = [Metric("seq")]
            stmt, per_run = "ctx.metric('seq', 12345.5)", 1
            env: dict[str, Any] = {}
        else:
            metrics = [Metric(name, labels=["pid", "name"]) for name in LABELED_METRICS]
            processes = [{"pid": str(1000 + p), "name": f"worker-{p}"} for p in range(PROCESSES)]
            stmt = (
                "for labels in processes:\n"
                "    for name in names:\n"
                "        ctx.metric(name, 12345.5, labels=labels)"
            )
            per_run = PROCESSES * len(LABELED_METRICS)
            env = {"processes": processes, "names": LABELED_METRICS}
        ctx = Context(
            events_path=events,
            cancel_path=None,
            artifacts_dir=None,
            artifacts_url=None,
            metrics=metrics,
        )
        timer = timeit.Timer(
            stmt,
            setup="os.truncate(events, 0)",
            globals={"ctx": ctx, "os": os, "events": events, **env},
        )
        runs, _ = timer.autorange()
        times = timer.repeat(repeat=repeat, number=runs)
    return runs * per_run, [t / (runs * per_run) * 1e6 for t in times]


CASES = {
    "metric": "ctx.metric()",
    "labeled_metric": "带标签的 ctx.metric()",
    "action": "with ctx.action()",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="SDK 单次 ctx.metric() 和 ctx.action() 的开销")
    parser.add_argument("--repeat", type=int, default=7, help="重复轮数（默认 7）")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    results = {case: measure(args.repeat, case) for case in CASES}
    if args.json:
        result = {
            "python": platform.python_version(),
            "repeat": args.repeat,
            "cases": [
                {"id": case, "calls": calls, "per_call_us": per_call_us}
                for case, (calls, per_call_us) in results.items()
            ],
        }
        print(json.dumps(result))
        return
    for case, (calls, per_call_us) in results.items():
        print(
            f"{CASES[case]}：中位数 {statistics.median(per_call_us):.2f} µs/次，"
            f"最好 {min(per_call_us):.2f} µs/次"
            f"（Python {platform.python_version()}，{args.repeat} 轮 × 每轮 {calls} 次）"
        )


if __name__ == "__main__":
    main()
