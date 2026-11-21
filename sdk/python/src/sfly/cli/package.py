"""`sfly package list` / `sfly package show`：节点包的版本，以及节点类型的输入和输出。"""

from __future__ import annotations

import argparse
from typing import Any

from sfly.cli.client import ApiError, segment
from sfly.cli.errors import CliError
from sfly.cli.output import add_limit_option, apply_limit, dump_json, format_table, more_note
from sfly.cli.session import Session, command, common_options

# 列表里每个包最多写出几个版本，其余折叠成「……共 N 个」。
_VERSIONS_SHOWN = 5

_EXTENDED_TYPES = {"agent": "Agent 名称", "feishu_bot": "飞书机器人"}

# sfly dev 加载的开发版本的版本号（Agent 上登记为 包名@dev）。
DEV_VERSION = "dev"


def register(sub: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    parser = sub.add_parser(
        "package",
        help="查看平台上的节点包：版本、节点类型的输入和输出",
        description="查看控制面上已发布的节点包。默认输出精简文本，--json 输出 JSON。"
        "退出码：成功 0，命令出错（包或版本不存在、连不上控制面……）2。",
    )
    group = parser.add_subparsers(dest="package_command", required=True)

    p_list = group.add_parser(
        "list",
        parents=[common_options()],
        help="列出节点包和它们的版本",
        description="列出已发布的节点包，按包名排序；每个包的版本从新到旧。"
        "超过 --limit 时提示还有多少个包。",
    )
    add_limit_option(p_list)
    p_list.set_defaults(func=command(_list))

    p_show = group.add_parser(
        "show",
        parents=[common_options()],
        help="查看一个节点包版本：每个节点类型的标题、输入（类型、默认值、是否必填）和输出",
        description="查看节点包的一个版本。不写版本时看最新版本；写了不存在的版本时报错并列出已有的版本。"
        "包名@dev 看用 sfly dev 加载在 Agent 上的开发版本（Agent 上报给控制面的节点定义）；"
        "同一个开发包加载在不止一台 Agent 上时用 --agent 指定看哪一台的。",
    )
    p_show.add_argument(
        "package",
        metavar="包[@版本]",
        help="包名，可以加 @版本，例如 demo@1.2.0；开发版本写 demo@dev",
    )
    p_show.add_argument(
        "--agent",
        metavar="AGENT",
        help="只用于 @dev：看这台 Agent 上加载的开发版本",
    )
    p_show.set_defaults(func=command(_show))


def _list(session: Session, args: argparse.Namespace) -> None:
    packages = session.client.get("/packages")["packages"]
    shown, hidden = apply_limit(packages, args.limit)
    rows = [
        {
            "name": p["name"],
            "latest_version": p["versions"][0]["version"] if p["versions"] else None,
            "versions": [
                {
                    "version": v["version"],
                    "published_at": v["published_at"],
                    "nodes": [n["name"] for n in v["nodes"]],
                    "locked_orchestrations": v["locked_orchestrations"],
                }
                for v in p["versions"]
            ],
        }
        for p in shown
    ]
    if rows:
        text = format_table(
            ["节点包", "版本（新到旧）", "最新版本的节点类型"],
            [
                [
                    r["name"],
                    _versions_text([v["version"] for v in r["versions"]]),
                    ", ".join(r["versions"][0]["nodes"]) if r["versions"] else "-",
                ]
                for r in rows
            ],
        )
    else:
        text = "还没有发布过节点包"
    session.out.emit(rows, text, note=more_note(hidden, len(packages), "个节点包"))


def _versions_text(versions: list[str]) -> str:
    shown = ", ".join(versions[:_VERSIONS_SHOWN])
    extra = len(versions) - _VERSIONS_SHOWN
    return f"{shown} ……共 {len(versions)} 个" if extra > 0 else shown


def _show(session: Session, args: argparse.Namespace) -> None:
    name, _, wanted = args.package.partition("@")
    if not name or ("@" in args.package and not wanted):
        raise CliError(
            "invalid_package_ref",
            f"节点包要写成 包名 或 包名@版本，收到 {args.package!r}",
            next="sfly package list",
        )
    if wanted == DEV_VERSION:
        _show_dev(session, name, args.agent)
        return
    if args.agent is not None:
        raise CliError(
            "invalid_args",
            "--agent 只用于开发版本（包名@dev）：已发布的版本在控制面上，和 Agent 无关",
            next=f"sfly package show {args.package}",
        )
    client = session.client
    try:
        summary = client.get(f"/packages/{segment(name)}")
    except ApiError as error:
        if error.status != 404:
            raise
        raise CliError(
            "package_not_found", f"没有节点包 {name}", next="sfly package list"
        ) from None
    published = [v["version"] for v in summary["versions"]]
    if not published:
        raise CliError(
            "package_not_found", f"节点包 {name} 没有已发布的版本", next="sfly package list"
        )
    version = wanted or published[0]
    if version not in published:
        listed = "\n".join(f"  {v}" for v in published)
        raise CliError(
            "package_version_not_found",
            f"节点包 {name} 没有版本 {version}，已有的版本（新到旧）：\n{listed}",
            next=f"sfly package show {name}@{published[0]}",
        )
    detail = client.get(f"/packages/{segment(name)}/versions/{segment(version)}")
    view = describe(detail, latest=published[0])
    session.out.emit(view, render(view))


def _show_dev(session: Session, name: str, agent: str | None) -> None:
    """开发版本的节点定义：sfly dev 把扫描出的元信息交给 Agent，Agent 连上控制面时上报，
    控制面在 GET /agents 的 dev_packages 里给出。它不在已发布的节点包列表里。

    只算在线的 Agent：Agent 断线后 GET /agents 仍带着它上次上报的 dev_packages，
    运行准入不算它（apps/server/src/runs/dev-package-loaded.ts），这里和准入一致。"""
    loaders = [
        (a["name"], a["status"] == "online", d)
        for a in session.client.get("/agents")["agents"]
        for d in a["dev_packages"]
        if d["name"] == name
    ]
    loaded = [(n, d) for n, online, d in loaders if online]
    offline = [n for n, online, _ in loaders if not online]
    where = "、".join(n for n, _ in loaded)
    first = f"sfly package show {name}@dev --agent {loaded[0][0]}" if loaded else None
    load_hint = (
        "在节点包源码目录里运行 sfly dev，再用 sfly agent list 看各台 Agent 加载了哪些开发包"
    )
    if agent is not None and agent in offline:
        raise CliError(
            "agent_offline",
            f"Agent {agent} 离线：它上次上报的开发包定义可能已经过时，运行也不会派发给它"
            + (f"；在线且加载了 {name} 的 Agent：{where}" if loaded else ""),
            next=first or load_hint,
        )
    if not loaded:
        seen = f"（离线的 Agent {'、'.join(offline)} 上次加载过它）" if offline else ""
        raise CliError(
            "dev_package_not_loaded",
            f"节点包 {name} 的开发版本没有加载在任何在线的 Agent 上{seen}。"
            "开发版本由 sfly dev 加载到 Agent 上，不在已发布的节点包列表里",
            next=load_hint,
        )
    if agent is not None:
        loaded = [(n, d) for n, d in loaded if n == agent]
        if not loaded:
            raise CliError(
                "dev_package_not_loaded",
                f"Agent {agent} 上没有加载节点包 {name} 的开发版本；加载了它的 Agent：{where}",
                next=first,
            )
    elif len(loaded) > 1:
        raise CliError(
            "dev_package_ambiguous",
            f"节点包 {name} 的开发版本加载在 {len(loaded)} 台 Agent 上：{where}，"
            "用 --agent 指定看哪一台的",
            next=first,
        )
    agent_name, dev = loaded[0]
    try:
        nodes = _nodes(dev["metadata"])
    except (KeyError, TypeError, AttributeError):
        # 开发包的元信息没有经过发布时的校验，节点项可能缺字段或类型不对。
        raise CliError(
            "dev_package_metadata_invalid",
            f"Agent {agent_name} 上报的开发包 {name} 的元信息读不出节点定义",
            next="在节点包源码目录里重新运行 sfly dev",
        ) from None
    view = {
        "name": name,
        "version": DEV_VERSION,
        "agent": agent_name,
        "source": dev["source"],
        "nodes": nodes,
    }
    heading = (
        f"节点包 {name}@{DEV_VERSION}（开发版本，用 sfly dev 加载在 Agent {agent_name} 上，"
        f"源码目录 {dev['source']}）"
    )
    session.out.emit(view, render_nodes(heading, view["nodes"]))


def _nodes(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "name": n["name"],
            "title": n["title"],
            "inputs": _fields(n["inputs"], with_required=True),
            "outputs": _fields(n["outputs"], with_required=False),
        }
        for n in metadata["nodes"]
    ]


