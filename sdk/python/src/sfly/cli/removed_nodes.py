"""已移除的节点种类（ADR 0028）：历史版本和历史运行里还留着它们，命令行只读显示，
保存时说明怎么替换。

清单读 `sfly.schemas/removed-node-kinds.json`，由控制面的 `packages/schema/src/removed-nodes.ts`
导出（`pnpm gen`，`pnpm gen:check` 守着），这里没有第二份。
"""

from __future__ import annotations

import json
from importlib import resources
from typing import Any


def _load() -> dict[str, tuple[str, str]]:
    text = resources.files("sfly.schemas").joinpath("removed-node-kinds.json").read_text("utf-8")
    raw: dict[str, dict[str, Any]] = json.loads(text)
    return {kind: (entry["label"], entry["replacement"]) for kind, entry in raw.items()}


def _load_outputs() -> dict[str, list[str]]:
    text = resources.files("sfly.schemas").joinpath("removed-node-kinds.json").read_text("utf-8")
    raw: dict[str, dict[str, Any]] = json.loads(text)
    return {kind: list(entry.get("outputs", [])) for kind, entry in raw.items()}


# 种类名 → (原来的名称, 替换办法)。
REMOVED_NODE_KINDS: dict[str, tuple[str, str]] = _load()
# 种类名 → 原来的输出名（没有输出的是空列表）：别的节点引用过它们的，删掉节点之后也要改。
REMOVED_NODE_OUTPUTS: dict[str, list[str]] = _load_outputs()


def removed_outputs_advice(kind: str) -> str:
    """原来有输出的已移除种类：提醒引用过它的输出的节点也要改；没有输出时为空字符串。
    和控制面的 removedOutputsAdvice 是同一句。"""
    outputs = REMOVED_NODE_OUTPUTS.get(kind, [])
    return f"别的节点引用了它的输出（{'、'.join(outputs)}）的，也要一起改。" if outputs else ""


def removed_kind_label(kind: str) -> str:
    """已移除的种类在历史记录里的名称：「已移除的节点类型」加它当时的种类名。"""
    return f"已移除的节点类型 {kind}"
