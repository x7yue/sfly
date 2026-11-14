"""`sfly agent list`：各台 Agent 的在线状态、版本、运行中的任务数和对外地址。"""

from __future__ import annotations

import argparse
from datetime import datetime
from typing import Any

from sfly.cli.output import add_limit_option, apply_limit, format_table, more_note
from sfly.cli.run_view import parse_time
from sfly.cli.session import Session, command, common_options


def register(sub: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    parser = sub.add_parser(
        "agent",
        help="查看平台上的 sfly Agent：在线状态、版本、运行中的任务数、对外地址",
        description="查看控制面上注册过的 sfly Agent。默认输出精简文本，--json 输出 JSON。"
        "退出码：成功 0，命令出错 2。",
    )
    group = parser.add_subparsers(dest="agent_command", required=True)
    p_list = group.add_parser(
        "list",
        parents=[common_options()],
        help="列出 sfly Agent：在线状态、版本、是否与控制面一致、运行中的任务数、对外地址",
        description="列出注册过的 sfly Agent，按名称排序。"
        "版本与控制面不一致的 Agent 不会被派新任务，它手上的任务照常跑完。"
        "刚连上、还在准备环境（准备 Python 运行环境和 SDK）的 Agent，"
        "状态写「在线（准备环境中，已 N 分 N 秒）」，这期间任务排队等它准备好；"
        "--json 的 preparing_since 是开始准备环境的时间，准备好或离线时为 null。"
        "「开发包」是用 sfly dev 在这台 Agent 上加载的节点包（包名@dev）。"
        "超过 --limit 时提示还有多少台。",
    )
    add_limit_option(p_list)
    p_list.set_defaults(func=command(_list))


def _address(agent: dict[str, Any]) -> str | None:
    endpoint = agent["endpoint"]
    if not endpoint["address"]:
        return None
    port = endpoint["port"]
    return f"{endpoint['address']}:{port}" if port is not None else str(endpoint["address"])


def _elapsed(seconds: float) -> str:
    """`45 秒`、`2 分 10 秒`、`1 小时 2 分`：只写最大的两个单位。"""
    total = max(int(seconds), 0)
    minutes, rest = divmod(total, 60)
    if minutes == 0:
        return f"{rest} 秒"
    hours, minutes = divmod(minutes, 60)
    if hours == 0:
        return f"{minutes} 分 {rest} 秒"
    return f"{hours} 小时 {minutes} 分"


def _status(agent: dict[str, Any], now: datetime | None) -> str:
    """状态列：离线、在线；在线且正在准备环境时写明已准备多久（按控制面时间，没拿到控制面时间时不写时长）。"""
    if agent["status"] != "online":
        return "离线"
    since = agent["preparing_since"]
    if since is None:
        return "在线"
    if now is None:
        return "在线（准备环境中）"
    seconds = (now - parse_time(since)).total_seconds()
    return f"在线（准备环境中，已 {_elapsed(seconds)}）"


def _list(session: Session, args: argparse.Namespace) -> None:
    listing = session.client.get("/agents")
    control_plane = listing["control_plane_version"]
    agents = listing["agents"]
    now = session.client.control_plane_time
    shown, hidden = apply_limit(agents, args.limit)
    rows = [
        {
            "name": a["name"],
            "status": a["status"],
            "agent_version": a["info"]["agent_version"],
            "version_matches": not a["version_mismatch"],
            "running_tasks": len(a["running_tasks"]),
            "slots": a["info"]["slots"],
            "preparing_since": a["preparing_since"],
            "address": _address(a),
            "dev_packages": [d["name"] for d in a["dev_packages"]],
            "last_seen_at": a["last_seen_at"],
        }
        for a in shown
    ]
    if rows:
        text = format_table(
            ["Agent", "状态", "版本", "与控制面一致", "运行中任务", "对外地址", "开发包"],
            [
                [
                    r["name"],
                    _status(r, now),
                    r["agent_version"],
                    "是" if r["version_matches"] else f"否（控制面 {control_plane}）",
                    f"{r['running_tasks']}/{r['slots']}",
                    r["address"] or "-",
                    ", ".join(r["dev_packages"]) or "-",
                ]
                for r in rows
            ],
        )
    else:
        text = "还没有 sfly Agent 连接过控制面"
    session.out.emit(rows, text, note=more_note(hidden, len(agents), "台 Agent"))
