"""已移除的场景文档顶层字段（ADR 0028）：例如便签 `sticky_notes`。历史版本里还留着它们，
但保存时控制面只收空数组（接受并丢掉），里面有内容的不收，命令行的本地检查在发请求之前就写明有几条、怎么办。

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


def removed_fields_with_content(document: Any) -> list[tuple[str, int]]:
    """文档顶层已移除的字段里有内容的（字段名、里面有几条），按登记的顺序。

    空数组、`null` 和没有的不算：空的 `sticky_notes` 保存时控制面接受并丢掉，不是问题；
    不是数组的值算 1 条。`document` 不是对象时为空。
    和控制面的 `removedFieldsWithContent` 是同一个规则。"""
    if not isinstance(document, dict):
        return []
    found: list[tuple[str, int]] = []
    for field in REMOVED_DOCUMENT_FIELDS:
        value = document.get(field)
        if value is None:
            continue
        count = len(value) if isinstance(value, list) else 1
        if count > 0:
            found.append((field, count))
    return found


def removed_fields_message(contents: list[tuple[str, int]]) -> str:
    """保存时遇到已移除字段里有内容的说明：哪些字段、里面有几条、怎么办。
    和控制面拒绝保存的错误信息是同一句。"""
    named = "、".join(
        f"{field}（{REMOVED_DOCUMENT_FIELDS[field][0]}）有 {count} 条内容"
        for field, count in contents
    )
    advice = "；".join(
        f"{REMOVED_DOCUMENT_FIELDS[field][0]}：{REMOVED_DOCUMENT_FIELDS[field][1]}"
        for field, _ in contents
    )
    return (
        f"场景文档里的 {named}，已不再支持，不能保存：先把要留的内容挪走，再把这一项删掉。"
        f"替换办法：{advice}"
    )