def describe(detail: dict[str, Any], *, latest: str) -> dict[str, Any]:
    """`package show --json` 的内容：包版本的基本信息和各节点类型的输入、输出。"""
    return {
        "name": detail["name"],
        "version": detail["version"],
        "latest": detail["version"] == latest,
        "published_at": detail["published_at"],
        "nodes": _nodes(detail["metadata"]),
    }


def _fields(schema: dict[str, Any], *, with_required: bool) -> list[dict[str, Any]]:
    properties: dict[str, dict[str, Any]] = schema["properties"]
    required = set(schema.get("required", []))
    order = [k for k in schema.get("order", []) if k in properties]
    order += [k for k in properties if k not in order]
    fields = []
    for key in order:
        prop = properties[key]
        field: dict[str, Any] = {"name": key, "type": type_label(prop)}
        if with_required:
            field["required"] = key in required
        if "default" in prop:
            field["default"] = prop["default"]
        if isinstance(prop.get("description"), str):
            field["description"] = prop["description"]
        fields.append(field)
    return fields


def type_label(schema: dict[str, Any]) -> str:
    """JSON Schema 片段的类型，写成人读得懂的短文本：`string`、`array<string>`、`string | null`……
    没有声明类型的是 `any`。"""
    extended = schema.get("x-sfly-type")
    if extended in _EXTENDED_TYPES:
        return _EXTENDED_TYPES[extended]
    if "enum" in schema:
        return " | ".join(dump_json(v) for v in schema["enum"])
    if "anyOf" in schema:
        members = list(dict.fromkeys(type_label(m) for m in schema["anyOf"]))
        return " | ".join(members)
    declared = schema.get("type")
    if isinstance(declared, list):
        return " | ".join(str(t) for t in declared)
    if declared == "array" and isinstance(schema.get("items"), dict):
        return f"array<{type_label(schema['items'])}>"
    if isinstance(declared, str):
        return declared
    return "any"


