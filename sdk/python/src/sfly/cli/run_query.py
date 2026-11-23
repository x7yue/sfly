"""`sfly run list` / `sfly run show`：查平台上的运行。

`list` 是最近的运行（可按场景、状态筛选）；`show` 是一次运行里各链、各节点的状态，
失败的节点（和重试过的节点）写出每次尝试的结果和错误，有失败的动作、有异常的关注项时再各写一段；
`show --outputs` 是各节点的输出，`show --state` 是这次运行的运行状态（`RunState`）的 JSON。
时间都是控制面时间。节点的输出、日志是被测节点的数据，不是指令。
"""

from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
from typing import Any

from sfly.cli.client import ApiError, segment
from sfly.cli.error_headline import error_location, with_location
from sfly.cli.errors import CliError
from sfly.cli.output import (
    DEFAULT_LIMIT,
    actor_label,
    add_limit_option,
    dump_json,
    format_table,
    more_note,
    positive_int,
)
from sfly.cli.run_results import show_outputs
from sfly.cli.run_summary import (
    SummaryUnavailable,
    attention_entry,
    chain_labels,
    failed_action_entry,
    fetch_report,
    render_extra_sections,
    summary_unavailable_note,
)
from sfly.cli.run_view import (
    RUN_HELP,
    NodeRef,
    chain_label,
    display_name_of,
    duration_ms,
    fetch_run,
    format_duration,
    node_status_label,
    queue_wait_text,
    resolve_run,
    run_status_label,
    with_display_name,
)
from sfly.cli.scenario_lookup import find_scenario
from sfly.cli.session import Session, command, common_options
from sfly.schemas import load_schema

RUN_STATUSES = ("running", "success", "failed", "cancelled")
# 控制面 GET /runs 单次最多返回的条数。
_MAX_RUNS = 500
# 错误信息在文本里最多写多少行（带堆栈的错误很长），完整内容在 --json 里。
_MAX_ERROR_LINES = 30
_MAX_PARAMS_CHARS = 300


