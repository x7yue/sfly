"""`assert`：在真实的执行器进程里对任意值做断言（`sfly.testing.run_node`）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from sfly.testing import Execution, run_node
from sfly_std.assert_ import assert_


def run(tmp_path: Path, actual: Any, *assertions: dict[str, Any]) -> Execution:
    return run_node(assert_, {"actual": actual, "assertions": list(assertions)}, work_dir=tmp_path)


def test_passes_and_outputs_passed_when_every_assertion_holds(tmp_path: Path) -> None:
    result = run(tmp_path, 42, {"op": "eq", "value": 42})

    assert result.status == "success", result.error
    assert result.outputs == {"passed": True}


def failure(result: Execution) -> str:
    assert result.status == "failed", result.outputs
    assert result.error is not None
    return result.error.message


def test_fails_listing_path_expected_and_actual_of_each_failed_assertion(tmp_path: Path) -> None:
    result = run(
        tmp_path,
        {"status": "error", "count": 2, "name": "sfly"},
        {"path": "$.status", "op": "eq", "value": "ok"},
        {"path": "$.name", "op": "eq", "value": "sfly"},
        {"path": "$.count", "op": "gt", "value": 3},
    )

    assert failure(result) == (
        "sfly_std.assert_.AssertionFailed: 3 条断言中 2 条不通过：\n"
        '- 第 1 条：$.status 应 eq "ok"，实际是 "error"\n'
        "- 第 3 条：$.count 应 gt 3，实际是 2"
    )


# (actual, op, value)：每种比较方式在数值、文本、JSON 上通过的例子。
PASSING = [
    (3, "eq", 3),
    (3, "eq", 3.0),  # 整数和小数按数值比较
    ("你好", "eq", "你好"),
    ({"a": [1, {"b": None}]}, "eq", {"a": [1, {"b": None}]}),
    (3, "ne", 4),
    ("ok", "ne", "OK"),
    (True, "ne", 1),  # JSON 里布尔值不是数字
    ([1, 2], "ne", [2, 1]),
    (4, "gt", 3),
    (2.5, "gt", 2),
    (3, "ge", 3),
    (2, "lt", 3),
    (3, "le", 3),
    ("42\n", "ge", 40),  # 数字文本（例如 shell 的 stdout）按数值比较
    (" -1.5 ", "lt", 0),
    ("连接成功，耗时 3 ms", "contains", "连接成功"),
    ([1, {"id": 2}], "contains", {"id": 2}),  # 数组：含有等于期望值的元素
    ({"status": "ok"}, "contains", "status"),  # 对象：含有这个键
    ("version 1.2.3", "matches", r"\d+\.\d+\.\d+"),  # 正则在文本任意位置匹配
    ("第一行\n第二行", "matches", "^第二行$"),  # 多行模式：^ $ 匹配每一行
    ("abc", "len_eq", 3),
    ([1, 2], "len_eq", 2),
    ({"a": 1}, "len_eq", 1),
]


@pytest.mark.parametrize(("actual", "op", "value"), PASSING)
def test_each_op_passes(tmp_path: Path, actual: Any, op: str, value: Any) -> None:
    result = run(tmp_path, actual, {"op": op, "value": value})

    assert result.status == "success", result.error


# (actual, op, value, 失败信息里的那一条)
FAILING = [
    (3, "eq", 4, "$ 应 eq 4，实际是 3"),
    (1, "eq", True, "$ 应 eq true，实际是 1"),
    ({"a": [1, 2]}, "eq", {"a": [2, 1]}, '$ 应 eq {"a": [2, 1]}，实际是 {"a": [1, 2]}'),
    ("ok", "ne", "ok", '$ 应 ne "ok"，实际是 "ok"'),
    (3, "gt", 3, "$ 应 gt 3，实际是 3"),
    (2, "ge", 3, "$ 应 ge 3，实际是 2"),
    (3, "lt", 3, "$ 应 lt 3，实际是 3"),
    (4, "le", 3, "$ 应 le 3，实际是 4"),
    ("42\n", "lt", 40, '$ 应 lt 40，实际是 "42\\n"'),
    ("abc", "gt", 1, '$ 应 gt 1，实际是 "abc"（不是数字）'),
    (True, "gt", 0, "$ 应 gt 0，实际是 true（不是数字）"),
    ("连接失败", "contains", "成功", '$ 应 contains "成功"，实际是 "连接失败"'),
    ([1, 2], "contains", 3, "$ 应 contains 3，实际是 [1, 2]"),
    ({"a": 1}, "contains", "b", '$ 应 contains "b"，实际是 {"a": 1}'),
    (42, "contains", "4", '$ 应 contains "4"，实际是 42（不是文本、数组或对象）'),
    ("v1", "matches", r"^\d", '$ 应 matches "^\\\\d"，实际是 "v1"'),
    (12, "matches", r"\d", '$ 应 matches "\\\\d"，实际是 12（不是文本）'),
    ([1, 2], "len_eq", 3, "$ 应 len_eq 3，实际是 [1, 2]（长度 2）"),
    (5, "len_eq", 1, "$ 应 len_eq 1，实际是 5（不是文本、数组或对象）"),
]


@pytest.mark.parametrize(("actual", "op", "value", "line"), FAILING)
def test_each_op_fails_with_expected_and_actual(
    tmp_path: Path, actual: Any, op: str, value: Any, line: str
) -> None:
    result = run(tmp_path, actual, {"op": op, "value": value})

    assert failure(result) == (
        f"sfly_std.assert_.AssertionFailed: 1 条断言中 1 条不通过：\n- 第 1 条：{line}"
    )


def test_path_defaults_to_the_whole_value(tmp_path: Path) -> None:
    result = run(tmp_path, {"a": 1}, {"op": "eq", "value": {"b": 1}})

    assert failure(result).endswith('第 1 条：$ 应 eq {"b": 1}，实际是 {"a": 1}')


DOCUMENT = {
    "service": {"name": "api", "ports": [8080, 9090]},
    "items": [
        {"id": 1, "status": "ok"},
        {"id": 2, "status": "error"},
        {"id": 3, "status": "ok", "note": "重试后成功"},
    ],
    "健康 检查": {"结果": "通过"},
    "empty": [],
}


@pytest.mark.parametrize(
    ("path", "value"),
    [
        ("$.service.name", "api"),
        ("$.service.ports[0]", 8080),
        ("$.service.ports[-1]", 9090),  # 负数下标从末尾数
        ("$.items[1].status", "error"),
        ('$["健康 检查"]["结果"]', "通过"),  # 键里有空格、点等字符时用方括号加引号
        ("$['service']['name']", "api"),
        ("$.service.ports", [8080, 9090]),
        ("$", DOCUMENT),
    ],
)
def test_json_path_selects_a_value(tmp_path: Path, path: str, value: Any) -> None:
    result = run(tmp_path, DOCUMENT, {"path": path, "op": "eq", "value": value})

    assert result.status == "success", result.error


def test_wildcard_asserts_every_element_and_lists_each_failing_one(tmp_path: Path) -> None:
    result = run(
        tmp_path,
        DOCUMENT,
        {"path": "$.items[*].id", "op": "gt", "value": 0},
        {"path": "$.items[*].status", "op": "eq", "value": "ok"},
        {"path": "$.service.*", "op": "len_eq", "value": 2},
    )

    assert failure(result) == (
        "sfly_std.assert_.AssertionFailed: 3 条断言中 2 条不通过：\n"
        '- 第 2 条：$.items[1].status 应 eq "ok"，实际是 "error"\n'
        '- 第 3 条：$.service.name 应 len_eq 2，实际是 "api"（长度 3）'
    )


def test_fails_when_the_path_does_not_exist(tmp_path: Path) -> None:
    result = run(
        tmp_path,
        DOCUMENT,
        {"path": "$.service.version", "op": "eq", "value": "1.0"},
        {"path": "$.service.ports[5]", "op": "ne", "value": 1},
        {"path": "$.service.name.first", "op": "eq", "value": "a"},
        {"path": "$.items[*].note", "op": "contains", "value": "成功"},
        {"path": "$.empty[*]", "op": "eq", "value": 1},
    )

    assert failure(result) == (
        "sfly_std.assert_.AssertionFailed: 5 条断言中 5 条不通过：\n"
        '- 第 1 条：$.service.version 应 eq "1.0"，路径不存在\n'
        "- 第 2 条：$.service.ports[5] 应 ne 1，路径不存在\n"
        '- 第 3 条：$.service.name.first 应 eq "a"，路径不存在\n'
        '- 第 4 条：$.items[0].note 应 contains "成功"，路径不存在\n'
        '- 第 4 条：$.items[1].note 应 contains "成功"，路径不存在\n'
        "- 第 5 条：$.empty[*] 应 eq 1，没有匹配的值"
    )


def test_exists_checks_that_the_path_exists_or_with_false_that_it_does_not(
    tmp_path: Path,
) -> None:
    passing = run(
        tmp_path,
        DOCUMENT,
        {"path": "$.service.name", "op": "exists"},
        {"path": "$.items[*].id", "op": "exists", "value": True},
        {"path": "$.service.version", "op": "exists", "value": False},
        {"path": "$.empty[*]", "op": "exists", "value": False},
        {"path": "$.items[0].note", "op": "exists", "value": False},
    )
    assert passing.status == "success", passing.error

    failing = run(
        tmp_path,
        DOCUMENT,
        {"path": "$.service.version", "op": "exists"},
        {"path": "$.items[*].note", "op": "exists"},
        {"path": "$.service.name", "op": "exists", "value": False},
        {"path": "$.empty[*]", "op": "exists"},
    )
    assert failure(failing) == (
        "sfly_std.assert_.AssertionFailed: 4 条断言中 4 条不通过：\n"
        "- 第 1 条：$.service.version 应存在，路径不存在\n"
        "- 第 2 条：$.items[0].note 应存在，路径不存在\n"
        "- 第 2 条：$.items[1].note 应存在，路径不存在\n"
        '- 第 3 条：$.service.name 应不存在，实际是 "api"\n'
        "- 第 4 条：$.empty[*] 应存在，没有匹配的值"
    )


@pytest.mark.parametrize(
    ("assertion", "message"),
    [
        ({"path": "status", "op": "exists"}, "path 必须以 $ 开头：status"),
        ({"path": "$..a", "op": "exists"}, "path 在第 2 个字符处无法解析：$..a"),
        ({"path": "$.a[?(@.b)]", "op": "exists"}, "path 在第 4 个字符处无法解析：$.a[?(@.b)]"),
        ({"op": "eq"}, "eq 需要 value"),
        ({"op": "gt", "value": "3"}, 'gt 的 value 必须是数字，实际是 "3"'),
        ({"op": "matches", "value": 1}, "matches 的 value 必须是正则表达式文本，实际是 1"),
        ({"op": "matches", "value": "("}, "matches 的 value 不是合法的正则表达式："),
        ({"op": "len_eq", "value": -1}, "len_eq 的 value 必须是非负整数，实际是 -1"),
        ({"op": "exists", "value": "yes"}, 'exists 的 value 必须是 true 或 false，实际是 "yes"'),
        ({"op": "eq", "value": 1, "valeu": 2}, "有未知的键 valeu（只能是 path、op、value）"),
    ],
)
def test_rejects_an_invalid_assertion_before_checking_anything(
    tmp_path: Path, assertion: dict[str, Any], message: str
) -> None:
    result = run(tmp_path, {"a": 1}, {"op": "eq", "value": 2}, assertion)

    assert failure(result).startswith(f"ValueError: 第 2 条断言：{message}")


@pytest.mark.parametrize("assertion", [{"op": "approx", "value": 1}, {"path": "$", "value": 1}])
def test_op_is_required_and_must_be_a_supported_op(
    tmp_path: Path, assertion: dict[str, Any]
) -> None:
    result = run(tmp_path, 1, assertion)

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.kind == "config_error"


def test_needs_at_least_one_assertion(tmp_path: Path) -> None:
    result = run(tmp_path, 1)

    assert failure(result) == "ValueError: assertions 至少要有一条"


def test_long_values_are_shortened_in_the_failure_message(tmp_path: Path) -> None:
    result = run(tmp_path, "日志" * 1000 + "结尾", {"op": "contains", "value": "panic"})

    message = failure(result)
    assert message.endswith(
        '- 第 1 条：$ 应 contains "panic"，实际是 "' + "日志" * 99 + "日…（共 2004 个字符）"
    ), message
