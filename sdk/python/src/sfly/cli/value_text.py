"""错误说明里「实际是 …」后面的文字（节点的超时、排队超时不合格时，#576）。

和控制面（packages/schema/src/value-text.ts 的 `valueText`）写成一样的文字，两端共用
testdata/node-timeout-value-cases.json：数字按 JavaScript 的 `Number#toString` 写，其余的按 JSON 写
（字符串带引号：`"30"` 和 `30` 看得出区别）。同一个文件里的同一个数字，两端的 JSON 解析器读成的
类型不一样（`5e9` 在这里是浮点数、`12345678901234567890` 是大整数，在控制面里都是双精度），
所以数字先按双精度处理再写。
"""

from __future__ import annotations

import json
import math
from decimal import Decimal
from typing import Any


def value_text(value: Any) -> str:
    """`value` 写成控制面的 `valueText` 写出的文字。"""
    if isinstance(value, bool) or value is None:
        return "true" if value is True else "false" if value is False else "null"
    if isinstance(value, (int, float)):
        return _number_text(float(value))
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(value_text(item) for item in value) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(
                f"{json.dumps(str(k), ensure_ascii=False)}:{value_text(v)}"
                for k, v in value.items()
            )
            + "}"
        )
    return str(value)


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
