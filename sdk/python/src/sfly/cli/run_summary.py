"""运行结束时的摘要：状态、耗时、失败的节点（节点类型、第几次尝试、错误）
和每个失败任务的最后 50 行日志。

`sfly run start --wait` 和 `sfly run wait` 在 stdout 输出它；时间都是控制面时间。
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from sfly.cli.client import Client, segment
from sfly.cli.errors import CliError

# 每个失败任务在摘要里带多少行日志（要看更早的日志用 `sfly run logs`）。
LOG_TAIL_LINES = 50

MAIN_CHAIN = "main"

# 退出码：成功 0，运行失败 1，运行被取消 3（命令本身出错 2、等待超时 124、Ctrl-C 130 见 run_exec）。
EXIT_BY_STATUS = {"success": 0, "failed": 1, "cancelled": 3}

RUN_STATUS_TEXT = {"running": "运行中", "success": "成功", "failed": "失败", "cancelled": "已取消"}

_BUILTIN_TYPES = {
    "entry": "入口",
    "subflow_entry": "子流程入口",
    "async": "异步任务",
    "timer": "定时",
    "sleep": "Sleep",
    "stop_subflow": "停止子流程",
    "feishu_notify": "飞书通知",
}


def parse_time(text: str) -> datetime:
    """控制面的时间戳（ISO 8601，以 Z 结尾）。"""
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def seconds_between(start: str | None, end: str | None) -> float | None:
    if not start or not end:
        return None
    return max((parse_time(end) - parse_time(start)).total_seconds(), 0.0)


def format_duration(seconds: float) -> str:
    """12.3 秒写 `12s`，不到 10 秒保留一位小数，超过一分钟写 `3m05s`、`1h02m`。"""
    if seconds < 10:
        return f"{seconds:.1f}s"
    whole = int(seconds)
    if whole < 60:
        return f"{whole}s"
    minutes, rest = divmod(whole, 60)
    if minutes < 60:
        return f"{minutes}m{rest:02d}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes:02d}m"


def chain_label(chain: Mapping[str, Any]) -> str:
    """链在命令行输出里的名字：主链是 `main`，子流程用它的名称（没有名称时用入口节点 id）。"""
    if chain.get("name") is None:
        return MAIN_CHAIN
    return str(chain["name"] or chain["chain_id"])


def node_label(
    chain: Mapping[str, Any], node: Mapping[str, Any], attempt: int | None = None
) -> str:
    """`链:节点`，第 2 次起的尝试写成 `链:节点#2`。"""
    label = f"{chain_label(chain)}:{node['node_id']}"
    return f"{label}#{attempt}" if attempt and attempt > 1 else label


def last_attempt(node: Mapping[str, Any]) -> dict[str, Any] | None:
    attempts = node["attempts"]
    return max(attempts, key=lambda a: a["attempt"]) if attempts else None


def run_url(client: Client, run_id: str) -> str:
    """控制台里这次运行的页面。"""
    return f"{client.server}/runs/{segment(run_id)}"


def build_summary(client: Client, run: Mapping[str, Any]) -> dict[str, Any]:
    """已结束的运行的摘要（`--json` 输出的就是它）。读场景版本取节点类型、读每个失败任务的日志；
    这两步失败时不影响摘要的其它部分（节点类型退回内置类型名，日志写明没读到）。"""
    types = _node_types(client, run)
    failed = []
    for chain in run["chains"]:
        for node in chain["nodes"]:
            if node["status"] != "failed":
                continue
            attempt = last_attempt(node)
            entry: dict[str, Any] = {
                "chain": chain_label(chain),
                "node": node["node_id"],
                "type": types.get(node["node_id"], _BUILTIN_TYPES.get(node["kind"], node["kind"])),
                "attempt": attempt["attempt"] if attempt else None,
                "attempts": len(node["attempts"]),
                "task": attempt["task_id"] if attempt else None,
                "error": (attempt["error"] if attempt else None) or node["error"],
            }
            if attempt:
                where = f"sfly run logs {run['id']} --node {chain_label(chain)}:{node['node_id']}"
                entry.update(_task_logs(client, attempt["task_id"], where))
            failed.append(entry)

    cancel = run["cancel"]
    return {
        "id": run["id"],
        "status": run["status"],
        "scenario_id": run["orchestration_id"],
        "scenario_version": run["orchestration_version"],
        "started_at": run["started_at"],
        "ended_at": run["ended_at"],
        "duration_seconds": seconds_between(run["started_at"], run["ended_at"]),
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


def _node_types(client: Client, run: Mapping[str, Any]) -> dict[str, str]:
    """节点 id → 节点类型（包节点是 `包名/节点名`），取自运行用的那个场景版本。"""
    try:
        version = client.get(
            f"/orchestrations/{segment(run['orchestration_id'])}"
            f"/versions/{run['orchestration_version']}"
        )
    except CliError:
        return {}
    types = {}
    for node in version["document"]["nodes"]:
        if node["kind"] == "package":
            types[node["id"]] = f"{node['package']}/{node['node']}"
    return types


def _task_logs(client: Client, task_id: str, more: str) -> dict[str, Any]:
    try:
        page = client.get(f"/tasks/{segment(task_id)}/logs", {"limit": LOG_TAIL_LINES})
    except CliError as error:
        return {"logs": [], "logs_note": f"没有读到日志：{error.message.splitlines()[0]}"}
    lines = [
        {
            "time": line["time"] or line["agent_time"],
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
    lines = [f"运行 {summary['id']}：{RUN_STATUS_TEXT[summary['status']]}"]
    cancelled = summary["cancelled_by"]
    if cancelled:
        how = "强制取消" if cancelled["forced"] else "取消"
        lines.append(f"由 {cancelled['nickname']} {how}（{cancelled['at']}）")
    if summary["duration_seconds"] is not None:
        lines.append(f"耗时：{format_duration(summary['duration_seconds'])}")
    lines.append(f"链接：{summary['url']}")
    failed = summary["failed"]
    if failed:
        lines.extend(["", f"失败的节点（{len(failed)} 个）："])
    for item in failed:
        lines.extend(_render_failed(item))
    return "\n".join(lines)


def _render_failed(item: Mapping[str, Any]) -> list[str]:
    tries = ""
    if item["attempt"] is not None:
        tries = f"，第 {item['attempt']} 次尝试"
    label = f"{item['chain']}:{item['node']}"
    lines = [f"  {label}（{item['type']}{tries}）"]
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
        for line in logs:
            text = line["text"].rstrip("\n").split("\n")
            lines.append(f"      {line['time'] or '-'} {line['level']:<5} {text[0]}")
            lines.extend(f"        {rest}".rstrip() for rest in text[1:])
    elif item.get("logs_note") is None and item.get("task"):
        lines.append("    没有日志")
    if item.get("logs_note"):
        lines.append(f"    （{item['logs_note']}）")
    return lines
