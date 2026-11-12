"""飞书消息的请求体（ADR 0020）。只用标准库（ADR 0002）。

`sfly.feishu.card(标题, Markdown 正文, 颜色)` 组装 Markdown 卡片的请求体，用法是
`ctx.notify(bot, message=sfly.feishu.card(...))`；
规则与画布上飞书通知节点的「Markdown 卡片」格式相同。

这个模块镜像控制面的 `apps/server/src/feishu/messages.ts`：卡片、文本消息的截断和原始消息的校验，
规则和用例在 `testdata/feishu-card-cases.json`、`feishu-text-cases.json`、`feishu-raw-cases.json`，
两边各有一份实现，跑同一组用例。文本消息的组装、原始消息的校验只在本地调试（`sfly.local`）里用：
本地没有控制面，由它们按控制面的规则决定 `ctx.notify` 会发出什么。
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any, Literal, get_args

__all__ = ["CardColor", "card"]

#: Markdown 卡片标题的颜色（飞书卡片的颜色模板）。
CardColor = Literal["blue", "green", "orange", "red", "grey"]

_COLORS: tuple[str, ...] = get_args(CardColor)
#: 飞书自定义机器人接受的 `msg_type`。
MSG_TYPES = ("text", "post", "image", "share_chat", "interactive")
#: 「@所有人」：飞书文本消息里的写法。
AT_ALL = '<at user_id="all">所有人</at>'
#: 飞书请求体的上限：紧凑 JSON 按 UTF-8 编码的字节数。
BODY_LIMIT_BYTES = 20 * 1024
#: 上限在说明文字里的写法。
_LIMIT_LABEL = f"{BODY_LIMIT_BYTES // 1024} KB"
#: 正文被截断时接在末尾的标记。
TRUNCATED_MARK = "…（已截断）"


def body_bytes(body: Mapping[str, Any]) -> int:
    """请求体序列化之后（实际发出去的样子）的字节数。"""
    return len(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


class _TooLarge(Exception):
    """请求体里不能截断的部分太大，连空前缀加截断标记都放不下。"""


def _fit_to_limit(text: str, build: Callable[[str], dict[str, Any]]) -> dict[str, Any]:
    """请求体里有一段可以截断的文本（文本消息的正文、卡片的 Markdown 正文）：`build` 用给定的文本
    组装整个请求体。超过 20 KB 时截断这段文本：留下最长的、放得下的前缀（按 Unicode 字符，
    不把一个字符切成两半），末尾接上「…（已截断）」；其余部分太大，连空前缀加标记都放不下时抛出
    `_TooLarge`。与控制面相同（messages.ts 的 `fitToLimit`）。"""
    whole = build(text)
    if body_bytes(whole) <= BODY_LIMIT_BYTES:
        return whole
    # 每个字符至少占一个字节，放得下的前缀不会超过上限的字符数：文本再长也只看开头这一段。
    chars = text[:BODY_LIMIT_BYTES]

    def cut(length: int) -> dict[str, Any]:
        return build(chars[:length] + TRUNCATED_MARK)

    if body_bytes(cut(0)) > BODY_LIMIT_BYTES:
        raise _TooLarge
    # 前缀越长请求体越大，二分找出放得下的最长前缀。
    low, high = 0, len(chars)
    while low < high:
        middle = (low + high + 1) // 2
        if body_bytes(cut(middle)) <= BODY_LIMIT_BYTES:
            low = middle
        else:
            high = middle - 1
    return cut(low)


def text_message(text: str, at_all: bool) -> dict[str, Any]:
    """文本消息的请求体，与控制面相同（messages.ts 的 `textMessage`）：
    超过 20 KB 时留下最长的、放得下的正文前缀，接上「…（已截断）」，「@所有人」仍在最后。"""
    tail = AT_ALL if at_all else ""
    # 空正文加截断标记和「@所有人」总是放得下，不会抛出 `_TooLarge`。
    return _fit_to_limit(text, lambda kept: {"msg_type": "text", "content": {"text": kept + tail}})


def _card(title: str, markdown: str, color: str) -> dict[str, Any]:
    return {
        "msg_type": "interactive",
        "card": {
            "schema": "2.0",
            "header": {"title": {"tag": "plain_text", "content": title}, "template": color},
            "body": {"elements": [{"tag": "markdown", "content": markdown}]},
        },
    }


def card(title: str, markdown: str, color: CardColor = "blue") -> dict[str, Any]:
    """Markdown 卡片的请求体：header 是标题加颜色，正文是一个 Markdown 元素。

        ctx.notify(bot, message=sfly.feishu.card("压测完成", "**QPS** 1200，P99 35 ms", "green"))

    - `color`：标题的颜色，`blue`（默认）、`green`、`orange`、`red`、`grey`；
    - 标题和正文照原样放进去：不做 Markdown 转义，空字符串也照常组装；
    - 请求体超过 20 KB（紧凑 JSON 按 UTF-8 编码的字节数）时截断正文：留下最长的、放得下的前缀，
      末尾接上「…（已截断）」，与画布上的 Markdown 卡片相同；
    - 标题长到连截断后的正文都放不下时抛出 `ValueError`。

    只有参数不对这类编程错误才抛出异常：`title`、`markdown` 不是字符串抛出 `TypeError`，
    `color` 不是上面五种之一抛出 `ValueError`。
    """
    if not isinstance(title, str):
        raise TypeError(f"sfly.feishu.card 的 title 必须是字符串，实际为 {title!r}")
    if not isinstance(markdown, str):
        raise TypeError(f"sfly.feishu.card 的 markdown 必须是字符串，实际为 {markdown!r}")
    if color not in _COLORS:
        raise ValueError(
            f"sfly.feishu.card 的 color 必须是 {'、'.join(_COLORS)} 之一，实际为 {color!r}"
        )
    try:
        return _fit_to_limit(markdown, lambda kept: _card(title, kept, color))
    except _TooLarge:
        raise ValueError(
            f"sfly.feishu.card 的标题太长（{len(title)} 个字符），连截断后的正文都放不下，"
            f"整张卡片不能超过 {_LIMIT_LABEL}"
        ) from None


def _json_text(value: object) -> str:
    """值的紧凑 JSON 写法，与控制面 `JSON.stringify` 一致：没有多余空白，非 ASCII 字符不转义，
    整数值的小数写成整数（1.0 显示 1）。"""

    def plain(item: object) -> object:
        if isinstance(item, float) and item.is_integer():
            return int(item)
        if isinstance(item, list):
            return [plain(i) for i in item]
        if isinstance(item, dict):
            return {k: plain(v) for k, v in item.items()}
        return item

    return json.dumps(plain(value), ensure_ascii=False, separators=(",", ":"))


def raw_message_problem(value: object) -> str | None:
    """原始消息（完整的飞书请求体，原样发出）不合格的原因（中文）；合格时是 `None`。

    与控制面相同（messages.ts 的 `rawMessage`）：只校验它是一个对象、`msg_type` 是飞书支持的类型、
    不超过 20 KB；不截断（截断会弄坏结构）。
    """
    if not isinstance(value, dict):
        return "原始消息不是一个对象，需要完整的飞书请求体（JSON 对象）"
    msg_type = value.get("msg_type")
    if not isinstance(msg_type, str) or msg_type not in MSG_TYPES:
        shown = _json_text(msg_type) if "msg_type" in value else "没有"
        return f"原始消息的 msg_type 必须是 {'、'.join(MSG_TYPES)} 之一（现在是 {shown}）"
    size = body_bytes(value)
    if size > BODY_LIMIT_BYTES:
        # 大小写成一位小数的 KB，正好在中间时向上取（20736 字节是 20.25 KB，写 20.3）。
        tenths = (size * 10 + 512) // 1024
        return (
            f"原始消息有 {tenths // 10}.{tenths % 10} KB，超过飞书请求体 {_LIMIT_LABEL} 的上限；"
            "原始消息不截断"
        )
    return None
