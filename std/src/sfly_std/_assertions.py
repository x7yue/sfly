"""断言格式：`assert` 节点的 `assertions` 与 `http_request` 的 `expect_json` 共用。"""

from __future__ import annotations

import json
import re
import typing
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal, TypedDict

Op = Literal["eq", "ne", "gt", "ge", "lt", "le", "contains", "matches", "exists", "len_eq"]
_OPS: tuple[str, ...] = typing.get_args(Op)


class _Required(TypedDict):
    op: Op


class Assertion(_Required, total=False):
    """一条断言：取 `path`（JSONPath 子集，默认 `$` 即整个值）处的值，用 `op` 与 `value` 比较。"""

    path: str
    value: Any


@dataclass(frozen=True)
class Failure:
    index: int
    """不通过的是第几条断言（从 1 开始）。"""
    text: str

    def __str__(self) -> str:
        return f"第 {self.index} 条：{self.text}"


#: 失败信息里每个值（JSON）最多显示的字符数。
SHOW_CHARS = 200


def _show(value: Any) -> str:
    text = json.dumps(value, ensure_ascii=False)
    if len(text) > SHOW_CHARS:
        return f"{text[:SHOW_CHARS]}…（共 {len(text)} 个字符）"
    return text


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _equal(a: Any, b: Any) -> bool:
    """按 JSON 比较：整数和小数按数值比较，布尔值不等于数字，数组按顺序比较。"""
    if _is_number(a) and _is_number(b):
        return bool(a == b)
    if type(a) is not type(b):
        return False
    if isinstance(a, list):
        return len(a) == len(b) and all(_equal(x, y) for x, y in zip(a, b, strict=True))
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(_equal(a[k], b[k]) for k in a)
    return bool(a == b)


def _number(value: Any) -> float | None:
    """数值；数字文本（例如 shell 的 stdout `"42\\n"`）按数值处理；其他返回 None。"""
    if _is_number(value):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


_ORDER = {
    "gt": lambda a, b: a > b,
    "ge": lambda a, b: a >= b,
    "lt": lambda a, b: a < b,
    "le": lambda a, b: a <= b,
}


def _mismatch(op: str, actual: Any, expected: Any) -> str | None:
    """满足 `op expected` 时返回 None；不满足时返回附在实际值后面的说明（可为空字符串）。"""
    if op == "eq":
        return None if _equal(actual, expected) else ""
    if op == "ne":
        return "" if _equal(actual, expected) else None
    if op in _ORDER:
        number = _number(actual)
        if number is None:
            return "（不是数字）"
        return None if _ORDER[op](number, expected) else ""
    if op == "contains":
        if isinstance(actual, str):
            return None if expected in actual else ""
        if isinstance(actual, list):
            return None if any(_equal(item, expected) for item in actual) else ""
        if isinstance(actual, dict):
            return None if expected in actual else ""
        return "（不是文本、数组或对象）"
    if op == "matches":
        if not isinstance(actual, str):
            return "（不是文本）"
        return None if re.search(expected, actual, re.MULTILINE) else ""
    if op == "len_eq":
        if not isinstance(actual, (str, list, dict)):
            return "（不是文本、数组或对象）"
        return None if len(actual) == expected else f"（长度 {len(actual)}）"
    raise NotImplementedError(op)


#: JSONPath 子集的一步：`.键`、`.*`、`[下标]`、`[*]`、`["键"]` / `['键']`。
_STEP = re.compile(
    r"""\.(?P<wild>\*)|\.(?P<name>[^.\[\]'"*]+)|\[(?P<wild2>\*)\]|\[(?P<index>-?\d+)\]"""
    r"""|\["(?P<dq>[^"]*)"\]|\['(?P<sq>[^']*)'\]"""
)

_WILDCARD = object()
_MISSING = object()


def parse_path(path: str) -> list[str | int | object]:
    """把 JSONPath 拆成步骤（键、下标或通配）；不是支持的写法时抛出 ValueError。"""
    if not path.startswith("$"):
        raise ValueError(f"path 必须以 $ 开头：{path}")
    steps: list[str | int | object] = []
    pos = 1
    while pos < len(path):
        match = _STEP.match(path, pos)
        if not match:
            raise ValueError(f"path 在第 {pos + 1} 个字符处无法解析：{path}")
        if match["wild"] or match["wild2"]:
            steps.append(_WILDCARD)
        elif match["index"] is not None:
            steps.append(int(match["index"]))
        else:
            steps.append(
                next(g for g in (match["name"], match["dq"], match["sq"]) if g is not None)
            )
        pos = match.end()
    return steps


def _step_text(step: str | int) -> str:
    if isinstance(step, int):
        return f"[{step}]"
    return f".{step}" if step.isidentifier() else f"[{_show(step)}]"


