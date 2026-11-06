"""`sfly run`：在当前项目环境里执行一个节点（本地调试），不经过控制面和 Agent。

和 Agent 用同一个执行器与本地协议（见 `sfly.local`）：节点按 `sfly build` 扫描出的元信息查找，
参数按元信息里的输入 schema 校验。日志实时打印到标准错误；结束后把输出值、指标汇总和运行目录
打印到标准输出。每次运行的工作目录（task.json、output.json、events.jsonl、stdout.log、stderr.log、
artifacts/）是项目下的 `.sfly/runs/<时间>-<节点>/`，互不覆盖。

Ctrl-C 走和平台相同的取消流程：取消标记 + SIGTERM，宽限期过后强制杀掉；再按一次立即杀掉。

退出码：成功 0，节点失败 1，参数不合法（或找不到节点）2，取消 130。
"""

from __future__ import annotations

import json
import signal
import sys
import time
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path
from types import FrameType
from typing import Any

from sfly.local import DEFAULT_GRACE, Cancellation, Execution, LogLine, MetricPoint, execute

#: 运行目录（相对项目根目录）。
RUNS_DIR = Path(".sfly") / "runs"

EXIT_FAILED = 1
EXIT_INVALID = 2
EXIT_CANCELLED = 130


class RunError(Exception):
    """参数不合法或找不到节点：节点没有执行。"""


def _clock(ts: int) -> str:
    return time.strftime("%H:%M:%S", time.localtime(ts / 1000)) + f".{ts % 1000:03d}"


def _print_log(line: LogLine) -> None:
    print(f"{_clock(line.ts)} {line.level:<5} {line.source:<6} {line.message}", file=sys.stderr)


def _number(value: float) -> str:
    return f"{value:g}"


def metric_table(points: Sequence[MetricPoint]) -> list[str]:
    """指标汇总表：每个指标一行（按首次上报的顺序），列出类型、上报次数、最后值、最小值、最大值。"""
    summary: dict[str, dict[str, Any]] = {}
    for point in points:
        row = summary.setdefault(point.name, {"kind": point.kind, "values": []})
        row["values"].append(point.value)
    rows = [["指标", "类型", "次数", "最后值", "最小值", "最大值"]]
    for name, row in summary.items():
        values: list[float] = row["values"]
        rows.append(
            [
                name,
                row["kind"],
                str(len(values)),
                _number(values[-1]),
                _number(min(values)),
                _number(max(values)),
            ]
        )
    widths = [max(_width(r[i]) for r in rows) for i in range(len(rows[0]))]
    return [
        "  ".join(
            cell + " " * (w - _width(cell)) for cell, w in zip(r, widths, strict=True)
        ).rstrip()
        for r in rows
    ]


def _width(text: str) -> int:
    """终端显示宽度（中文按两列）。"""
    return sum(2 if ord(c) > 0x2E80 else 1 for c in text)


def _new_run_dir(project: Path, node: str) -> Path:
    root = project / RUNS_DIR
    root.mkdir(parents=True, exist_ok=True)
    ignore = root.parent / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    for n in range(1, 1000):
        suffix = "" if n == 1 else f"-{n}"
        path = root / f"{stamp}{suffix}-{node}"
        try:
            path.mkdir()
        except FileExistsError:
            continue
        return path
    raise RunError(f"无法在 {root} 下创建运行目录")


def _parse_params(text: str) -> dict[str, Any]:
    try:
        params = json.loads(text)
    except ValueError as error:
        raise RunError(f"参数不合法：--params 不是合法的 JSON（{error}）") from None
    if not isinstance(params, dict):
        raise RunError("参数不合法：--params 必须是 JSON 对象")
    return params


def run(project: Path, node: str, params_text: str, grace: float = DEFAULT_GRACE) -> int:
    """执行节点并打印结果，返回退出码。"""
    from sfly.cli.build import load_project, scan_nodes
    from sfly.local import input_problems

    params = _parse_params(params_text)
    meta = load_project(project)
    nodes = scan_nodes(meta)
    found = next((n for n in nodes if n["name"] == node), None)
    if found is None:
        names = "、".join(n["name"] for n in nodes)
        raise RunError(f"找不到节点 {node}（项目 {meta.name} 里的节点：{names}）")
    problems = input_problems(found["inputs"], params)
    if problems:
        raise RunError("参数不合法：" + "; ".join(problems))

    work = _new_run_dir(project, node)
    cancellation = Cancellation()

    def on_sigint(signum: int, frame: FrameType | None) -> None:
        if cancellation.requested:
            print("强制杀掉进程树……", file=sys.stderr)
            cancellation.cancel(force=True)
        else:
            print("正在取消（再按一次 Ctrl-C 立即杀掉）……", file=sys.stderr)
            cancellation.cancel()

    previous = signal.signal(signal.SIGINT, on_sigint)
    try:
        result = execute(
            found["entry"],
            params,
            work,
            schema=found["inputs"],
            pythonpath=[meta.source_root],
            grace=grace,
            cancellation=cancellation,
            on_log=_print_log,
        )
    finally:
        signal.signal(signal.SIGINT, previous)
    return _report(result)


def _report(result: Execution) -> int:
    if result.status == "success":
        print("输出：")
        print(json.dumps(result.outputs, ensure_ascii=False, indent=2))
    if result.metrics:
        print("指标：")
        print("\n".join(metric_table(result.metrics)))
    artifacts = result.artifacts
    print(f"运行目录：{result.work_dir}")
    if artifacts:
        print(f"产物（{len(artifacts)} 个，在 {result.artifacts_dir}）：")
        for name in artifacts:
            print(f"  {name}")
    error = result.error
    if result.status == "cancelled":
        print(f"已取消：{error.message if error else ''}", file=sys.stderr)
        return EXIT_CANCELLED
    if error is not None:
        detail = f"\n\n{error.traceback.rstrip()}" if error.traceback else ""
        print(f"节点失败：{error.message}{detail}", file=sys.stderr)
        return EXIT_INVALID if error.kind == "config_error" else EXIT_FAILED
    return 0
