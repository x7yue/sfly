"""基准测试（ARCHITECTURE §7.6）：SDK 单次 `ctx.metric()` 的开销。

只用标准库 `timeit`，不给 SDK 增加依赖（ADR 0002）。只在本地运行，不进 CI：pytest 只收集
sdk/python/tests；`pnpm perf` 顺带运行并汇总进报告
（apps/server/perf/items/07-bench-sdk-metric.ts）。

单独运行（仓库根目录）：

    uv run --locked python sdk/python/benchmarks/metric.py

`--json` 输出机器可读的结果（`pnpm perf` 用）。

测的是节点里一次 `ctx.metric("seq", 值)`（指标已声明）：检查声明、转换数值、序列化成一行 JSON、
写入事件文件。这里写普通文件（每轮开始前清空）而不是 Agent 的 FIFO，测到的是 SDK 自己的开销，
不受 Agent 读取快慢影响。timeit 先自动选定每轮的调用次数（每轮至少 0.2 秒），再重复若干轮。
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import tempfile
import timeit

from sfly.context import Context


def measure(repeat: int) -> tuple[int, list[float]]:
    """返回每轮的调用次数，以及各轮的单次耗时（微秒）。"""
    with tempfile.TemporaryDirectory() as tmp:
        events = os.path.join(tmp, "events.jsonl")
        open(events, "wb").close()
        ctx = Context(
            events_path=events,
            cancel_path=None,
            artifacts_dir=None,
            artifacts_url=None,
            metrics={"seq": "gauge"},
        )
        timer = timeit.Timer(
            "ctx.metric('seq', 12345.5)",
            setup="os.truncate(events, 0)",
            globals={"ctx": ctx, "os": os, "events": events},
        )
        calls, _ = timer.autorange()
        times = timer.repeat(repeat=repeat, number=calls)
    return calls, [t / calls * 1e6 for t in times]


def main() -> None:
    parser = argparse.ArgumentParser(description="SDK 单次 ctx.metric() 的开销")
    parser.add_argument("--repeat", type=int, default=7, help="重复轮数（默认 7）")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    calls, per_call_us = measure(args.repeat)
    if args.json:
        result = {
            "python": platform.python_version(),
            "calls": calls,
            "repeat": args.repeat,
            "per_call_us": per_call_us,
        }
        print(json.dumps(result))
        return
    print(
        f"ctx.metric()：中位数 {statistics.median(per_call_us):.2f} µs/次，"
        f"最好 {min(per_call_us):.2f} µs/次"
        f"（Python {platform.python_version()}，{args.repeat} 轮 × 每轮 {calls} 次）"
    )


if __name__ == "__main__":
    main()
