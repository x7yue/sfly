"""`assert`：对任意值做断言（模块名带下划线是因为 `assert` 是 Python 关键字）。

断言格式（`path`、`op`、`value`）定义在 `_assertions.py`，`http_request` 的 `expect_json` 也用它。
用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `assert` 一节。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, TypedDict

from sfly import node
from sfly_std._assertions import Assertion, check, describe


class AssertOutputs(TypedDict):
    passed: bool


class AssertionFailed(Exception):
    """有断言不通过。"""


@node(name="assert", title="断言")
def assert_(actual: Any, assertions: Sequence[Assertion]) -> AssertOutputs:
    """对 `actual`（通常是整值引用的上游输出）逐条检查 `assertions`。

    每条断言取 `path`（JSONPath 子集：`$.a.b[0]`、`["键"]`、`[*]`，默认 `$` 即整个值）处的值，
    用 `op` 与 `value` 比较：eq、ne、gt、ge、lt、le、contains、matches、exists、len_eq。
    全部通过时输出 `passed`（true）；有不通过的时失败，逐条列出路径、期望值和实际值。
    """
    if not assertions:
        raise ValueError("assertions 至少要有一条")
    failures = check(actual, assertions)
    if failures:
        raise AssertionFailed(describe(failures, len(assertions)))
    return {"passed": True}
