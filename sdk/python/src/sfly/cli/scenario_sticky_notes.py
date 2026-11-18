"""`sfly scenario show` 里的便签：`--json` 的 `sticky_notes` 和文本最后的「便签」一段。

便签是画布上自由摆放的说明（ADR 0026），这里只列文字，不列位置和大小。
"""

from __future__ import annotations

from typing import Any


def sticky_note_views(document: dict[str, Any]) -> list[dict[str, Any]]:
    """`--json` 的 `sticky_notes`：文档里的便签。没有标题、没写颜色（黄色）的不带这两项。"""
    return [
        {
            "id": s["id"],
            **({"title": s["title"]} if s.get("title") else {}),
            "text": s["text"],
            **({"color": s["color"]} if s.get("color") else {}),
        }
        for s in document.get("sticky_notes", [])
    ]


def render_sticky_notes(notes: list[dict[str, Any]]) -> list[str]:
    """文本最后的「便签」一段（前面带一个空行）；没有便签时是空列表。

    每张便签：第一行是 `<标题>（<ID>）`，没有标题时只写 ID；
    下面是正文，每行缩进四格，空行照样是空行。
    """
    if not notes:
        return []
    lines = ["", "便签："]
    for note in notes:
        lines.append(f"  {note['title']}（{note['id']}）" if "title" in note else f"  {note['id']}")
        lines.extend(f"    {line}" if line else "" for line in note["text"].splitlines())
    return lines
