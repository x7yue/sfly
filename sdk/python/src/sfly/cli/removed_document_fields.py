"""已移除的场景文档顶层字段（ADR 0028）：例如便签 `sticky_notes`。历史版本里还留着它们，
但保存时控制面不再收，命令行的本地检查在发请求之前就写明怎么办。

清单读 `sfly.schemas/removed-document-fields.json`，由控制面的
`packages/schema/src/removed-document-fields.ts` 导出（`pnpm gen`，`pnpm gen:check` 守着），
这里没有第二份；说明的句式和控制面的 `removedFieldsMessage` 相同，
`tests/test_cli_run_view.py` 里有一条测试核对。
"""

from __future__ import annotations

import json
from importlib import resources
from typing import Any


def _load() -> dict[str, tuple[str, str]]:
    text = (
        resources.files("sfly.schemas").joinpath("removed-document-fields.json").read_text("utf-8")
    )
    raw: dict[str, dict[str, Any]] = json.loads(text)
    return {field: (entry["label"], entry["replacement"]) for field, entry in raw.items()}


# 字段名 → (原来的名称, 替换办法)。
REMOVED_DOCUMENT_FIELDS: dict[str, tuple[str, str]] = _load()


def removed_fields_in(document: Any) -> list[str]:
    """文档顶层带着的已移除字段，按登记的顺序；`document` 不是对象时为空。"""
    if not isinstance(document, dict):
        return []
    return [field for field in REMOVED_DOCUMENT_FIELDS if field in document]


def removed_fields_message(fields: list[str]) -> str:
    """保存时遇到已移除字段的说明：哪些字段、怎么办。和控制面拒绝保存的错误信息是同一句。"""
    named = "、".join(f"{f}（{REMOVED_DOCUMENT_FIELDS[f][0]}）" for f in fields)
    advice = "；".join(
        f"{REMOVED_DOCUMENT_FIELDS[f][0]}：{REMOVED_DOCUMENT_FIELDS[f][1]}" for f in fields
    )
    return f"场景文档里的 {named}已不再支持，先把这一项删掉再保存。替换办法：{advice}"
