"""错误说明里「实际是 …」后面的文字（sdk/python/src/sfly/cli/value_text.py，#576）和控制面的
`valueText`（packages/schema/src/value-text.ts）写成一样的文字，共用
testdata/node-timeout-value-cases.json；TypeScript 一端在
packages/schema/test/node-timeout-values.test.ts。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from sfly.cli.value_text import value_text

CASES: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "testdata" / "node-timeout-value-cases.json").read_text(
        "utf-8"
    )
)


@pytest.mark.parametrize("case", CASES["values"], ids=lambda c: c["name"])
def test_a_value_is_written_the_way_the_control_plane_writes_it(case: dict[str, Any]) -> None:
    assert value_text(case["value"]) == case["actual"]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (float("inf"), "Infinity"),
        (float("-inf"), "-Infinity"),
        (float("nan"), "NaN"),
        (-0.0, "0"),
        (100.0, "100"),
        (1e20, "100000000000000000000"),
        (123456789.125, "123456789.125"),
        (1e-6, "0.000001"),
        (1.5e-7, "1.5e-7"),
        ([1.0, "a", None, {"k": 2.0}], '[1,"a",null,{"k":2}]'),
        ('含 "引号" 和 汉字', '"含 \\"引号\\" 和 汉字"'),
    ],
)
def test_the_corners_javascript_writes_differently_from_python(value: Any, expected: str) -> None:
    """`NaN`、`Infinity`（Python 的 json 额外认的）和 repr、json.dumps 写得不一样的数字。"""
    assert value_text(value) == expected
