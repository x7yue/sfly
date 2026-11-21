"""运行状态（`sfly.RunState`）的形状检查，几个测试共用：

- `hint_vs_schema`：TypedDict 和导出的 JSON Schema（`run-state.schema.json`）是不是同一个形状，
  键、可空性、枚举取值、数组、嵌套都对得上；
- `value_problems`：一个值是不是正好符合 TypedDict（键齐全、没有多余的键、每个值的类型对）。
"""

from __future__ import annotations

import types
import typing
from typing import Any, Literal, get_args, get_origin, get_type_hints

_NONE = type(None)


def _unwrap_hint(hint: Any) -> tuple[bool, Any]:
    """（是不是 `X | None`，X）。"""
    if get_origin(hint) in (typing.Union, types.UnionType):
        members = [a for a in get_args(hint) if a is not _NONE]
        if len(members) == 1 and len(get_args(hint)) == 2:
            return True, members[0]
    return False, hint


def _unwrap_schema(schema: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    """（能不能是 null，去掉 null 之后的 schema）。"""
    members = schema.get("anyOf")
    if isinstance(members, list):
        rest = [m for m in members if m != {"type": "null"}]
        if len(rest) == 1 and len(members) == 2:
            return True, rest[0]
    kinds = schema.get("type")
    if isinstance(kinds, list) and "null" in kinds:
        rest_kinds = [k for k in kinds if k != "null"]
        return True, {**schema, "type": rest_kinds[0] if len(rest_kinds) == 1 else rest_kinds}
    return False, schema


_SCALARS: dict[Any, str] = {str: "string", int: "integer", bool: "boolean"}


def hint_vs_schema(hint: Any, schema: dict[str, Any], path: str = "$") -> list[str]:
    """TypedDict（`hint`）和 JSON Schema 不一致的地方；空表示是同一个形状。"""
    hint_nullable, hint = _unwrap_hint(hint)
    schema_nullable, schema = _unwrap_schema(schema)
    problems: list[str] = []
    if hint_nullable != schema_nullable:
        problems.append(
            f"{path}：类型{'可' if hint_nullable else '不可'}为 null，"
            f"schema {'可' if schema_nullable else '不可'}"
        )
    if get_origin(hint) is Literal:
        if schema.get("enum") != list(get_args(hint)):
            problems.append(f"{path}：取值 {list(get_args(hint))}，schema 是 {schema.get('enum')}")
    elif hint in _SCALARS:
        if schema.get("type") != _SCALARS[hint] or "enum" in schema:
            problems.append(f"{path}：类型 {hint.__name__}，schema 是 {schema}")
    elif get_origin(hint) is list:
        if schema.get("type") != "array":
            problems.append(f"{path}：是列表，schema 是 {schema.get('type')}")
        else:
            problems += hint_vs_schema(get_args(hint)[0], schema["items"], f"{path}[]")
    elif typing.is_typeddict(hint):
        hints = get_type_hints(hint)
        properties: dict[str, Any] = schema.get("properties", {})
        if schema.get("type") != "object":
            problems.append(f"{path}：是对象，schema 是 {schema.get('type')}")
        if set(hints) != set(properties):
            problems.append(
                f"{path}：键不一致，多出 {sorted(set(hints) - set(properties))}，"
                f"缺少 {sorted(set(properties) - set(hints))}"
            )
        if set(schema.get("required", [])) != set(properties):
            problems.append(f"{path}：schema 里有不是必填的字段")
        if set(hint.__required_keys__) != set(hints):
            problems.append(f"{path}：TypedDict 里有不是必填的键")
        for key in set(hints) & set(properties):
            problems += hint_vs_schema(hints[key], properties[key], f"{path}.{key}")
    else:
        problems.append(f"{path}：不认识的类型 {hint!r}")
    return problems


def value_problems(value: Any, hint: Any, path: str = "$") -> list[str]:
    """`value` 不符合 TypedDict（`hint`）的地方；空表示正好符合：键齐全、没有多余的键。"""
    nullable, hint = _unwrap_hint(hint)
    if value is None:
        return [] if nullable else [f"{path}：不能是 null"]
    if get_origin(hint) is Literal:
        return [] if value in get_args(hint) else [f"{path}：{value!r} 不在 {get_args(hint)} 里"]
    if hint is bool:
        return [] if isinstance(value, bool) else [f"{path}：应为 bool，实际是 {value!r}"]
    if hint is int:
        ok = isinstance(value, int) and not isinstance(value, bool)
        return [] if ok else [f"{path}：应为 int，实际是 {value!r}"]
    if hint is str:
        return [] if isinstance(value, str) else [f"{path}：应为 str，实际是 {value!r}"]
    if get_origin(hint) is list:
        if not isinstance(value, list):
            return [f"{path}：应为列表，实际是 {value!r}"]
        problems: list[str] = []
        for i, item in enumerate(value):
            problems += value_problems(item, get_args(hint)[0], f"{path}[{i}]")
        return problems
    if typing.is_typeddict(hint):
        if not isinstance(value, dict):
            return [f"{path}：应为对象，实际是 {value!r}"]
        hints = get_type_hints(hint)
        problems = []
        if set(value) != set(hints):
            problems.append(
                f"{path}：键不一致，多出 {sorted(set(value) - set(hints))}，"
                f"缺少 {sorted(set(hints) - set(value))}"
            )
        for key in set(value) & set(hints):
            problems += value_problems(value[key], hints[key], f"{path}.{key}")
        return problems
    return [f"{path}：不认识的类型 {hint!r}"]
