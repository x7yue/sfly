"""`sfly agent list`：各台 Agent 的在线状态、版本、运行中的任务数和对外地址。"""

from __future__ import annotations

import argparse
from typing import Any

from sfly.cli.output import add_limit_option, apply_limit, format_table, more_note
from sfly.cli.session import Session, command, common_options


def register(sub: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    parser = sub.add_parser(
        "agent",
        help="查看平台上的 Agent：在线状态、版本、运行中的任务数、对外地址",
        description="查看控制面上注册过的 Agent。默认输出精简文本，--json 输出 JSON。"
        "退出码：成功 0，命令出错 2。",
    )
    group = parser.add_subparsers(dest="agent_command", required=True)
    p_list = group.add_parser(
        "list",
        parents=[common_options()],
        help="列出 Agent：在线状态、版本、是否与控制面一致、运行中的任务数、对外地址",
        description="列出注册过的 Agent，按名称排序。版本与控制面不一致的 Agent 不会被派新任务，"
        "它手上的任务照常跑完。「开发包」是用 sfly dev 在这台 Agent 上加载的节点包（包名@dev）。"
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


def _list(session: Session, args: argparse.Namespace) -> None:
    listing = session.client.get("/agents")
    control_plane = listing["control_plane_version"]
    agents = listing["agents"]
    shown, hidden = apply_limit(agents, args.limit)
    rows = [
        {
            "name": a["name"],
            "status": a["status"],
            "agent_version": a["info"]["agent_version"],
            "version_matches": not a["version_mismatch"],
            "running_tasks": len(a["running_tasks"]),
            "slots": a["info"]["slots"],
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
                    "在线" if r["status"] == "online" else "离线",
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
        text = "还没有 Agent 连接过控制面"
    session.out.emit(rows, text, note=more_note(hidden, len(agents), "台 Agent"))
