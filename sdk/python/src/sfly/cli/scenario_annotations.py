"""`sfly scenario show` 里的注释框：`--json` 的 `annotations` 和文本最后的「注释框」一段。

注释框只记成员（节点 ID 和子流程入口节点 ID），不存坐标（ADR 0023）。
"""

from __future__ import annotations

from typing import Any

from sfly.cli.output import display_width
from sfly.cli.run_view import name_with_id, subflow_label

_NOTE_LABEL = "备注："


def annotation_views(document: dict[str, Any]) -> list[dict[str, Any]]:
    """`--json` 的 `annotations`：文档里的注释框。

    没有备注的不带 `note`，没写颜色（灰色）的不带 `color`。
    """
    return [
        {
            "id": a["id"],
            "title": a["title"],
            **({"note": a["note"]} if a.get("note") else {}),
            **({"color": a["color"]} if a.get("color") else {}),
            "nodes": a.get("nodes", []),
            "subflows": a.get("subflows", []),
        }
        for a in document.get("annotations", [])
    ]


def render_annotations(annotations: list[dict[str, Any]], document: dict[str, Any]) -> list[str]:
    """文本最后的「注释框」一段（前面带一个空行）；没有注释框时是空列表。

    每个注释框三样：`<标题>（<ID>）`；成员（节点写「显示名称（节点 ID）」，子流程写名称，
    不存在的成员写原样的 ID）；备注，多行备注的后面几行缩进到第一行备注文字的位置。
    """
    if not annotations:
        return []
    node_names, subflow_names = _member_names(document)
    lines = ["", "注释框："]
    for annotation in annotations:
        lines.append(f"  {annotation['title']}（{annotation['id']}）")
        members = []
        if annotation["nodes"]:
            names = (node_names.get(i, i) for i in annotation["nodes"])
            members.append("节点：" + "、".join(names))
        if annotation["subflows"]:
            names = (subflow_names.get(i, i) for i in annotation["subflows"])
            members.append("子流程：" + "、".join(names))
        lines.append("    " + ("；".join(members) or "成员：无"))
        if "note" in annotation:
            first, *rest = annotation["note"].splitlines()
            align = " " * display_width(_NOTE_LABEL)
            lines.append(f"    {_NOTE_LABEL}{first}")
            lines.extend(f"    {align}{line}" if line else "" for line in rest)
    return lines


def _member_names(document: dict[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    """节点 ID → 节点的写法，子流程入口节点 ID → 子流程名称。"""
    node_names: dict[str, str] = {}
    subflow_names: dict[str, str] = {}
    for node in document["nodes"]:
        if node["kind"] == "subflow_entry":
            name = node["name"].strip() if node.get("name") is not None else node["id"]
            subflow_names[node["id"]] = subflow_label(name)
            # 子流程入口节点没有显示名称，写子流程名称，和控制台的 nodeNameWithId 一样。
            node_names[node["id"]] = name_with_id(node["id"], subflow_names[node["id"]])
        else:
            node_names[node["id"]] = name_with_id(node["id"], node.get("display_name"))
    return node_names, subflow_names
