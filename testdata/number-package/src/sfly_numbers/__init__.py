"""数值往返的全栈测试用的节点（#450）。"""

from __future__ import annotations

import json
import random
from typing import Any

from sfly import Context, node

#: 有代表性的数值：名称 → JSON 文本。`emit` 用 `json.loads` 把文本读成 Python 的 int / float，
#: 所以 `1e-7` 是 float、`9007199254740993` 是 int，和节点代码里写字面量一样。
#: 同一份文本会作为 `texts` 输出，测试用它们作为期望值。
CASES: dict[str, str] = {
    # 一般的小数
    "short": "60.157",
    "negative": "-60.157",
    "tenth": "0.1",
    "tiny": "1e-7",
    "long_fraction": "123456789.123456789",
    # 浮点运算的结果：最短表示有 17 位有效数字
    "sum": repr(0.1 + 0.2),
    "scaled": repr(60157 * 0.001),
    # 默认配置的 serde_json 解析这两个数会差最后一位（#450）
    "drift": "29491.727857142858",
    "tiny_drift": "7.038531e-26",
    # 双精度数的两端
    "max": "1.7976931348623157e308",
    "min_subnormal": "5e-324",
    # 整数：2^53 以内、刚过 2^53、超过 u64、超过 JavaScript 的整数写法的范围（1e21）
    "safe_int": "9007199254740991",
    "big_int": "9007199254740993",
    "u64_int": "18446744073709551615",
    "huge_int": "1180591620717411303424",
    # 整数值的小数、负零
    "integral_float": "3.0",
    "neg_zero": "-0.0",
}

#: 一串浮点运算的结果（固定种子）：各种数量级、都是 17 位有效数字上下，
#: 平台里任何一段多经过一次「解析再写出」都会让其中一部分的最后一位变掉。
SERIES_SIZE = 300


def make_series() -> list[float]:
    rng = random.Random(450)
    return [rng.random() * 10 ** rng.randint(-12, 12) / 7 for _ in range(SERIES_SIZE)]


@node(title="写出数值", outputs=[*CASES, "series", "nested", "texts", "reprs"])
def emit(ctx: Context) -> dict[str, Any]:
    """写出一组有代表性的数值：每个数值一个输出，另有一串浮点运算的结果、嵌套在对象和数组里的数值。
    `texts` 是每个数值的 JSON 文本，`reprs` 是 Python 对它们的 `repr`（字符串经过平台不会变）。"""
    values: dict[str, Any] = {name: json.loads(text) for name, text in CASES.items()}
    chain = make_series()
    nested = {"a": {"b": [values["short"], values["sum"], {"c": values["drift"]}]}}
    return {
        **values,
        "series": chain,
        "nested": nested,
        "texts": CASES,
        "reprs": {name: repr(value) for name, value in values.items()} | {"series": repr(chain)},
    }


def describe(value: Any) -> Any:
    """把数值换成 `类型名:repr` 的字符串（字符串经过平台不会变），对象和数组逐层处理。"""
    if isinstance(value, dict):
        return {key: describe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [describe(item) for item in value]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return value
    return f"{type(value).__name__}:{value!r}"


@node(title="报告收到的数值", outputs=["whole", "embedded", "nested", "series"])
def inspect_numbers(
    ctx: Context, whole: Any, embedded: Any, nested: Any, series: Any
) -> dict[str, Any]:
    """把收到的输入里的数值换成 `类型名:repr` 写回去。`whole` 的每个值是整值引用，
    `embedded` 的每个值是嵌在字符串里的引用，`nested`、`series` 整个是一个引用。"""
    return {
        "whole": describe(whole),
        "embedded": embedded,
        "nested": describe(nested),
        "series": describe(series),
    }


@node(title="写出不是数的值", outputs=["x"])
def emit_nan(ctx: Context, kind: str) -> dict[str, Any]:
    """写出 NaN 或无穷（`nan`、`inf`、`-inf`）：JSON 里没有这些值。"""
    return {"x": float(kind)}
