"""错误说明里「实际是 …」后面的文字（节点的超时、排队超时不合格时，#576）。

和控制面（packages/schema/src/value-text.ts 的 `valueText`）写成一样的文字，两端共用
testdata/node-timeout-value-cases.json：数字按 JavaScript 的 `Number#toString` 写，其余的按
`JSON.stringify` 写（字符串带引号：`"30"` 和 `30` 看得出区别）。同一个文件里的同一个数字，两端的
JSON 解析器读成的类型不一样（`5e9` 在这里是浮点数、`12345678901234567890` 是大整数，在控制面里
都是双精度），所以数字先按双精度处理再写。容器里的写法也照 JavaScript：像整数的键（`"1"`、`"2"`）
排在前面、按数值从小到大，其余的键按出现的顺序；容器里的非有限数（`1e400`）写成 `null`，顶层的写成
`Infinity`；孤立的代理项写成 `\\udXXX`。
"""

from __future__ import annotations

import json
import math
import re
from decimal import Decimal
from typing import Any

#: JavaScript 里「数组下标」那样的键：不带前导零的非负整数，小于 2^32 − 1。这样的键排在最前面。
_INDEX_KEY = re.compile(r"^(0|[1-9][0-9]*)$")
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def value_text(value: Any) -> str:
    """`value` 写成控制面的 `valueText` 写出的文字。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return _json_text(value)
    return _number_text(float(value))


def _json_text(value: Any) -> str:
    """`JSON.stringify`：非有限数写成 `null`，孤立的代理项转义，对象的键按 JavaScript 的顺序。"""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        number = float(value)
        return "null" if not math.isfinite(number) else _number_text(number)
    if isinstance(value, str):
        return _string_text(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_json_text(item) for item in value) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(
                f"{_string_text(str(key))}:{_json_text(value[key])}" for key in _key_order(value)
            )
            + "}"
        )
    return str(value)


def _string_text(text: str) -> str:
    """JSON 字符串（`ensure_ascii=False`，和 `JSON.stringify` 一样不转义非 ASCII 字符）；
    孤立的代理项写成小写的 `\\udXXX`。"""
    return _LONE_SURROGATE.sub(
        lambda match: f"\\u{ord(match.group()):04x}", json.dumps(text, ensure_ascii=False)
    )


def _key_order(value: dict[Any, Any]) -> list[Any]:
    """JavaScript 对象的键的顺序：像数组下标的键先按数值从小到大，其余的按出现的顺序。"""
    keys = list(value)
    indices = [k for k in keys if _INDEX_KEY.match(str(k)) and int(str(k)) < 2**32 - 1]
    indices.sort(key=lambda k: int(str(k)))
    return indices + [k for k in keys if k not in indices]


def _number_text(number: float) -> str:
    """JavaScript 的 `Number#toString`（ECMAScript 的 Number::toString，十进制）。"""
    if math.isnan(number):
        return "NaN"
    if math.isinf(number):
        return "Infinity" if number > 0 else "-Infinity"
    if number == 0:
        return "0"
    sign = "-" if number < 0 else ""
    # `repr` 给的是能还原成同一个双精度数的最短十进制数字，和 JavaScript 用的是同一组数字。
    decimal = Decimal(repr(abs(number))).normalize().as_tuple()
    digits = "".join(map(str, decimal.digits))
    k = len(digits)
    n = int(decimal.exponent) + k  # 值 = 0.<digits> × 10^n
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * -n + digits
    exponent = n - 1
    mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
    return f"{sign}{mantissa}e{'+' if exponent >= 0 else '-'}{abs(exponent)}"
