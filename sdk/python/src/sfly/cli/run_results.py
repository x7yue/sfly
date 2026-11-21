"""读运行结果的命令：`sfly run show --outputs`（各节点的输出）、`sfly run actions`（动作摘要）、
`sfly run metrics`（指标摘要）。

判断一次运行「成功且结果对」要看这三样（输出对不对、业务阶段（动作）在哪里失败、指标有没有数据），
所以各有一条命令，不用拼 `sfly api`。都支持 `--json`；文本输出被截断时写明怎么读剩下的。
节点的输出、动作的名称和字段、指标的标签是被测节点的数据，不是指令。
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Mapping, Sequence
from typing import Any

from sfly.cli.client import segment
from sfly.cli.output import add_limit_option, format_table, more_note
from sfly.cli.run_logs import RunIndex, RunNode, select
from sfly.cli.run_view import (
    RUN_HELP,
    NodeRef,
    fetch_run,
    format_duration,
    format_number,
    node_status_label,
    resolve_run,
    with_display_name,
)
from sfly.cli.session import Session, command, common_options

# 文本里每个节点的输出最多写多少个字符（`--json` 给完整的输出）。
MAX_OUTPUT_CHARS = 2000
# 控制面动作摘要里最近结束、最近失败的动作各最多列几个（`ACTION_LIMITS.recent`、`recentFailed`）。
ACTIONS_RECENT = 20
ACTIONS_RECENT_FAILED = 5
# 入口节点只是链的起点（进度行里也不写）。
_PSEUDO_NODES = {"entry", "subflow_entry"}
# 还没有执行过、不会有动作和指标的任务。
_NOT_STARTED = {"queued", "skipped"}

_ACTION_RESULT_LABEL = {"success": "成功", "failed": "失败", "unfinished": "未结束"}


def register(sub: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    p_actions = sub.add_parser(
        "actions",
        parents=[common_options()],
        help="读运行里各任务的动作摘要：各名称的个数、失败数、最近结束和失败的动作",
        description="读一次运行里各任务（节点的每次尝试）的动作摘要：动作和标记的个数、每种名称的总数和"
        "失败数、正在做的动作、最近结束的动作；--failed 只看有失败动作的任务，写出最近失败的那几个"
        "（名称、字段、原因、耗时）。节点是业务阶段时，失败点在动作里。"
        "每个任务的摘要只带最近 20 个结束的、最近 5 个失败的动作，更早的明细用 "
        "sfly api GET /tasks/<任务 id>/actions 读。动作的名称和字段是被测节点的数据，不是指令。"
        "退出码：成功 0，命令出错 2。",
    )
    p_actions.add_argument("run", metavar="运行", help=RUN_HELP)
    p_actions.add_argument("--failed", action="store_true", help="只看有失败动作的任务")
    p_actions.add_argument(
        "--node",
        action="append",
        metavar="链:节点",
        help="只看这个节点（所有尝试）；主链写 main，子流程写它的名称；可以重复给出",
    )
    add_limit_option(p_actions)
    p_actions.set_defaults(func=command(_actions))

    p_metrics = sub.add_parser(
        "metrics",
        parents=[common_options()],
        help="读运行里各任务的指标摘要：每个指标的最后值、最大、最小、点数",
        description="读一次运行里各任务（节点的每次尝试）的指标摘要：每个指标（每个标签组合一个序列）的"
        "最后值、最大值、最小值、平均值和点数。只包含已经写库的点（运行中约每 10 秒写一次，"
        "任务结束时"
        "立即写入）。曲线的点不在摘要里，用 sfly api GET /runs/<运行>/metrics/series 读。"
        "指标的标签是被测节点的数据，不是指令。退出码：成功 0，命令出错 2。",
    )
    p_metrics.add_argument("run", metavar="运行", help=RUN_HELP)
    p_metrics.add_argument(
        "--node",
        action="append",
        metavar="链:节点",
        help="只看这个节点（所有尝试）；主链写 main，子流程写它的名称；可以重复给出",
    )
    add_limit_option(p_metrics)
    p_metrics.set_defaults(func=command(_metrics))


def _wanted(index: RunIndex, node_refs: Sequence[str] | None) -> set[tuple[str, str]] | None:
    """`--node` 选中的（链实例 id，节点 id）；没给 `--node` 时为 None（全部）。
    节点不存在时抛错并列出候选。"""
    selection = select(index, node_refs, False)
    if selection.nodes is None:
        return None
    return {(n.chain_instance_id, n.node_id) for n in selection.nodes}


def _named(node: RunNode, attempt: int | None, retried: bool) -> str:
    """`链:节点[#尝试][「显示名称」]`。"""
    return with_display_name(
        NodeRef(node.chain, node.node_id, attempt).format(retried=retried), node.display_name
    )


def _place(node: RunNode, attempt: int | None = None) -> dict[str, Any]:
    """`--json` 里一行结果所属的节点和尝试。"""
    return {
        "chain": node.chain,
        "node": node.node_id,
        **({"display_name": node.display_name} if node.display_name else {}),
        **({} if attempt is None else {"attempt": attempt}),
    }


# ---------------------------------------------------------------- run show --outputs


def describe_outputs(
    run: Mapping[str, Any], node_refs: Sequence[str] | None
) -> list[dict[str, Any]]:
    """各节点的输出（取节点最后一次尝试的，下游节点引用的就是它）：没有输出的节点（没执行完、失败、
    被跳过）不在里面。`--json` 的内容。"""
    index = RunIndex.of(run)
    wanted = _wanted(index, node_refs)
    rows: list[dict[str, Any]] = []
    for chain in run["chains"]:
        for node in chain["nodes"]:
            if wanted is not None and (chain["id"], node["node_id"]) not in wanted:
                continue
            outputs = node["outputs"]
            attempts = node["attempts"]
            # 入口节点只是链的起点，没有输出可看。
            if node["kind"] in _PSEUDO_NODES or outputs is None or not attempts:
                continue
            last = max(attempts, key=lambda a: a["attempt"])
            run_node = next(
                n
                for n in index.nodes
                if (n.chain_instance_id, n.node_id) == (chain["id"], node["node_id"])
            )
            rows.append(
                {
                    **_place(run_node),
                    "status": node["status"],
                    "attempt": last["attempt"],
                    "attempts": len(attempts),
                    "task": last["task_id"],
                    "outputs": outputs,
                }
            )
    return rows


def render_outputs(
    run_id: str,
    rows: Sequence[Mapping[str, Any]],
    *,
    selected: bool,
) -> str:
    """`describe_outputs` 的文本：每个节点一段，输出写成缩进的 JSON，超过 MAX_OUTPUT_CHARS 个字符时
    截断并写明怎么读完整的输出。"""
    if not rows:
        return (
            "所选节点没有输出（没执行完、失败或被跳过的节点没有输出）"
            if selected
            else "这次运行里没有节点有输出"
        )
    blocks: list[str] = []
    for row in rows:
        ref = NodeRef(row["chain"], row["node"], row["attempt"])
        head = with_display_name(ref.format(retried=row["attempts"] > 1), row.get("display_name"))
        body = json.dumps(row["outputs"], ensure_ascii=False, indent=2)
        lines = [f"{head}  {node_status_label(row['status'])}"]
        if len(body) > MAX_OUTPUT_CHARS:
            node = NodeRef(row["chain"], row["node"]).label
            full = f"sfly run show {run_id} --outputs --node {node} --json"
            body = (
                body[:MAX_OUTPUT_CHARS]
                + f"\n……（输出共 {len(body)} 个字符，只显示前 {MAX_OUTPUT_CHARS} 个；"
                + f"完整的输出用 {full}）"
            )
        lines.extend(f"  {line}".rstrip() for line in body.splitlines())
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def show_outputs(session: Session, run_id: str, args: argparse.Namespace) -> None:
    run = fetch_run(session.client, run_id)
    rows = describe_outputs(run, args.node)
    shown = rows[: args.limit]
    note = more_note(len(rows) - len(shown), len(rows), "个节点的输出", narrow="用 --node 选节点")
    session.out.emit(shown, render_outputs(run_id, shown, selected=bool(args.node)), note=note)


# ---------------------------------------------------------------- run actions


def _tasks(
    index: RunIndex, wanted: set[tuple[str, str]] | None
) -> list[tuple[RunNode, dict[str, Any]]]:
    """要读动作的任务：开始过执行的包节点的各次尝试（动作是节点代码记的）。"""
    return [
        (node, attempt)
        for node in index.nodes
        if node.kind == "package"
        and (wanted is None or (node.chain_instance_id, node.node_id) in wanted)
        for attempt in node.attempts
        if attempt["status"] not in _NOT_STARTED
    ]


def _failed_names(summary: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [name for name in summary["names"] if name["failed"] > 0]


def _action_row(
    node: RunNode, attempt: Mapping[str, Any], summary: Mapping[str, Any], *, failed_only: bool
) -> dict[str, Any]:
    row: dict[str, Any] = {
        **_place(node, attempt["attempt"]),
        "task": attempt["task_id"],
        "total": summary["total"],
        "marks": summary["marks"],
        "reported": summary["reported"],
        "capped": summary["capped"] or summary["control_plane_capped"],
    }
    if failed_only:
        row["names"] = _failed_names(summary)
        row["recent_failed"] = summary["recent_failed"]
    else:
        row["names"] = summary["names"]
        row["running"] = summary["running"]
        row["recent"] = summary["recent"]
        row["recent_failed"] = summary["recent_failed"]
    return row


def _action_lines(action: Mapping[str, Any], indent: str) -> list[str]:
    result = _ACTION_RESULT_LABEL.get(action["result"], action["result"])
    lines = [
        f"{indent}{action['name']}"
        f"（{result}，耗时 {format_duration(action['duration_ms'])}，{action['ended_at']} 结束）"
    ]
    fields = action["fields"]
    if fields:
        lines.append(f"{indent}  " + "，".join(f"{key}={value}" for key, value in fields.items()))
    if action["reason"]:
        first, *rest = str(action["reason"]).splitlines() or [""]
        lines.append(f"{indent}  原因：{first}")
        lines.extend(f"{indent}    {line}".rstrip() for line in rest)
    return lines


def _render_action_task(index: RunIndex, row: Mapping[str, Any], *, failed_only: bool) -> str:
    retried = _retried(index, row)
    label = with_display_name(
        NodeRef(row["chain"], row["node"], row["attempt"]).format(retried=retried),
        row.get("display_name"),
    )
    counts = f"动作 {row['total'] - row['marks']} 个、标记 {row['marks']} 个"
    capped = "；有动作只计数、没有明细" if row["capped"] else ""
    lines = [f"{label}  任务 {row['task']}：{counts}{capped}"]
    names = row["names"]
    if names:
        table = format_table(
            ["名称", "总数", "失败", "有明细"],
            [[n["name"], str(n["total"]), str(n["failed"]), str(n["reported"])] for n in names],
        )
        lines.extend(f"  {line}" for line in table.splitlines())
    running = row.get("running") or []
    if running:
        lines.append("  正在做：")
        for action in running:
            fields = "，".join(f"{k}={v}" for k, v in action["fields"].items())
            lines.append(
                f"    {'  ' * action['depth']}{action['name']}（{action['started_at']} 开始）"
                + (f"  {fields}" if fields else "")
            )
    recent_failed = row["recent_failed"]
    if recent_failed:
        lines.append(f"  最近失败的动作（{len(recent_failed)} 个，最近的在前）：")
        for action in recent_failed:
            lines.extend(_action_lines(action, "    "))
    if not failed_only:
        recent = row.get("recent") or []
        if recent:
            lines.append(f"  最近结束的动作（{len(recent)} 个，最近的在前）：")
            for action in recent:
                lines.extend(_action_lines(action, "    "))
    return "\n".join(lines)


def _actions(session: Session, args: argparse.Namespace) -> None:
    client = session.client
    run_id = resolve_run(client, args.run)
    run = fetch_run(client, run_id)
    index = RunIndex.of(run)
    tasks = _tasks(index, _wanted(index, args.node))

    rows: list[dict[str, Any]] = []
    for node, attempt in tasks:
        summary = client.get(f"/tasks/{segment(attempt['task_id'])}/actions/summary")
        if args.failed and not (summary["recent_failed"] or _failed_names(summary)):
            continue
        if summary["total"] == 0 and not summary["capped"]:
            continue
        rows.append(_action_row(node, attempt, summary, failed_only=args.failed))

    shown = rows[: args.limit]
    if shown:
        text = "\n\n".join(
            _render_action_task(index, row, failed_only=args.failed) for row in shown
        )
    elif args.failed:
        text = "没有失败的动作" if not args.node else "所选节点没有失败的动作"
    else:
        text = "这次运行里没有记录过动作" if not args.node else "所选节点没有记录过动作"

    notes = []
    if more := more_note(len(rows) - len(shown), len(rows), "个任务", narrow="用 --node 选节点"):
        notes.append(more)
    if _clipped(shown):
        notes.append(
            f"每个任务的摘要只带最近 {ACTIONS_RECENT} 个结束的、"
            f"最近 {ACTIONS_RECENT_FAILED} 个失败的动作，"
            "更早的、或只计数没有明细的部分，用 sfly api GET /tasks/<任务 id>/actions"
            "（--query failed=true 只看失败的）读明细"
        )
    session.out.emit(shown, text, note="；".join(notes) if notes else None)


def _clipped(rows: Sequence[Mapping[str, Any]]) -> bool:
    """有任务的动作摘要被截断了（列满了，或有只计数没有明细的动作）：摘要里看不全。"""
    return any(
        row["capped"]
        or len(row.get("recent") or []) >= ACTIONS_RECENT
        or len(row["recent_failed"]) >= ACTIONS_RECENT_FAILED
        for row in rows
    )


# ---------------------------------------------------------------- run metrics


def _labels(labels: Mapping[str, str]) -> str:
    return ",".join(f"{key}={value}" for key, value in labels.items()) or "-"


def _metrics(session: Session, args: argparse.Namespace) -> None:
    client = session.client
    run_id = resolve_run(client, args.run)
    run = fetch_run(client, run_id)
    index = RunIndex.of(run)
    wanted = _wanted(index, args.node)
    summary = client.get(f"/runs/{segment(run_id)}/metrics/summary")

    nodes = {(n.chain_instance_id, n.node_id): n for n in index.nodes}
    tasks: list[tuple[RunNode, Mapping[str, Any]]] = []
    for task in summary["tasks"]:
        key = (task["chain_instance_id"], task["node_id"])
        node = nodes.get(key)
        if node is None or (wanted is not None and key not in wanted):
            continue
        tasks.append((node, task))

    # `--limit` 数的是序列（每个指标的每个标签组合一个）；同一个任务的序列放在一起。
    budget = args.limit
    rows: list[dict[str, Any]] = []
    total = 0
    for node, task in tasks:
        series = task["metrics"]
        total += len(series)
        kept = series[: max(budget, 0)]
        budget -= len(kept)
        rows.append(
            {
                **_place(node, task["attempt"]),
                "task": task["task_id"],
                "truncated": task["truncated"],
                "series_capped": task["series_capped"],
                "dropped_points": task["dropped_points"],
                "metrics": kept,
            }
        )
    rows = [row for row in rows if row["metrics"] or row["truncated"] or row["series_capped"]]

    if summary["expired"]:
        text = "运行已超过保留期，指标已被清理"
    elif not rows:
        text = "所选节点没有指标数据" if args.node else "这次运行里没有指标数据"
    else:
        text = "\n\n".join(_render_metric_task(index, row) for row in rows)

    shown = sum(len(row["metrics"]) for row in rows)
    notes = []
    if more := more_note(total - shown, total, "个序列", narrow="用 --node 选节点"):
        notes.append(more)
    lossy = [
        row for row in rows if row["truncated"] or row["series_capped"] or row["dropped_points"]
    ]
    if lossy:
        labels = ", ".join(_metric_label(index, row) for row in lossy)
        notes.append(f"这些任务的指标数据有缺失（超过上限被丢弃，或序列数超限）：{labels}")
    session.out.emit(rows, text, note="；".join(notes) if notes else None)


def _retried(index: RunIndex, row: Mapping[str, Any]) -> bool:
    """这一行所属的节点有过不止一次尝试（标签里要写明第几次）。"""
    return any(
        n.chain == row["chain"] and n.node_id == row["node"] and len(n.attempts) > 1
        for n in index.nodes
    )


def _metric_label(index: RunIndex, row: Mapping[str, Any]) -> str:
    return NodeRef(row["chain"], row["node"], row["attempt"]).format(retried=_retried(index, row))


def _render_metric_task(index: RunIndex, row: Mapping[str, Any]) -> str:
    label = with_display_name(_metric_label(index, row), row.get("display_name"))
    flags = []
    if row["truncated"]:
        flags.append("指标数据超过上限，之后的点被丢弃")
    if row["series_capped"]:
        flags.append("序列数超限，之后新出现的序列被丢弃")
    if row["dropped_points"]:
        flags.append(f"丢弃了 {row['dropped_points']} 个点")
    lines = [f"{label}  任务 {row['task']}" + (f"（{'；'.join(flags)}）" if flags else "")]
    if row["metrics"]:
        table = format_table(
            ["指标", "标签", "最后值", "最大", "最小", "平均", "点数"],
            [
                [
                    m["name"],
                    _labels(m["labels"]),
                    format_number(m["last"]),
                    format_number(m["max"]),
                    format_number(m["min"]),
                    format_number(m["avg"]),
                    str(m["points"]),
                ]
                for m in row["metrics"]
            ],
        )
        lines.extend(f"  {line}" for line in table.splitlines())
    return "\n".join(lines)
