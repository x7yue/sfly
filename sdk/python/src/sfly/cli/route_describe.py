"""`sfly api --describe`：把路由清单里的一个接口写成人和 AI 编程助手读得懂的文本。

说明、只读还是有副作用、作用在哪类资源上、请求的各个部分，以及响应（SSE 是每个事件）的字段：
字段按 JSON Schema 列成缩进的大纲（`名称*: 类型`，`*` 是必填），只列到 `MAX_DEPTH` 层，
更深的地方只写类型；完整的 JSON Schema 用 `--json`。
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from typing import Any

from sfly.cli.routes import EFFECT_LABELS, KIND_LABELS, Route

# 字段大纲列到第几层；更深的只写类型。
MAX_DEPTH = 3

_INDENT = "  "
_TARGET_PARTS = {"params": "路径参数", "query": "查询参数", "body": "请求体字段"}
_TARGET_TEXT = {
    "collection": "列表或新建，没有具体的那一个",
    "upload": "具体的那一个在上传的内容里",
    "global": "平台自身，没有具体的那一个",
}
_PATH_PARAM = re.compile(r":([A-Za-z_][A-Za-z0-9_]*)|\*$")


def target_text(resource: Mapping[str, Any]) -> str:
    """`resource.target` 的说明：用请求里的哪个字段定位，或者为什么没有具体的那一个。"""
    target = resource["target"]
    if isinstance(target, dict):
        ((part, field),) = target.items()
        return f"用{_TARGET_PARTS.get(part, part)} {field} 定位到具体的那一个"
    return _TARGET_TEXT.get(target, str(target))


def resource_text(route: Route) -> str:
    return f"{route.resource_label}，{target_text(route.resource)}"


def effect_text(effect: str) -> str:
    return EFFECT_LABELS.get(effect, effect)


def call_example(route: Route) -> str:
    """调用这个接口的命令：路径里的参数写成 `<名称>`，必填的查询参数和请求体也列出来。"""
    path = _PATH_PARAM.sub(lambda m: f"<{m.group(1) or '剩余路径'}>", route.path)
    parts = ["sfly", "api", route.method, path]
    parts.extend(f"--query {name}=<值>" for name in _required(route.query))
    if _required(route.body):
        parts.append("--body '{…}'")
    return " ".join(parts)


class _Outline:
    """把 JSON Schema 列成缩进的大纲；`truncated` 记下有没有因为太深而省略。"""

    def __init__(self, root: Mapping[str, Any]) -> None:
        self.root = root
        self.truncated = False

    # ---- 解析

    def resolve(self, schema: Any) -> tuple[Mapping[str, Any], str | None]:
        """跟着本地的 `$ref`（`#`、`#/$defs/名称`）走到真正的 schema；返回（schema，引用）。"""
        if not isinstance(schema, Mapping):
            return {}, None
        ref = schema.get("$ref")
        if not isinstance(ref, str) or not ref.startswith("#"):
            return schema, None
        node: Any = self.root
        for part in ref[1:].split("/"):
            if part:
                node = node[part.replace("~1", "/").replace("~0", "~")]
        return node, ref

    def options(self, schema: Mapping[str, Any]) -> list[Mapping[str, Any]]:
        found = schema.get("anyOf") or schema.get("oneOf") or []
        return [self.resolve(option)[0] for option in found]

    # ---- 类型

    def label(self, schema: Any, seen: tuple[str, ...] = ()) -> str:
        schema, ref = self.resolve(schema)
        if ref is not None and ref in seen:
            return "（递归，同上）"
        seen = (*seen, ref) if ref else seen
        if "const" in schema:
            return json.dumps(schema["const"], ensure_ascii=False)
        if "enum" in schema:
            return " | ".join(json.dumps(item, ensure_ascii=False) for item in schema["enum"])
        options = self.options(schema)
        if options:
            labels = list(dict.fromkeys(self.label(option, seen) for option in options))
            return " | ".join(labels)
        kind = schema.get("type")
        if isinstance(kind, list):
            return " | ".join(str(item) for item in kind)
        if kind == "array":
            return f"{self.label(schema.get('items', {}), seen)}[]"
        if kind == "object":
            return self._object_label(schema, seen)
        if isinstance(kind, str):
            fmt = schema.get("format")
            return f"{kind}（{fmt}）" if fmt else kind
        return "any"

    def _object_label(self, schema: Mapping[str, Any], seen: tuple[str, ...]) -> str:
        extra = schema.get("additionalProperties")
        if not schema.get("properties") and isinstance(extra, Mapping) and extra:
            return f"object（名称 → {self.label(extra, seen)}）"
        return "object"

    # ---- 大纲

    def lines(self, schema: Any, depth: int = 1, seen: tuple[str, ...] = ()) -> list[str]:
        """`schema` 里一层字段的大纲（对象的字段；数组、可空对象、几选一的对象列元素的字段）。"""
        schema, ref = self.resolve(schema)
        if ref is not None and ref in seen:
            return []
        seen = (*seen, ref) if ref else seen
        indent = _INDENT * depth
        properties = schema.get("properties")
        if isinstance(properties, Mapping) and properties:
            return self._fields(schema, properties, depth, seen)
        if schema.get("type") == "array":
            return self.lines(schema.get("items", {}), depth, seen)
        objects = [o for o in self.options(schema) if self._has_fields(o)]
        if len(objects) == 1:
            return self.lines(objects[0], depth, seen)
        lines: list[str] = []
        if len(objects) > 1:
            for number, option in enumerate(objects, 1):
                lines.append(f"{indent}选项 {number}{self._discriminator(option)}：")
                lines.extend(self.lines(option, depth + 1, seen))
        return lines

    def _has_fields(self, schema: Mapping[str, Any]) -> bool:
        schema, _ = self.resolve(schema)
        if isinstance(schema.get("properties"), Mapping) and schema["properties"]:
            return True
        if schema.get("type") == "array":
            return self._has_fields(schema.get("items", {}))
        return any(self._has_fields(option) for option in self.options(schema))

    def _discriminator(self, option: Mapping[str, Any]) -> str:
        """几选一的对象里，用一个取值固定的字段（例如 `kind`）标出这是哪一个。"""
        properties = self.resolve(option)[0].get("properties", {})
        for name, prop in properties.items():
            resolved, _ = self.resolve(prop)
            if "const" in resolved:
                return f"（{name} = {json.dumps(resolved['const'], ensure_ascii=False)}）"
        return ""

    def _fields(
        self,
        schema: Mapping[str, Any],
        properties: Mapping[str, Any],
        depth: int,
        seen: tuple[str, ...],
    ) -> list[str]:
        indent = _INDENT * depth
        required = set(schema.get("required", ()))
        lines: list[str] = []
        for name, prop in properties.items():
            note = self.resolve(prop)[0].get("description") or prop.get("description")
            text = f"{indent}{name}{'*' if name in required else ''}: {self.label(prop, seen)}"
            lines.append(f"{text} — {note}" if note else text)
            children = self.lines(prop, depth + 1, seen)
            if depth >= MAX_DEPTH:
                self.truncated = self.truncated or bool(children)
            else:
                lines.extend(children)
        return lines


def _required(schema: Mapping[str, Any] | None) -> list[str]:
    return list(schema.get("required", ())) if schema else []


def _section(title: str, schema: Mapping[str, Any] | None) -> tuple[list[str], bool]:
    """一个请求部分或响应的大纲：（行，有没有因为太深省略）。"""
    if schema is None:
        return [], False
    outline = _Outline(schema)
    body = outline.lines(schema)
    if not body:
        body = [f"{_INDENT}{outline.label(schema)}"]
    return [title, *body], outline.truncated


def describe_route(route: Route) -> str:
    """一个接口的完整说明（`sfly api --describe` 的文本）。"""
    kind = KIND_LABELS.get(route.kind, route.kind)
    lines = [
        f"{route.method} {route.path}",
        f"说明：{route.summary}",
        f"种类：{kind}",
        f"效果：{effect_text(route.effect)}",
        f"资源：{resource_text(route)}",
    ]
    if route.kind == "upload":
        lines.append("请求体：原始字节（application/octet-stream），sfly api 不能直接调用")
    else:
        lines.append(f"调用：{call_example(route)}")
    truncated = False
    sections = [
        _section("路径参数（* 必填）", route.params),
        _section("查询参数（* 必填）", route.query),
        _section("请求体（JSON，* 必填）", route.body),
    ]
    if route.kind in ("endpoint", "upload"):
        if route.response is not None:
            sections.append(_section("响应（JSON）", route.response))
        else:
            lines.append("响应：没有响应体（204）")
    elif route.kind == "download":
        lines.append(f"响应：文件内容（content-type：{route.content_type}）")
    elif route.kind == "stream":
        lines.append(
            "事件流（SSE）：每条消息有事件名，data 是 JSON；每条流另外都带控制面时间的 time 事件"
        )
    sections.extend(
        _section(f"事件 {name}", schema) for name, schema in (route.events or {}).items()
    )
    for body, cut in sections:
        if body:
            lines.extend(["", *body])
            truncated = truncated or cut
    lines.extend(_note_lines(route.notes))
    if truncated:
        lines.append("")
        lines.append(
            f"字段只列到第 {MAX_DEPTH} 层，更深的地方只写了类型；完整的 JSON Schema 用 --json。"
        )
    return "\n".join(lines)


def _note_lines(notes: Sequence[Mapping[str, str]]) -> list[str]:
    if not notes:
        return []
    lines = ["", "JSON Schema 表达不了、只由控制面校验的约束："]
    for note in notes:
        where = note["part"] + (f" {note['path']}" if note["path"] else "")
        lines.append(f"{_INDENT}{where}：{note['reason']}")
    return lines
