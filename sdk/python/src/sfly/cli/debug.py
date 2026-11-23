"""`sfly debug`：在当前节点包目录的环境里执行一个节点（本地调试），不经过控制面和 Agent。

和 Agent 用同一个执行器与本地协议（见 `sfly.local`）：节点按 `sfly build` 扫描出的元信息查找，
参数按元信息里的输入 schema 校验。日志实时打印到标准错误；结束后把输出值、指标汇总和运行目录
打印到标准输出。每次运行的工作目录（task.json、output.json、事件管道 events.fifo、stdout.log、
stderr.log、artifacts/）是节点包目录下的 `.sfly/runs/<时间>-<节点>/`，互不覆盖。
运行目录名同时作为运行 ID（`ctx.task.run_id`），
后台进程目录（`ctx.procs_dir`）是 `.sfly/procs/<运行目录名>/`。

`--params` 是节点的输入（JSON 对象）：直接写 JSON 文本，或写 `@文件` 从文件读，`@-` 从标准输入读
（和 `sfly api --body @文件` 一致；文件路径相对当前目录）。节点要读整个运行状态（`sfly.RunState`）
时，把一次真实运行的状态存成文件（`sfly run show <运行> --state > state.json`），放进输入对象的
对应键里，再用 `--params @文件` 给节点。

`--download <产物引用> <文件>` 给 `ctx.artifacts.download` 提供本地内容：节点下载这个引用时得到
这个文件的内容，不访问网络（本地没有控制面）。

`--agent <名称>=<目录>` 把一台 Agent 映射到本地目录：节点用 `ctx.agent(名称)` 访问它时，
那台 Agent 上的绝对路径落在这个目录里。`ctx.agent()`（自己所在的 Agent）就是本机。

`ctx.notify` 不真的发送：和日志一起实时打印要发给哪个飞书机器人、请求体是什么。

动作和标记（`ctx.action`、`ctx.mark`）和日志一起实时打印：每个动作开始一行、结束一行（结果和耗时），
每个标记一行，按层级缩进（子动作和属于动作的标记），时间是本机的系统时间。

Ctrl-C 走和平台相同的取消流程：取消标记 + SIGTERM，宽限期过后强制杀掉；再按一次立即杀掉。
节点结束后结果已经确定，打印结果期间的 Ctrl-C 被忽略，退出码按结果给出。

退出码：成功 0，节点失败 1，参数不合法（或找不到节点）2，取消 130。
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
from collections.abc import Mapping, Sequence
from datetime import datetime
from pathlib import Path
from types import FrameType
from typing import Any

from sfly.cli.input_source import STDIN, read_source
from sfly.cli.run_view import format_duration
from sfly.context import ActionResult
from sfly.local import (
    DEFAULT_GRACE,
    ActionRecord,
    Cancellation,
    Execution,
    LogLine,
    MetricPoint,
    Notification,
    execute,
)

#: 运行目录（相对节点包目录）。
RUNS_DIR = Path(".sfly") / "runs"
#: 后台进程目录的根目录（相对节点包目录）。
PROCS_DIR = Path(".sfly") / "procs"

EXIT_FAILED = 1
EXIT_INVALID = 2
EXIT_CANCELLED = 130


class DebugError(Exception):
    """参数不合法或找不到节点：节点没有执行。"""


def _clock(ts: int) -> str:
    return time.strftime("%H:%M:%S", time.localtime(ts / 1000)) + f".{ts % 1000:03d}"


def _print_log(line: LogLine) -> None:
    print(f"{_clock(line.ts)} {line.level:<5} {line.source:<6} {line.message}", file=sys.stderr)


def _print_notification(notification: Notification) -> None:
    body = json.dumps(notification.body, ensure_ascii=False)
    to = f"发给飞书机器人「{notification.bot}」（本地调试不发送）"
    print(f"{_clock(notification.ts)} 通知  {to}：{body}", file=sys.stderr)


_RESULT_TEXT: dict[ActionResult, str] = {
    "success": "成功",
    "failed": "失败",
    "unfinished": "未结束",
}
#: 缩进最多这么多层，更深的和这一层对齐（和界面一样）。
_MAX_INDENT = 3


def format_action(record: ActionRecord) -> str:
    """一个动作开始、结束，或一个标记的终端输出：

    12:00:01.234 动作  开始 #7 下单 订单=1001
    12:00:01.250 动作  成功 #7 下单 16ms 订单=1001 回报=已成交
    12:00:01.251 动作  失败 #8 下单 3ms 订单=1002 原因：ValueError: 拒单
    12:00:01.300 标记  收到第一笔成交 订单=1001
    """
    indent = "  " * min(record.depth, _MAX_INDENT)
    fields = "".join(f" {key}={value}" for key, value in record.fields.items())
    if record.kind == "mark":
        return f"{_clock(record.ts)} 标记  {indent}{record.name}{fields}"
    if record.result is None:
        return f"{_clock(record.ts)} 动作  {indent}开始 #{record.id} {record.name}{fields}"
    assert record.duration_ms is not None
    ended = record.ts + record.duration_ms
    reason = f" 原因：{record.reason}" if record.reason else ""
    return (
        f"{_clock(ended)} 动作  {indent}{_RESULT_TEXT[record.result]} #{record.id} {record.name} "
        f"{format_duration(record.duration_ms)}{fields}{reason}"
    )


def _print_action(record: ActionRecord) -> None:
    print(format_action(record), file=sys.stderr)


def _say_from_signal_handler(text: str) -> None:
    """在信号处理函数里往标准错误写一行。

    处理函数在主线程里运行，可能正好在 `_print_log` 写标准错误的中途（例如 write 被信号打断时）；
    `sys.stderr` 底层的 BufferedWriter 不可重入，这时再用它写会抛 `RuntimeError: reentrant call`，
    所以直接写文件描述符。
    """
    data = (text + "\n").encode("utf-8", errors="replace")
    while data:
        try:
            data = data[os.write(2, data) :]
        except OSError:
            return


def _number(value: float) -> str:
    return f"{value:g}"


def _series_name(point: MetricPoint) -> str:
    """序列在表里的名字：指标名，带标签时后面跟按键排序的 `{键=值,…}`。"""
    if not point.labels:
        return point.name
    pairs = ",".join(f"{k}={v}" for k, v in sorted(point.labels.items()))
    return f"{point.name}{{{pairs}}}"


def metric_table(points: Sequence[MetricPoint]) -> list[str]:
    """指标汇总表：每个序列一行（按首次上报的顺序），列出类型、上报次数、最后值、最小值、最大值。"""
    summary: dict[tuple[str, tuple[tuple[str, str], ...]], dict[str, Any]] = {}
    for point in points:
        key = (point.name, tuple(sorted(point.labels.items())))
        row = summary.setdefault(
            key, {"name": _series_name(point), "kind": point.kind, "values": []}
        )
        row["values"].append(point.value)
    rows = [["指标", "类型", "次数", "最后值", "最小值", "最大值"]]
    for row in summary.values():
        values: list[float] = row["values"]
        rows.append(
            [
                row["name"],
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
    raise DebugError(f"无法在 {root} 下创建运行目录")


def _read_params(source: str) -> str:
    """`--params @<source>` 指的内容：文件，或标准输入（`-`，和 `sfly api --body @-` 一致）。
    读法和 `sfly api --body` 共用（`read_source`）；读不了时抛出 DebugError。"""
    try:
        return read_source(source)
    except FileNotFoundError:
        raise DebugError(f"参数不合法：--params 指定的文件不存在：{source}") from None
    except IsADirectoryError:
        raise DebugError(f"参数不合法：--params 指定的 {source} 是目录，不是文件") from None
    except (OSError, UnicodeDecodeError) as error:
        what = "标准输入" if source == STDIN else f"文件 {source}"
        raise DebugError(f"参数不合法：读不了 --params 的{what}：{error}") from None


def _parse_params(option: str) -> dict[str, Any]:
    """`--params` 的值：JSON 文本，或 `@文件`（`@-` 是标准输入）。必须是 JSON 对象。"""
    if option.startswith("@"):
        source = option[1:]
        text = _read_params(source)
        # 报错里指明是哪个来源：「--params 的文件 p.json 不是…」「--params 的标准输入不是…」。
        subject = "--params 的标准输入" if source == STDIN else f"--params 的文件 {source} "
        hint = ""
    else:
        text = option
        subject = "--params "
        hint = "（读文件用 --params @文件）"
    try:
        params = json.loads(text)
    except ValueError as error:
        raise DebugError(f"参数不合法：{subject}不是合法的 JSON（{error}）{hint}") from None
    if not isinstance(params, dict):
        raise DebugError(f"参数不合法：{subject}必须是 JSON 对象")
    return params


def debug(
    project: Path,
    node: str,
    params_text: str,
    grace: float = DEFAULT_GRACE,
    *,
    downloads: Mapping[str, Path] | None = None,
    agents: Mapping[str, Path] | None = None,
) -> int:
    """执行节点并打印结果，返回退出码。

    `params_text`（`--params`）：输入的 JSON 文本，或 `@文件`（`@-` 是标准输入）。
    `downloads`（`--download`）：产物引用 → 本地文件，节点下载这些引用时得到文件的内容。
    `agents`（`--agent`）：Agent 名称 → 本地目录。
    """
    from sfly.cli.build import load_project, scan_nodes
    from sfly.local import input_problems

    params = _parse_params(params_text)
    for ref, path in (downloads or {}).items():
        if not path.is_file():
            raise DebugError(f"参数不合法：--download 给产物引用 {ref} 指定的文件不存在：{path}")
    for name, root in (agents or {}).items():
        if not root.is_dir():
            raise DebugError(f"参数不合法：--agent 给 Agent {name} 指定的目录不存在：{root}")
    meta = load_project(project)
    nodes = scan_nodes(meta)
    found = next((n for n in nodes if n["name"] == node), None)
    if found is None:
        names = "、".join(n["name"] for n in nodes)
        raise DebugError(f"找不到节点 {node}（节点包 {meta.name} 里的节点：{names}）")
    problems = input_problems(found["inputs"], params)
    if problems:
        raise DebugError("参数不合法：" + "; ".join(problems))

    work = _new_run_dir(project, node)
    cancellation = Cancellation()

    def on_sigint(signum: int, frame: FrameType | None) -> None:
        if cancellation.requested:
            _say_from_signal_handler("强制杀掉进程树……")
            cancellation.cancel(force=True)
        else:
            _say_from_signal_handler("正在取消（再按一次 Ctrl-C 立即杀掉）……")
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
            on_notify=_print_notification,
            on_action=_print_action,
            run_id=work.name,
            node_id=node,
            procs_dir=project.absolute() / PROCS_DIR / work.name,
            downloads=downloads,
            agents=agents,
        )
        # 节点已经结束，结果（和退出码）已经确定：打印结果期间的 Ctrl-C 一律忽略，
        # 否则恢复成默认处理后会在打印中途抛出 KeyboardInterrupt（#122）。
        # 标准输出接管道时是块缓冲，在这里刷完，免得剩下的部分留到退出时才写、又没有保护。
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        code = _report(result)
        sys.stdout.flush()
    finally:
        signal.signal(signal.SIGINT, previous)
    return code


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
        if error.kind == "config_error":
            # 执行器在调用节点之前就拒绝了输入（没有声明的名字）：和其他参数不合法一样，退出码 2。
            print(f"参数不合法：{error.message}", file=sys.stderr)
            return EXIT_INVALID
        detail = f"\n\n{error.traceback.rstrip()}" if error.traceback else ""
        # 出错位置在失败原因后面、堆栈前面：不用翻堆栈就知道改哪一行。
        place = f"\n出错位置：{error.location}" if error.location else ""
        print(f"节点失败：{error.message}{place}{detail}", file=sys.stderr)
        return EXIT_FAILED
    return 0
