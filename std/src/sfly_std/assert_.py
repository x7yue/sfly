"""`assert`：对任意值做断言（模块名带下划线是因为 `assert` 是 Python 关键字）。

断言格式（`path`、`op`、`value`）定义在 `_assertions.py`，`http_request` 的 `expect_json` 也用它。
用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `assert` 一节。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated, Any, TypedDict

from sfly import Doc, node
from sfly_std._assertions import Assertion, check, describe


class AssertOutputs(TypedDict):
    passed: Annotated[bool, Doc("全部通过时为 true")]


class AssertionFailed(Exception):
    """有断言不通过。"""


@node(name="assert", title="断言")
def assert_(
    actual: Annotated[
        Any,
        Doc(
            "要检查的值，通常整个值就是一个引用（引用上游节点的输出，保持原类型）；"
            "也可以是包含多个引用的对象"
        ),
    ],
    assertions: Annotated[
        Sequence[Assertion],
        Doc('断言列表，至少一条；每条是 {"path": ..., "op": ..., "value": ...}'),
    ],
) -> AssertOutputs:
    """对一个值逐条做断言：数值、文本、JSON 都用同一个节点检查。
    每条断言用 path 取出值的一部分，再用 op 和 value 比较。

    失败：有断言不通过时失败，错误信息逐条列出不通过的断言：第几条、具体路径、期望和实际值。
    路径不存在时，除 exists 外的断言都不通过。
    断言写错时（路径无法解析、缺少 value、value 类型不对、正则不合法、有未知的键）也失败，
    错误信息写明是第几条，不检查任何断言。
    """
    if not assertions:
        raise ValueError("assertions 至少要有一条")
    failures = check(actual, assertions)
    if failures:
        raise AssertionFailed(describe(failures, len(assertions)))
    return {"passed": True}