def render(view: dict[str, Any]) -> str:
    """`describe` 的文本形式。"""
    latest = "（最新版本）" if view["latest"] else ""
    heading = f"节点包 {view['name']}@{view['version']}{latest}，发布于 {view['published_at']}"
    return render_nodes(heading, view["nodes"])


def render_nodes(heading: str, nodes: list[dict[str, Any]]) -> str:
    lines = [heading]
    for node in nodes:
        lines.extend(["", f"节点类型 {node['name']}  {node['title']}"])
        lines.append("  输入：" if node["inputs"] else "  输入：无")
        if node["inputs"]:
            lines.extend(_indent(_inputs_table(node["inputs"])))
        lines.append("  输出：" if node["outputs"] else "  输出：无")
        if node["outputs"]:
            lines.extend(_indent(_outputs_table(node["outputs"])))
    return "\n".join(lines)


def _indent(text: str) -> list[str]:
    return ["    " + line for line in text.splitlines()]


def _inputs_table(fields: list[dict[str, Any]]) -> str:
    def notes(f: dict[str, Any]) -> str:
        found = []
        if f["required"]:
            found.append("必填")
        if "default" in f:
            found.append(f"默认 {dump_json(f['default'])}")
        if "description" in f:
            found.append(f["description"].replace("\n", " "))
        return "，".join(found)

    return format_table(
        ["参数", "类型", "说明"], [[f["name"], f["type"], notes(f)] for f in fields]
    )


def _outputs_table(fields: list[dict[str, Any]]) -> str:
    # 输出的 key 顺序不保证（控制面把元信息存进 JSONB）。
    described = any("description" in f for f in fields)
    headers = ["输出", "类型", *(["说明"] if described else [])]
    rows = [
        [
            f["name"],
            f["type"],
            *([f.get("description", "").replace("\n", " ")] if described else []),
        ]
        for f in fields
    ]
    return format_table(headers, rows)