def _select(value: Any, steps: list[str | int | object]) -> list[tuple[str, Any]]:
    """按步骤取值：返回每个匹配的具体路径和值（路径不存在时值为 _MISSING）；通配展开为每个元素。"""
    found: list[tuple[str, Any]] = [("$", value)]
    for step in steps:
        following: list[tuple[str, Any]] = []
        for where, current in found:
            if step is _WILDCARD:
                if isinstance(current, list):
                    following += [(f"{where}[{i}]", item) for i, item in enumerate(current)]
                elif isinstance(current, dict):
                    following += [(where + _step_text(k), item) for k, item in current.items()]
                continue
            assert isinstance(step, (str, int))
            where += _step_text(step)
            if (
                isinstance(step, int)
                and isinstance(current, list)
                and -len(current) <= step < len(current)
            ):
                following.append((where, current[step]))
            elif isinstance(step, str) and isinstance(current, dict) and step in current:
                following.append((where, current[step]))
            else:
                following.append((where, _MISSING))
        found = following
    return found


_KEYS = ("path", "op", "value")


def _validate(assertion: Assertion) -> list[str | int | object]:
    """检查一条断言的写法，返回解析好的路径步骤；写法不对时抛出 ValueError。"""
    unknown = [key for key in assertion if key not in _KEYS]
    if unknown:
        raise ValueError(f"有未知的键 {'、'.join(unknown)}（只能是 {'、'.join(_KEYS)}）")
    steps = parse_path(assertion.get("path", "$"))
    op = assertion["op"]
    if op not in _OPS:
        raise ValueError(f"op 必须是 {'、'.join(_OPS)} 之一，实际是 {_show(op)}")
    if "value" not in assertion:
        if op == "exists":
            return steps
        raise ValueError(f"{op} 需要 value")
    value = assertion["value"]
    if op in _ORDER and not _is_number(value):
        raise ValueError(f"{op} 的 value 必须是数字，实际是 {_show(value)}")
    if op == "matches":
        if not isinstance(value, str):
            raise ValueError(f"matches 的 value 必须是正则表达式文本，实际是 {_show(value)}")
        try:
            re.compile(value)
        except re.error as error:
            raise ValueError(f"matches 的 value 不是合法的正则表达式：{error}") from None
    if op == "len_eq" and not (
        isinstance(value, int) and not isinstance(value, bool) and value >= 0
    ):
        raise ValueError(f"len_eq 的 value 必须是非负整数，实际是 {_show(value)}")
    if op == "exists" and not isinstance(value, bool):
        raise ValueError(f"exists 的 value 必须是 true 或 false，实际是 {_show(value)}")
    return steps


def validate(assertions: Sequence[Assertion]) -> list[list[str | int | object]]:
    """检查断言的写法（路径、op、value 的类型），返回每条解析好的路径；
    不对时抛出 ValueError，信息带上是第几条。"""
    paths = []
    for index, assertion in enumerate(assertions, 1):
        try:
            paths.append(_validate(assertion))
        except ValueError as error:
            raise ValueError(f"第 {index} 条断言：{error}") from None
    return paths


def check(actual: Any, assertions: Sequence[Assertion]) -> list[Failure]:
    """逐条检查 `actual`，返回不通过的断言（全部通过时为空）；断言写法不对时抛出 ValueError。

    路径里有通配时，每个匹配的值都要满足；一个都没匹配到时不通过（`exists` 为 false 时通过）。
    """
    failures: list[Failure] = []
    for index, (assertion, steps) in enumerate(
        zip(assertions, validate(assertions), strict=True), 1
    ):
        path = assertion.get("path", "$")
        op = assertion["op"]
        found = _select(actual, steps)
        if op == "exists":
            should_exist = assertion.get("value", True)
            want = "应存在" if should_exist else "应不存在"
            if should_exist and not found:
                failures.append(Failure(index, f"{path} {want}，没有匹配的值"))
            for where, value in found:
                if should_exist and value is _MISSING:
                    failures.append(Failure(index, f"{where} {want}，路径不存在"))
                elif not should_exist and value is not _MISSING:
                    failures.append(Failure(index, f"{where} {want}，实际是 {_show(value)}"))
            continue
        expected = assertion.get("value")
        want = f"应 {op} {_show(expected)}"
        if not found:
            failures.append(Failure(index, f"{path} {want}，没有匹配的值"))
        for where, value in found:
            if value is _MISSING:
                failures.append(Failure(index, f"{where} {want}，路径不存在"))
                continue
            note = _mismatch(op, value, expected)
            if note is not None:
                failures.append(Failure(index, f"{where} {want}，实际是 {_show(value)}{note}"))
    return failures


def describe(failures: Sequence[Failure], total: int) -> str:
    """失败信息：`N 条断言中 M 条不通过：` 之后每条一行。"""
    failed = len({f.index for f in failures})
    lines = "\n".join(f"- {f}" for f in failures)
    return f"{total} 条断言中 {failed} 条不通过：\n{lines}"
