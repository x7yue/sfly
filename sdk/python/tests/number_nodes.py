"""返回 NaN、无穷，或把它们交给 `ctx.progress`、`ctx.notify` 的节点（#481）：
`test_runner.py` 按本地协议运行，`test_testing.py` 通过 `sfly.testing.run_node` 运行，
两边的错误信息要一样。"""

from __future__ import annotations

from typing import Any

from sfly import Context, FeishuBot, Metric, node


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


@node(outputs=["a", "b"])
def nan_beside_a_key_json_cannot_write(ctx: Context) -> dict[str, Any]:
    outputs: dict[Any, Any] = {"a": float("nan"), b"k": 1}  # 键是 bytes：JSON 写不了
    return outputs


@node(outputs=["n", "x"])
def nan_under_a_key_json_cannot_write(ctx: Context) -> dict[str, Any]:
    outputs: dict[Any, Any] = {"n": float("nan"), "x": {b"k": float("inf")}}
    return outputs


@node(outputs=[])
def huge_integer_progress(ctx: Context) -> dict[str, Any]:
    ctx.progress(10**400, 10, "current 超出浮点数范围")
    ctx.progress(1, 10**400, "total 超出浮点数范围")
    ctx.progress(2, 10, "正常")
    return {}


@node(outputs=[], metrics=[Metric("tps")])
def huge_integer_metric(ctx: Context) -> dict[str, Any]:
    ctx.metric("tps", 10**400)
    ctx.metric("tps", 1.5)
    return {}


@node(outputs=[], metrics=[Metric("progress")])
def non_finite_progress_and_a_metric_named_progress(ctx: Context) -> dict[str, Any]:
    ctx.progress(float("nan"))
    ctx.metric("progress", float("nan"))
    return {}
