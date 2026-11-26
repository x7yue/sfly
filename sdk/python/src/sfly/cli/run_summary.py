"""运行结束时的摘要：状态、耗时，以及每个失败的任务（任务是节点的一次执行尝试）的所在节点、
节点类型、第几次尝试、错误和最后 50 行日志；有失败的动作、有异常的关注项时再各写一段。
节点重试过、几次都失败时，每次失败的尝试各列一项。

内容由控制面的运行摘要接口（`GET /runs/:id/summary`，契约见 `@sfly/schema` 的 `RunReport`）给出，
这里只把它换成命令行的写法：`--json` 的键、文本的版式都和以前一样，多出来的是 `failed_actions`、
`attention_items` 两项和它们对应的两段文字。

`sfly run start --wait` 和 `sfly run wait` 在 stdout 输出它，`sfly run show` 在末尾带上新增的两段；
时间都是控制面时间。

命令行连到比它旧的控制面（没有摘要接口）时：`run start --wait`、`run wait` 退回到只有状态的最小摘要
（`minimal_summary`，失败的任务用 `sfly run show`、`sfly run logs --failed` 看），
退出码仍然按运行的结果给；
`run show` 少那两段，`run show --state` 报错（它要这个接口）。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sfly.cli.client import ApiError, Client, segment
from sfly.cli.error_headline import error_location, location_line, split_error
from sfly.cli.errors import CliError
from sfly.cli.run_view import (
    NodeRef,
    chain_name,
    duration_ms,
    fetch_run,
    format_duration,
    format_log_line,
    format_number,
    line_time,
    node_type_label,
    run_status_label,
    with_display_name,
)

# 摘要里异常的原因。
_LOG_LEVELS = "WARN / ERROR"


def run_url(client: Client, run_id: str) -> str:
    """控制台里这次运行的页面。"""
    return f"{client.shown_server}/runs/{segment(run_id)}"


class SummaryUnavailable(CliError):
    """控制面没有运行摘要接口：它比这个命令行旧。"""

    def __init__(self) -> None:
        super().__init__(
            "summary_unavailable",
            "控制面没有运行摘要接口（它比这个命令行旧）：升级控制面，或用和控制面同版本的命令行",
        )


def fetch_report(client: Client, run_id: str) -> dict[str, Any]:
    """控制面的运行摘要（`RunReport`，原样）。运行不存在时抛 `run_not_found`；运行存在、
    控制面却没有这个接口（比命令行旧）时抛 `SummaryUnavailable`。"""
    try:
        report: dict[str, Any] = client.get(f"/runs/{segment(run_id)}/summary")
    except ApiError as error:
        if error.status != 404:
            raise
        # 404 有两种：运行不存在，或者控制面不认这个路径。再读一次运行，分辨是哪一种。
        fetch_run(client, run_id)
        raise SummaryUnavailable() from None
    return report


def fetch_summary(client: Client, run_id: str) -> dict[str, Any]:
    """运行的摘要（`--json` 输出的就是它）：读控制面的摘要接口，换成命令行的写法。"""
    return summary_of(client, fetch_report(client, run_id))


def _base_summary(
    client: Client,
    *,
    run_id: str,
    status: str,
    scenario_id: str,
    scenario_version: int,
    started_at: str,
    ended_at: str | None,
    elapsed_ms: int | None,
    cancel: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """摘要里不依赖失败内容的那部分键（状态、耗时、链接、谁取消的）；失败的部分是空的。"""
    return {
        "id": run_id,
        "status": status,
        "scenario_id": scenario_id,
        "scenario_version": scenario_version,
        "started_at": started_at,
        "ended_at": ended_at,
        "duration_seconds": None if elapsed_ms is None else elapsed_ms / 1000,
        "url": run_url(client, run_id),
        "cancelled_by": (
            {
                "nickname": cancel["requested_by"],
                "at": cancel["requested_at"],
                "forced": cancel["forced_at"] is not None,
            }
            if cancel and status == "cancelled"
            else None
        ),
        "failed": [],
        "failed_total": 0,
        "failed_actions": [],
        "attention_items": [],
    }


def summary_of(client: Client, report: Mapping[str, Any]) -> dict[str, Any]:
    """把摘要接口的返回（`RunReport`）换成命令行摘要的样子。"""
    run_id: str = report["run_id"]
    labels = chain_labels(report)
    return {
        **_base_summary(
            client,
            run_id=run_id,
            status=report["status"],
            scenario_id=report["scenario"]["id"],
            scenario_version=report["scenario"]["version"],
            started_at=report["started_at"],
            ended_at=report["ended_at"],
            elapsed_ms=report["duration_ms"],
            cancel=report["cancel"],
        ),
        "failed": [_failed_task(run_id, task) for task in report["failed_tasks"]],
        "failed_total": report["failed_tasks_total"],
        "failed_actions": [
            failed_action_entry(action, labels) for action in report["failed_actions"]
        ],
        "attention_items": [attention_entry(item) for item in report["attention_items"]],
        # 只在 secret 值太多时才有这个键：正常的摘要和以前一字不差。
        **({"secrets_oversize": True} if report.get("secrets_oversize") else {}),
    }


def minimal_summary(client: Client, run: Mapping[str, Any]) -> dict[str, Any]:
    """控制面没有摘要接口时的摘要：只有运行视图里有的——状态、耗时、链接、谁取消的，没有失败的任务。"""
    return _base_summary(
        client,
        run_id=run["id"],
        status=run["status"],
        scenario_id=run["orchestration_id"],
        scenario_version=run["orchestration_version"],
        started_at=run["started_at"],
        ended_at=run["ended_at"],
        elapsed_ms=duration_ms(run["started_at"], run["ended_at"]),
        cancel=run["cancel"],
    )


def summary_unavailable_note(run_id: str) -> str:
    """最小摘要后面的一行提示：为什么没有失败的任务，怎么看它们。"""
    return (
        "提示：控制面没有运行摘要接口（它比这个命令行旧），摘要只有状态，没有失败的任务；"
        f"用 sfly run show {run_id}、sfly run logs {run_id} --failed 看。"
        "升级控制面，或用和控制面同版本的命令行"
    )


def chain_labels(report: Mapping[str, Any]) -> dict[str, str]:
    """摘要里每个链实例 id → 链在命令行里的名字（主链 `main`，子流程是它的名称）。"""
    return {chain["id"]: chain_name(chain["name"]) for chain in report["chains"]}


def _failed_task(run_id: str, task: Mapping[str, Any]) -> dict[str, Any]:
    chain = chain_name(task["chain"])
    error = task["error"]
    entry: dict[str, Any] = {
        "chain": chain,
        "node": task["node_id"],
        **({"display_name": task["display_name"]} if task["display_name"] else {}),
        "type": task["node_type"] or node_type_label({"kind": task["kind"]}),
        "attempt": task["attempt"],
        "attempts": task["attempts"],
        "task": task["task_id"],
        "error": (
            None
            if error is None
            else {
                "kind": error["kind"],
                "message": error["detail"],
                "location": error["location"],
            }
        ),
    }
    logs = task["logs"]
    if logs is not None:
        more = f"sfly run logs {run_id} --node {NodeRef(chain, task['node_id']).label}"
        note = None
        if logs["expired"]:
            note = "日志已过保留期，已被清理"
        elif logs.get("missing"):
            note = (
                "没有读到日志：控制面记着这个任务写过日志，"
                "日志文件里却读不出来（可能被移走或清理了）"
            )
        elif logs["earlier"]:
            note = f"前面还有更早的日志，用 {more} 查看"
        entry["logs"] = [
            {
                "time": line_time(line),
                "level": line["level"],
                "source": line["source"],
                "text": line["text"],
            }
            for line in logs["lines"]
        ]
        entry["logs_note"] = note
    return entry


def failed_action_entry(action: Mapping[str, Any], labels: Mapping[str, str]) -> dict[str, Any]:
    """`--json` 里的一个失败的动作。`labels` 是链实例 id → 链名（{@link chain_labels}）：
    `chain` 和 `node` 合起来就是 `--node` 要的 `链:节点`。"""
    return {
        "chain": labels.get(action["chain_instance_id"], action["chain_instance_id"]),
        "node": action["node_id"],
        **({"display_name": action["display_name"]} if action["display_name"] else {}),
        "chain_instance": action["chain_instance_id"],
        "attempt": action["attempt"],
        "task": action["task_id"],
        "name": action["name"],
        "fields": action["fields"],
        "reason": action["reason"],
        "started_at": action["started_at"],
        "ended_at": action["ended_at"],
        "duration_ms": action["duration_ms"],
    }


def attention_entry(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "position": item["position"],
        "node": item["node_id"],
        **({"display_name": item["display_name"]} if item.get("display_name") else {}),
        "chart": item["chart"],
        "title": item["title"],
        "unit": item["unit"],
        "status": item["source"]["status"],
        "attempt": item["source"]["attempt"],
        "latest": item["latest"],
        "anomaly": item["anomaly"],
    }


#: secret 参数的值太多的运行：为什么看到的内容全是掩码（#657）。不含任何值。
SECRETS_OVERSIZE_NOTE = (
    "提示：这次运行的 secret 参数的值太多或太长，控制面认不出每一处出现，"
    "这次运行里日志、动作、输入输出、错误信息的内容整段显示为 ******；"
    "缩短或减少 secret 参数的值之后重新运行"
)


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
    total = summary.get("failed_total", len(failed))
    if failed:
        # 超过上限时只列前面的，标题写明总数（不超过时和以前一字不差）。
        count = (
            f"{len(failed)} 个"
            if total == len(failed)
            else f"共 {total} 个，列出前 {len(failed)} 个"
        )
        lines.extend(["", f"失败的任务（{count}）："])
    for item in failed:
        lines.extend(_render_failed(item))
    if total > len(failed):
        lines.append(
            f"  （还有 {total - len(failed)} 个失败的任务没有列出，"
            f"sfly run logs {summary['id']} --failed 读它们的日志，"
            f"sfly run show {summary['id']} 看每个节点的每次尝试）"
        )
    lines.extend(render_extra_sections(summary))
    return "\n".join(lines)


def render_extra_sections(summary: Mapping[str, Any]) -> list[str]:
    """「提示」（secret 参数的值太多、内容全是掩码时）「失败的动作」「有异常的关注项」三段，
    没有内容的不写；每段前空一行。

    `sfly run show` 在自己的输出末尾也带上这三段。
    """
    lines: list[str] = []
    if summary.get("secrets_oversize"):
        lines.extend(["", SECRETS_OVERSIZE_NOTE])
    actions = summary.get("failed_actions") or []
    if actions:
        lines.extend(["", f"失败的动作（{len(actions)} 个，最近结束的在前）："])
        for action in actions:
            lines.extend(_render_action(action))
    items = summary.get("attention_items") or []
    if items:
        lines.extend(["", f"有异常的关注项（{len(items)} 个）："])
        for item in items:
            lines.extend(_render_attention(item))
    return lines


def _render_failed(item: Mapping[str, Any]) -> list[str]:
    tries = ""
    if item["attempt"] is not None:
        tries = f"，第 {item['attempt']} 次尝试"
    ref = NodeRef(item["chain"], item["node"], item["attempt"])
    node = with_display_name(ref.format(retried=item["attempts"] > 1), item.get("display_name"))
    lines = [f"  {node}（{item['type']}{tries}）"]
    error = item["error"]
    if error:
        # 「错误：」那一行是失败原因的一行（去掉异常的模块路径，第一行以冒号结尾时接上下一行，
        # 和网页一致），没有并进它的各行原样接在下面；`--json` 里的 error.message 是完整的原文。
        headline, rest = split_error(error["message"])
        lines.append(f"    错误：{error['kind']}：{headline}")
        # 出错位置紧跟在失败原因后面，堆栈之前：不用翻堆栈（旧版本的控制面没有这个键）。
        location = error_location(error)
        if location:
            lines.append(f"    {location_line(location)}")
        lines.extend(f"      {line}".rstrip() for line in rest)
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


def _render_action(action: Mapping[str, Any]) -> list[str]:
    # 动作是哪个节点的哪一次尝试：节点写成 `链:节点`，和 `--node` 要的写法一样，可以直接拿去用
    # （`sfly run actions <运行> --node main:b`）；第几次尝试写在后面。
    node = with_display_name(f"{action['chain']}:{action['node']}", action.get("display_name"))
    lines = [
        f"  {node}（第 {action['attempt']} 次尝试）  {action['name']}"
        f"（耗时 {format_duration(action['duration_ms'])}，{action['ended_at']} 结束）"
    ]
    fields = action["fields"]
    if fields:
        lines.append("    " + "，".join(f"{key}={value}" for key, value in fields.items()))
    if action["reason"]:
        first, *rest = str(action["reason"]).splitlines() or [""]
        lines.append(f"    原因：{first}")
        lines.extend(f"      {line}".rstrip() for line in rest)
    return lines


def _render_attention(item: Mapping[str, Any]) -> list[str]:
    node = with_display_name(str(item["node"]), item.get("display_name"))
    latest = item["latest"]
    value = ""
    if latest is not None:
        unit = f" {item['unit']}" if item["unit"] else ""
        value = f"，最新值 {format_number(latest['value'])}{unit}"
    lines = [f"  {item['position']}. {item['title']}  {node}{value}"]
    lines.append(f"     异常：{_anomaly_text(item['anomaly'], item)}")
    return lines


def _anomaly_text(anomaly: Mapping[str, Any], item: Mapping[str, Any]) -> str:
    """异常的一句话，用词与运行监控一致（apps/web/src/lib/copy.ts）。"""
    kind = anomaly["kind"]
    message = anomaly["message"]
    at = anomaly["at"]
    if kind == "log":
        count = anomaly.get("count") or 1
        level = _LOG_LEVELS if count > 1 else str(anomaly.get("level") or _LOG_LEVELS).upper()
        return f"{count} 条 {level}，最近一条在 {at}：{message}"
    if kind == "stale":
        return f"最后一个数据点在 {at}，之后没有新数据"
    if kind == "failed":
        return f"来源节点失败（{at}）" + (f"：{message}" if message else "")
    attempt = item["attempt"]
    return f"重试（第 {attempt} 次尝试，{at} 开始）" + (
        f"，上一次失败：{message}" if message else ""
    )