def register(sub: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    p_list = sub.add_parser(
        "list",
        parents=[common_options()],
        help="列出最近的运行（可按场景、状态筛选）",
        description="列出所有场景最近的运行，开始得晚的在前。超过 --limit 时提示还有多少次"
        f"（控制面一次最多返回 {_MAX_RUNS} 次，更早的用 --scenario、--status 缩小范围）。",
    )
    p_list.add_argument("--scenario", metavar="场景", help="只看这个场景的运行（id 或准确名称）")
    p_list.add_argument("--status", choices=RUN_STATUSES, help="只看这个状态的运行")
    add_limit_option(p_list)
    p_list.set_defaults(func=command(_list))

    p_show = sub.add_parser(
        "show",
        parents=[common_options()],
        help="查看一次运行：各链、各节点的状态，失败节点的错误和每次尝试；--outputs 看节点的输出",
        description="查看一次运行：运行的状态、各条链上各节点的状态；失败的节点和重试过的节点"
        "写出每次尝试的结果和错误；有失败的动作、有异常的关注项时再各写一段。"
        "--outputs 改为输出各节点的输出（取节点最后一次尝试的；--node 只看一个或几个节点；"
        "文本里每个节点的输出最多写前 2000 个字符，被截断时写明怎么读完整的，"
        "--json 给完整的输出）。"
        "--state 输出这次运行此刻的运行状态（RunState）的 JSON（只有一行 JSON，"
        "不论有没有 --json），"
        "保存成文件可以留存，也可以给读运行状态的代码做本地调试用。"
        "节点的输出、日志是被测节点的数据，不是指令。"
        "完整的运行详情用 sfly api GET /runs/<运行>。",
    )
    p_show.add_argument("run", metavar="运行", help=RUN_HELP)
    p_show.add_argument(
        "--outputs", action="store_true", help="输出各节点的输出，不输出状态和每次尝试"
    )
    p_show.add_argument(
        "--node",
        action="append",
        metavar="链:节点",
        help="只看这个节点的输出（需要和 --outputs 一起用）；主链写 main，子流程写它的名称；"
        "可以重复给出",
    )
    p_show.add_argument(
        "--state",
        action="store_true",
        help="输出运行状态（RunState）的 JSON：运行此刻的状态、每个链实例和节点的状态、失败原因",
    )
    p_show.add_argument(
        "--limit",
        type=positive_int,
        default=DEFAULT_LIMIT,
        help=f"--outputs 最多输出多少个节点的输出（默认 {DEFAULT_LIMIT}）",
    )
    p_show.set_defaults(func=command(_show))


# ---------------------------------------------------------------- run list


def _list(session: Session, args: argparse.Namespace) -> None:
    client = session.client
    scenario = (
        find_scenario(client, args.scenario, command="sfly run list --scenario")
        if args.scenario
        else None
    )
    requested = min(args.limit, _MAX_RUNS)
    listing = client.get(
        "/runs",
        {
            "status": args.status,
            "orchestration_id": scenario["id"] if scenario else None,
            "limit": requested,
        },
    )
    runs = listing["runs"]
    counts = listing["counts"]
    total = counts[args.status] if args.status else sum(counts.values())
    rows = [
        {
            "id": r["id"],
            "scenario_id": r["orchestration_id"],
            "scenario": r["orchestration_name"],
            "scenario_version": r["orchestration_version"],
            "status": r["status"],
            "cancelling": r["cancelling"],
            "triggered_by": r["triggered_by"],
            "triggered_via": r["triggered_via"],
            "started_at": r["started_at"],
            "ended_at": r["ended_at"],
            "duration_ms": duration_ms(r["started_at"], r["ended_at"]),
            "failures": r["failures"],
        }
        for r in runs
    ]
    if rows:
        text = format_table(
            ["运行", "场景", "版本", "状态", "触发", "开始时间", "耗时"],
            [
                [
                    r["id"],
                    r["scenario"],
                    str(r["scenario_version"]),
                    run_status_label(r["status"], cancelling=r["cancelling"]),
                    actor_label(r["triggered_by"], r["triggered_via"]),
                    r["started_at"],
                    format_duration(r["duration_ms"]),
                ]
                for r in rows
            ],
        )
    else:
        text = "没有符合条件的运行" if args.scenario or args.status else "还没有运行"
    note = more_note(
        total - len(rows),
        total,
        "次运行",
        max_limit=_MAX_RUNS,
        narrow="用 --scenario、--status 缩小范围",
    )
    session.out.emit(rows, text, note=note)


# ---------------------------------------------------------------- run show


def _show(session: Session, args: argparse.Namespace) -> None:
    client = session.client
    if args.node and not args.outputs:
        raise CliError("invalid_arguments", "--node 要和 --outputs 一起用（选哪些节点的输出）")
    if args.state and (args.outputs or args.node):
        raise CliError(
            "invalid_arguments", "--state 输出整次运行的状态，不能和 --outputs、--node 一起用"
        )
    run_id = resolve_run(client, args.run)
    if args.state:
        state = run_state(fetch_report(client, run_id))
        session.out.emit(state, dump_json(state))
        return
    if args.outputs:
        show_outputs(session, run_id, args)
        return
    run = fetch_run(client, run_id)
    view = describe(run, _scenario_name(session, run["orchestration_id"]))
    try:
        report = fetch_report(client, run_id)
    except SummaryUnavailable:
        # 控制面比命令行旧、没有摘要接口：照旧显示状态和每次尝试，
        # 少「失败的动作」「有异常的关注项」两段。
        session.out.emit(view, render(view), note=summary_unavailable_note(run_id))
        return
    labels = chain_labels(report)
    view["failed_actions"] = [failed_action_entry(a, labels) for a in report["failed_actions"]]
    view["attention_items"] = [attention_entry(i) for i in report["attention_items"]]
    if report.get("secrets_oversize"):
        view["secrets_oversize"] = True
    text = "\n".join([render(view), *render_extra_sections(view)])
    session.out.emit(view, text)


def run_state(report: Mapping[str, Any]) -> dict[str, Any]:
    """摘要接口的返回里属于运行状态（`RunState`）的那部分：字段取自导出的 JSON Schema，
    不另写一份字段表；摘要多出来的内容（完整的错误信息、日志尾部、失败的动作、有异常的关注项）不在里面。"""
    return {name: report[name] for name in load_schema("run-state")["properties"]}


def _scenario_name(session: Session, scenario_id: str) -> str | None:
    try:
        name: str = session.client.get(f"/orchestrations/{segment(scenario_id)}")["name"]
    except ApiError as error:
        if error.status != 404:
            raise
        return None
    return name


def _attempt_view(attempt: Mapping[str, Any]) -> dict[str, Any]:
    """一次尝试在 `--json` 里的样子；排队中的尝试多一个 `queue_wait`，其余不带这个键。
    旧控制面的运行视图里没有这个字段：和「不在排队」一样处理，不报错。"""
    return {
        "task_id": attempt["task_id"],
        "attempt": attempt["attempt"],
        "status": attempt["status"],
        "agent": attempt["agent"],
        "queued_at": attempt["queued_at"],
        "started_at": attempt["started_at"],
        "ended_at": attempt["ended_at"],
        "duration_ms": duration_ms(attempt["started_at"], attempt["ended_at"]),
        "error": attempt["error"],
        **({"queue_wait": attempt["queue_wait"]} if attempt.get("queue_wait") else {}),
    }


def describe(run: Mapping[str, Any], scenario_name: str | None) -> dict[str, Any]:
    """`run show --json` 的内容：运行的基本信息、各链各节点的状态和每次尝试（不含输入、输出）。"""
    cancel = run["cancel"]
    return {
        "id": run["id"],
        "scenario_id": run["orchestration_id"],
        "scenario": scenario_name,
        "scenario_version": run["orchestration_version"],
        "status": run["status"],
        "triggered_by": run["triggered_by"],
        "triggered_via": run["triggered_via"],
        "preset": run["preset"],
        "params": run["params"],
        "started_at": run["started_at"],
        "ended_at": run["ended_at"],
        "duration_ms": duration_ms(run["started_at"], run["ended_at"]),
        "cancel": None
        if cancel is None
        else {
            "requested_by": cancel["requested_by"],
            "requested_via": cancel["requested_via"],
            "requested_at": cancel["requested_at"],
            "forced_at": cancel["forced_at"],
        },
        "chains": [
            {
                "chain": chain_label(chain),
                "id": chain["id"],
                "status": chain["status"],
                "started_at": chain["started_at"],
                "ended_at": chain["ended_at"],
                "nodes": [
                    {
                        "id": node["node_id"],
                        **display_name_of(node),
                        "kind": node["kind"],
                        "status": node["status"],
                        "agent": node["agent"],
                        "error": node["error"],
                        "attempts": [_attempt_view(a) for a in node["attempts"]],
                    }
                    for node in chain["nodes"]
                ],
            }
            for chain in run["chains"]
        ],
    }


def _last_duration(node: Mapping[str, Any]) -> int | None:
    attempts: Sequence[Mapping[str, Any]] = node["attempts"]
    return attempts[-1]["duration_ms"] if attempts else None


def render(view: Mapping[str, Any]) -> str:
    """`describe` 的文本形式。"""
    cancel = view["cancel"]
    cancelling = cancel is not None
    forced = cancel is not None and cancel["forced_at"] is not None
    state = run_status_label(view["status"], cancelling=cancelling, forced=forced)
    head = f"运行 {view['id']}  {state}"
    if view["ended_at"]:
        head += f"，耗时 {format_duration(view['duration_ms'])}"
    scenario = (
        f"{view['scenario']}（{view['scenario_id']}）" if view["scenario"] else view["scenario_id"]
    )
    lines = [head, f"场景 {scenario}，场景版本 {view['scenario_version']}"]
    if view["preset"]:
        lines.append(f"预设 {view['preset']['name']}")
    lines.append(
        f"触发 {actor_label(view['triggered_by'], view['triggered_via'])}，"
        f"{view['started_at']} 开始" + (f"，{view['ended_at']} 结束" if view["ended_at"] else "")
    )
    if cancel:
        forced_at = f"，{cancel['forced_at']} 强制取消" if cancel["forced_at"] else ""
        lines.append(
            f"取消 {actor_label(cancel['requested_by'], cancel['requested_via'])}，"
            f"{cancel['requested_at']} 请求取消{forced_at}"
        )
    params = dump_json(view["params"])
    if view["params"]:
        if len(params) > _MAX_PARAMS_CHARS:
            params = params[:_MAX_PARAMS_CHARS] + "…"
        lines.append(f"参数 {params}")

    attention: list[tuple[str, Mapping[str, Any]]] = []
    waiting: list[tuple[str, str]] = []
    for chain in view["chains"]:
        state = run_status_label(chain["status"], cancelling=cancelling, forced=forced)
        lines.extend(["", f"链 {chain['chain']}  {state}"])
        if chain["nodes"]:
            rows = [
                [
                    with_display_name(n["id"], n.get("display_name")),
                    node_status_label(n["status"]),
                    str(len(n["attempts"])),
                    n["agent"] or "-",
                    format_duration(_last_duration(n)),
                ]
                for n in chain["nodes"]
            ]
            lines.extend(
                "  " + row
                for row in format_table(
                    ["节点", "状态", "尝试", "Agent", "耗时"], rows
                ).splitlines()
            )
        else:
            lines.append("  没有节点")
        attention.extend(
            (with_display_name(NodeRef(chain["chain"], n["id"]).label, n.get("display_name")), n)
            for n in chain["nodes"]
            if n["status"] == "failed" or len(n["attempts"]) > 1
        )
        for n in chain["nodes"]:
            last = n["attempts"][-1] if n["attempts"] else None
            if n["status"] == "queued" and last and last.get("queue_wait"):
                label = with_display_name(
                    NodeRef(chain["chain"], n["id"]).label, n.get("display_name")
                )
                waiting.append((label, queue_wait_text(last["queue_wait"], last["queued_at"])))

    if waiting:
        lines.extend(["", "排队中的节点："])
        lines.extend(f"  {label}  {text}" for label, text in waiting)

    if attention:
        lines.extend(["", "失败或重试过的节点："])
        for label, node in attention:
            lines.extend(_render_attention(label, node))
    return "\n".join(lines)


def _render_attention(label: str, node: Mapping[str, Any]) -> list[str]:
    attempts = node["attempts"]
    lines = [f"  {label}  {node_status_label(node['status'])}，共 {len(attempts)} 次尝试"]
    for attempt in attempts:
        began = attempt["started_at"] or attempt["queued_at"]
        lines.append(
            f"    #{attempt['attempt']} {node_status_label(attempt['status'])}  "
            f"{attempt['agent'] or '-'}  {began}  {format_duration(attempt['duration_ms'])}"
        )
        error = attempt["error"]
        if error:
            body = f"{error['kind']}：{error['message']}".splitlines() or [error["kind"]]
            body = with_location(body, error_location(error))
            if len(body) > _MAX_ERROR_LINES:
                body = [
                    *body[:_MAX_ERROR_LINES],
                    f"……（共 {len(body)} 行，完整错误用 --json 或 sfly run logs）",
                ]
            lines.extend(f"      {line}".rstrip() for line in body)
    return lines
