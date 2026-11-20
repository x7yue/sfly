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


# 种类名 → (原来的名称, 替换办法)。
REMOVED_NODE_KINDS: dict[str, tuple[str, str]] = _load()


def removed_kind_label(kind: str) -> str:
    """已移除的种类在历史记录里的名称：「已移除的节点类型」加它当时的种类名。"""
    return f"已移除的节点类型 {kind}"
