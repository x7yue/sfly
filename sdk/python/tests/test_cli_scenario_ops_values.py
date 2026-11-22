"""`sfly scenario edit` 的值：按 JSON 解析，节点类型声明是字符串时按原样（#470 审查）。"""

from __future__ import annotations

from typing import Any

import pytest

from sfly.cli.scenario_ops import _accepts, _needs_types, _value

STRING: dict[str, Any] = {"type": "string"}
INTEGER: dict[str, Any] = {"type": "integer"}
OPTIONAL_STRING: dict[str, Any] = {"anyOf": [{"type": "string"}, {"type": "null"}]}


@pytest.mark.parametrize(
    ("text", "schema", "expected"),
    [
        ("1.10", STRING, "1.10"),
        ("true", STRING, "true"),
        ("3", STRING, "3"),
        ('"3"', STRING, "3"),
        ("3", INTEGER, 3),
        ("1.10", None, 1.1),
        ("api.test", STRING, "api.test"),
        ("null", OPTIONAL_STRING, None),
        ("1.10", OPTIONAL_STRING, "1.10"),
        ("3", {"type": ["string", "integer"]}, 3),
        ('{"a": 1}', {"type": "object"}, {"a": 1}),
        ("${{ params.x }}", INTEGER, "${{ params.x }}"),
        ("5", {"enum": ["5", "6"]}, "5"),
        ("5", {}, 5),
    ],
)
def test_value_follows_the_declared_type(text: str, schema: Any, expected: Any) -> None:
    assert _value(text, schema) == expected
    assert type(_value(text, schema)) is type(expected)


def test_accepts_matches_the_control_plane_rules() -> None:
    assert _accepts({"type": "number"}, 1.5)
    assert not _accepts({"type": "integer"}, True)
    assert not _accepts({"type": "number"}, False)
    assert _accepts({"type": "array"}, [1])


def test_types_are_only_looked_up_when_a_value_is_not_a_string() -> None:
    assert not _needs_types(["api.test", '"3"', "${{ params.x }}"])
    assert _needs_types(["api.test", "1.10"])
