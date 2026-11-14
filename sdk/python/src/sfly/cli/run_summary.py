"""运行结束时的摘要：状态、耗时，以及每个失败的任务（任务是节点的一次执行尝试）的所在节点、
节点类型、第几次尝试、错误和最后 50 行日志。节点重试过、几次都失败时，每次失败的尝试各列一项。

`sfly run start --wait` 和 `sfly run wait` 在 stdout 输出它；时间都是控制面时间。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sfly.cli.client import Client, segment
from sfly.cli.errors import CliError
from sfly.cli.run_view import (
    NodeRef,
    chain_label,
    duration_ms,
    format_duration,
    format_log_line,
    last_attempt,
    line_time,
    node_type_label,
    run_status_label,
)

# 每个失败任务在摘要里带多少行日志（要看更早的日志用 `sfly run logs`）。
LOG_TAIL_LINES = 50


def run_url(client: Client, run_id: str) -> str:
    """控制台里这次运行的页面。"""
    return f"{client.server}/runs/{segment(run_id)}"


def build_summary(client: Client, run: Mapping[str, Any]) -> dict[str, Any]:
    """已结束的运行的摘要（`--json` 输出的就是它）。读场景版本取节点类型、读每个失败任务的日志；
    这两步失败时不影响摘要的其它部分（节点类型退回内置类型名，日志写明没读到）。"""
    types = _node_types(client, run)
    failed = [
        _failed_task(client, run["id"], chain_label(chain), node, attempt, types)
        for chain in run["chains"]
        for node in chain["nodes"]
        for attempt in _failed_attempts(node)
    ]

    cancel = run["cancel"]
    elapsed = duration_ms(run["started_at"], run["ended_at"])
    return {
        "id": run["id"],
        "status": run["status"],
        "scenario_id": run["orchestration_id"],
        "scenario_version": run["orchestration_version"],
        "started_at": run["started_at"],
        "ended_at": run["ended_at"],
        "duration_seconds": None if elapsed is None else elapsed / 1000,
        "url": run_url(client, run["id"]),
        "cancelled_by": (
            {
                "nickname": cancel["requested_by"],
                "at": cancel["requested_at"],
                "forced": cancel["forced_at"] is not None,
            }
            if cancel and run["status"] == "cancelled"
            else None
        ),
        "failed": failed,
    }


def _failed_attempts(node: Mapping[str, Any]) -> list[dict[str, Any] | None]:
    """节点上每次失败的尝试，按尝试顺序（重试之后成功的节点，失败的那几次也算）。节点失败了、
    却没有失败的尝试时（还没开始执行就失败），用它最后一次尝试，没有尝试时是 None。"""
    failed: list[dict[str, Any] | None] = [
        a for a in sorted(node["attempts"], key=lambda a: a["attempt"]) if a["status"] == "failed"
    ]
    if not failed and node["status"] == "failed":
        return [last_attempt(node)]
    return failed


def _failed_task(
    client: Client,
    run_id: str,
    chain: str,
    node: Mapping[str, Any],
    attempt: dict[str, Any] | None,
    types: Mapping[str, str],
) -> dict[str, Any]:
    # 节点级的错误是最后一次尝试的错误，只在这次尝试自己没有错误信息时补上。
    error = attempt["error"] if attempt else None
    if error is None and attempt is last_attempt(node):
        error = node["error"]
    entry: dict[str, Any] = {
        "chain": chain,
        "node": node["node_id"],
        "type": types.get(node["node_id"]) or node_type_label(node),
        "attempt": attempt["attempt"] if attempt else None,
        "attempts": len(node["attempts"]),
        "task": attempt["task_id"] if attempt else None,
        "error": error,
    }
    if attempt:
        more = f"sfly run logs {run_id} --node {NodeRef(chain, node['node_id']).label}"
        entry.update(_task_logs(client, attempt["task_id"], more))
    return entry


def _node_types(client: Client, run: Mapping[str, Any]) -> dict[str, str]:
    """节点 id → 节点类型（包节点是 `包名/节点名`），取自运行用的那个场景版本。"""
    try:
        version = client.get(
            f"/orchestrations/{segment(run['orchestration_id'])}"
            f"/versions/{run['orchestration_version']}"
        )
    except CliError:
        return {}
    return {node["id"]: node_type_label(node) for node in version["document"]["nodes"]}


def _task_logs(client: Client, task_id: str, more: str) -> dict[str, Any]:
    try:
        page = client.get(f"/tasks/{segment(task_id)}/logs", {"limit": LOG_TAIL_LINES})
    except CliError as error:
        return {"logs": [], "logs_note": f"没有读到日志：{error.message.splitlines()[0]}"}
    lines = [
        {
            "time": line_time(line),
            "level": line["level"],
            "source": line["source"],
            "text": line["text"],
        }
        for line in page["lines"]
    ]
    note = None
    if page["expired"]:
        note = "日志已过保留期，已被清理"
    elif page["start"] > 0:
        note = f"前面还有更早的日志，用 {more} 查看"
    return {"logs": lines, "logs_note": note}


def render_summary(summary: Mapping[str, Any]) -> str:
    """摘要的文本形式。"""
    lines = [f"运行 {summary['id']}：{run_status_label(summary['status'])}"]
    cancelled = summary["cancelled_by"]
    if cancelled:
        how = "强制取消" if cancelled["forced"] else "取消"
        lines.append(f"由 {cancelled['nickname']} {how}（{cancelled['at']}）")
    if summary["duration_seconds"] is not None:
        lines.append(f"耗时：{format_duration(round(summary['duration_seconds'] * 1000))}")
    lines.append(f"链接：{summary['url']}")
    failed = summary["failed"]
    if failed:
        lines.extend(["", f"失败的任务（{len(failed)} 个）："])
    for item in failed:
        lines.extend(_render_failed(item))
    return "\n".join(lines)


def _render_failed(item: Mapping[str, Any]) -> list[str]:
    tries = ""
    if item["attempt"] is not None:
        tries = f"，第 {item['attempt']} 次尝试"
    ref = NodeRef(item["chain"], item["node"], item["attempt"])
    lines = [f"  {ref.format(retried=item['attempts'] > 1)}（{item['type']}{tries}）"]
    error = item["error"]
    if error:
        message = error["message"].rstrip().splitlines() or [""]
        lines.append(f"    错误：{error['kind']}：{message[0]}")
        lines.extend(f"      {line}".rstrip() for line in message[1:])
    else:
        lines.append("    错误：没有错误信息")
    logs = item.get("logs") or []
    if logs:
        lines.append(f"    最后 {len(logs)} 行日志：")
        lines.extend(format_log_line(line, indent="      ") for line in logs)
    elif item.get("logs_note") is None and item.get("task"):
        lines.append("    没有日志")
    if item.get("logs_note"):
        lines.append(f"    （{item['logs_note']}）")
    return lines
