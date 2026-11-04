"""由 packages/schema（zod，唯一来源）导出的 JSON Schema。

本目录下的 *.schema.json 由 `pnpm gen:schema` 生成，不要手改。
"""

from __future__ import annotations

import json
from importlib import resources
from typing import Any, Literal

SchemaName = Literal["orchestration-document", "package-metadata"]


def load_schema(name: SchemaName) -> dict[str, Any]:
    """读取导出的 JSON Schema（draft 2020-12）。"""
    text = resources.files(__name__).joinpath(f"{name}.schema.json").read_text(encoding="utf-8")
    schema: dict[str, Any] = json.loads(text)
    return schema
