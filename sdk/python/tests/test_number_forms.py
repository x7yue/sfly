"""数字的写法：节点在 Python 里把 secret 值里的数字打印出来的样子。

SDK 用 `json.loads` 读 Agent 写的 task.json（runner.py），节点打印时用 `json.dumps` 或 `repr`。
用例表 testdata/number-form-cases.json 三端共用（控制面、Agent、这里）：这里断言
`json.dumps(json.loads(serde))` 就是表里的 `python`；控制面一端（logs/secrets.ts 的
pythonNumber）和 Agent 一端（serde_json）各断言自己那一段。
"""

import json
from pathlib import Path

import pytest

_TABLE_FILE = Path(__file__).resolve().parents[3] / "testdata" / "number-form-cases.json"
_DATA = json.loads(_TABLE_FILE.read_text(encoding="utf-8"))
_TABLE = _DATA["cases"]
_WHOLE = _DATA["whole"]


def test_table_is_not_empty() -> None:
    assert len(_TABLE) >= 38
    assert len(_WHOLE) >= 4


@pytest.mark.parametrize("case", _TABLE, ids=[c["sent"] for c in _TABLE])
def test_python_prints_numbers_like_the_shared_table(case: dict[str, str]) -> None:
    value = json.loads(case["serde"])
    assert json.dumps(value) == case["python"], case["name"]
    # 打印整个对象和单个值用的是同一套规则（repr）
    assert json.dumps({"k": value}) == '{"k": ' + case["python"] + "}", case["name"]
    assert repr(value) == case["python"], case["name"]


@pytest.mark.parametrize("case", _WHOLE, ids=[c["name"][:30] for c in _WHOLE])
def test_python_prints_whole_values_like_the_shared_table(case: dict[str, str]) -> None:
    # 整个值：节点读 task.json（serde 写的）再 json.dumps 打印
    value = json.loads(case["serde"])
    assert json.dumps(value) == case["python"], case["name"]
