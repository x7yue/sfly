"""返回 NaN、无穷，或把它们交给 `ctx.progress`、`ctx.notify` 的节点（#481）：
`test_runner.py` 按本地协议运行，`test_testing.py` 通过 `sfly.testing.run_node` 运行，
两边的错误信息要一样。"""

from __future__ import annotations

from typing import Any

from sfly import Context, FeishuBot, node


@node(outputs=["ratio"])
def ratio_is_nan(ctx: Context) -> dict[str, Any]:
    return {"ratio": float("nan")}


@node(outputs=["stats"])
def nested_infinity(ctx: Context) -> dict[str, Any]:
    return {"stats": {"items": [1.5, 2.5, float("inf")], "ok": 1}}


@node(outputs=["a", "b", "c"])
def several(ctx: Context) -> dict[str, Any]:
    return {"a": float("nan"), "b": [float("-inf")], "c": {"d": float("nan")}}


@node(outputs=["x"])
def not_serializable(ctx: Context) -> dict[str, Any]:
    return {"x": object()}


@node(outputs=[])
def non_finite_progress(ctx: Context) -> dict[str, Any]:
    ctx.progress(float("nan"), 10, "current 是 NaN")
    ctx.progress(1, float("inf"), "total 是无穷")
    ctx.progress(2, 10, "正常")
    return {}


@node(outputs=[])
def notify_non_finite(ctx: Context, bot: FeishuBot) -> dict[str, Any]:
    ctx.notify(bot, message={"msg_type": "text", "content": {"text": "x", "n": float("nan")}})
    return {}
