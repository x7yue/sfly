"""`sfly scenario`：查看平台上的场景（`list`、`show`），编辑场景在 `scenario_edit.py`。

场景的 id、名称和版本的取值与错误约定见 `scenario_lookup.py`、`session.py`、`output.py`。
"""

from __future__ import annotations

import argparse
from typing import Any

from sfly.cli import scenario_edit, scenario_versions
from sfly.cli.client import segment
from sfly.cli.output import add_limit_option, apply_limit, dump_json, format_table, more_note
from sfly.cli.presets import preset_view, render_presets
from sfly.cli.run_view import node_type_label, subflow_label
from sfly.cli.scenario_lookup import find_scenario
from sfly.cli.session import Session, command, common_options


def register(sub: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    parser = sub.add_parser(
        "scenario",
        help="查看和编辑平台上的场景：列表、入口参数、链路上的节点、pull / push 保存新版本",
        description="查看和编辑控制面上的场景。场景用 id 或准确名称指定，"
        "名称对应多个场景时报错并列出候选。默认输出精简文本，--json 输出 JSON。"
        "退出码：成功 0，命令出错（参数不对、连不上控制面、场景不存在……）2。",
    )
    group = parser.add_subparsers(dest="scenario_command", required=True)

    p_list = group.add_parser(
        "list",
        parents=[common_options()],
        help="列出场景（名称、id、最新版本号、默认 sfly Agent）",
        description="列出没有归档的场景，按新建时间从新到旧。超过 --limit 时提示还有多少条。",
    )
    p_list.add_argument(
        "--search",
        metavar="文字",
        help="按名称、说明或引用的 sfly Agent 搜索（不区分大小写的子串）",
    )
    p_list.add_argument("--agent", help="只列出引用了这个 Agent 的场景（默认 Agent 或节点另选的）")
    add_limit_option(p_list)
    p_list.set_defaults(func=command(_list))

    p_show = group.add_parser(
        "show",
        parents=[common_options()],
        help="查看一个场景：入口参数、各链路上的节点、子流程、默认 Agent",
        description="查看场景最新版本的内容：入口参数、主链和各子流程上的节点"
        "（节点类型、锁定的节点包版本、sfly Agent）、默认 Agent，"
        "以及场景的运行预设（名称、说明、是否可用、预设参数和值，secret 打码）。",
    )
    p_show.add_argument("scenario", metavar="场景", help="场景 id 或准确名称")
    p_show.set_defaults(func=command(_show))

    scenario_edit.register(group)
    scenario_versions.register(group)


def _list(session: Session, args: argparse.Namespace) -> None:
    listing = session.client.get("/orchestrations", {"q": args.search, "agent": args.agent})
    summaries = listing["orchestrations"]
    shown, hidden = apply_limit(summaries, args.limit)
    rows = [
        {
            "id": s["id"],
            "name": s["name"],
            "description": s["description"],
            "head_version": s["head_version"],
            "default_agent": s["default_agent"],
            "updated_at": s["updated_at"],
        }
        for s in shown
    ]
    if rows:
        text = format_table(
            ["名称", "id", "最新版本", "默认 Agent"],
            [
                [
                    r["name"],
                    r["id"],
                    str(r["head_version"]) if r["head_version"] else "-",
                    r["default_agent"] or "-",
                ]
                for r in rows
            ],
        )
    else:
        filtered = args.search or args.agent
        text = "没有符合条件的场景" if filtered else "还没有场景"
    note = more_note(hidden, len(summaries), "个场景")
    session.out.emit(rows, text, note=note)


def _show(session: Session, args: argparse.Namespace) -> None:
    scenario = find_scenario(session.client, args.scenario, command="sfly scenario show")
    scenario_path = f"/orchestrations/{segment(scenario['id'])}"
    head = session.client.get(f"{scenario_path}/head")
    presets = session.client.get(f"{scenario_path}/presets")["presets"]
    view = describe(scenario, head, presets)
    session.out.emit(view, render(view))


def describe(
    scenario: dict[str, Any], head: dict[str, Any], presets: list[dict[str, Any]]
) -> dict[str, Any]:
    """`scenario show --json` 的内容：场景的基本信息、运行预设、入口参数、主链和各子流程上的节点。
    `head` 是 `GET /orchestrations/:id/head`（最新版本，还没有版本时是初始文档），
    `presets` 是 `GET /orchestrations/:id/presets` 的 `presets`。"""
    document = head["document"]
    nodes: dict[str, dict[str, Any]] = {n["id"]: n for n in document["nodes"]}
    default_agent = document.get("default_agent")
    locked = document.get("packages", {})

    next_on_chain: dict[str, str] = {}
    subflow_triggered_by: dict[str, str] = {}
    triggers: dict[str, str] = {}
    for edge in document.get("edges", []):
        if edge["from"] not in nodes or edge["to"] not in nodes:
            continue
        if edge["kind"] == "chain":
            next_on_chain.setdefault(edge["from"], edge["to"])
        else:
            triggers.setdefault(edge["from"], edge["to"])
            subflow_triggered_by.setdefault(edge["to"], edge["from"])

    def subflow_name(entry_id: str | None) -> str | None:
        entry = nodes.get(entry_id) if entry_id else None
        if entry is None or entry["kind"] != "subflow_entry":
            return None
        name = entry["name"].strip() if entry.get("name") is not None else entry["id"]
        return subflow_label(name)

    def node_view(node: dict[str, Any]) -> dict[str, Any]:
        view: dict[str, Any] = {
            "id": node["id"],
            "kind": node["kind"],
            "always": node.get("always", False),
        }
        if node["kind"] == "package":
            view["package"] = node["package"]
            view["node"] = node["node"]
            view["package_version"] = locked.get(node["package"])
            view["agent"] = node.get("agent") or default_agent
        elif node["kind"] == "async":
            view["subflow"] = subflow_name(triggers.get(node["id"]))
        elif node["kind"] == "stop_subflow":
            view["subflow"] = subflow_name(node.get("subflow"))
        return view

    on_a_chain: set[str] = set()

    def chain(entry: dict[str, Any] | None) -> list[dict[str, Any]]:
        listed = []
        current = entry["id"] if entry else None
        while current is not None and current not in on_a_chain:
            on_a_chain.add(current)
            if nodes[current] is not entry:
                listed.append(node_view(nodes[current]))
            current = next_on_chain.get(current)
        return listed

    def params(entry: dict[str, Any] | None) -> list[dict[str, Any]]:
        result = []
        for p in entry["params"] if entry else []:
            item = {
                "name": p["name"],
                "type": p["type"],
                "required": p["required"],
                "secret": p["secret"],
            }
            # secret 参数的默认值不输出。
            if "default" in p and not p["secret"]:
                item["default"] = p["default"]
            result.append(item)
        return result

    main = next((n for n in document["nodes"] if n["kind"] == "entry"), None)
    main_nodes = chain(main)
    subflows = [
        {
            "name": subflow_name(n["id"]),
            "entry": n["id"],
            "triggered_by": subflow_triggered_by.get(n["id"]),
            "params": params(n),
            "nodes": chain(n),
        }
        for n in document["nodes"]
        if n["kind"] == "subflow_entry"
    ]
    unlinked = [
        node_view(n)
        for n in document["nodes"]
        if n["id"] not in on_a_chain and n["kind"] not in ("entry", "subflow_entry")
    ]
    saved = head["number"] > 0
    return {
        "id": scenario["id"],
        "name": scenario["name"],
        "description": scenario["description"],
        "archived": scenario["archived_at"] is not None,
        "head_version": scenario["head_version"],
        "version": {
            "number": head["number"],
            "author": head["author"],
            "created_at": head["created_at"],
        }
        if saved
        else None,
        "default_agent": default_agent,
        "presets": [preset_view(p) for p in presets],
        "params": params(main),
        "nodes": main_nodes,
        "subflows": subflows,
        "unlinked": unlinked,
    }


def render(view: dict[str, Any]) -> str:
    """`describe` 的文本形式。"""
    title = f"场景 {view['name']}（{view['id']}）"
    lines = [title + ("，已归档" if view["archived"] else "")]
    if view["description"]:
        lines.append(f"说明：{view['description']}")
    version = view["version"]
    lines.append(
        f"最新版本：{version['number']}，{version['author']} 保存于 {version['created_at']}"
        if version
        else "最新版本：还没有保存过版本（下面是初始文档）"
    )
    lines.append(f"默认 Agent：{view['default_agent'] or '未设置'}")
    if view["presets"]:
        lines.extend(["", *render_presets(view["presets"], view["params"])])
    lines.append("")
    lines.extend(_render_chain("主链", view["params"], view["nodes"]))
    for subflow in view["subflows"]:
        trigger = (
            f"，由 {subflow['triggered_by']} 触发" if subflow["triggered_by"] else "，没有被触发"
        )
        lines.append("")
        lines.extend(
            _render_chain(
                f"子流程 {subflow['name']}（入口 {subflow['entry']}{trigger}）",
                subflow["params"],
                subflow["nodes"],
            )
        )
    if view["unlinked"]:
        lines.extend(["", "没有连进任何链的节点："])
        lines.extend(_indent(_nodes_table(view["unlinked"])))
    return "\n".join(lines)


def _render_chain(
    title: str, params: list[dict[str, Any]], nodes: list[dict[str, Any]]
) -> list[str]:
    lines = [title]
    if params:
        lines.append("  入口参数：")
        lines.extend(_indent(_params_table(params), 2))
    else:
        lines.append("  入口参数：无")
    if nodes:
        lines.append("  节点：")
        lines.extend(_indent(_nodes_table(nodes), 2))
    else:
        lines.append("  节点：无")
    return lines


def _indent(text: str, levels: int = 1) -> list[str]:
    return ["  " * levels + line for line in text.splitlines()]


def _params_table(params: list[dict[str, Any]]) -> str:
    def notes(p: dict[str, Any]) -> str:
        found = []
        if p["required"]:
            found.append("必填")
        if "default" in p:
            found.append(f"默认 {dump_json(p['default'])}")
        if p["secret"]:
            found.append("secret")
        return "，".join(found)

    return format_table(
        ["参数", "类型", "说明"], [[p["name"], p["type"], notes(p)] for p in params]
    )


def _node_type(node: dict[str, Any]) -> str:
    label = node_type_label(node)
    subflow = node.get("subflow")
    if not subflow:
        return label
    return f"{label} → 子流程 {subflow}" if node["kind"] == "async" else f"{label} {subflow}"


def _nodes_table(nodes: list[dict[str, Any]]) -> str:
    rows = []
    for n in nodes:
        is_package = n["kind"] == "package"
        rows.append(
            [
                n["id"],
                _node_type(n),
                (n["package_version"] or "-") if is_package else "-",
                (n["agent"] or "-") if is_package else "-",
            ]
        )
    return format_table(["节点", "节点类型", "包版本", "Agent"], rows)
