"""飞书消息的请求体（ADR 0020）。只用标准库（ADR 0002）。

`sfly.feishu.card(标题, Markdown 正文, 颜色)` 组装 Markdown 卡片的请求体，用法是
`ctx.notify(bot, message=sfly.feishu.card(...))`；
规则与画布上飞书通知节点的「Markdown 卡片」格式相同。

这个模块镜像控制面的 `apps/server/src/feishu/messages.ts`：卡片的规则和用例在
`testdata/feishu-card-cases.json`，两边各有一份实现，跑同一组用例。其余的函数（文本消息的组装、
原始消息的校验）只在本地调试（`sfly.local`）里用：本地没有控制面，由它们按控制面的规则
决定 `ctx.notify` 会发出什么。
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Literal, get_args

__all__ = ["CardColor", "card"]

#: Markdown 卡片标题的颜色（飞书卡片的颜色模板）。
CardColor = Literal["blue", "green", "orange", "red", "grey"]

_COLORS: tuple[str, ...] = get_args(CardColor)
#: 飞书自定义机器人接受的 `msg_type`。
_MSG_TYPES = ("text", "post", "image", "share_chat", "interactive")
#: 「@所有人」：飞书文本消息里的写法。
AT_ALL = '<at user_id="all">所有人</at>'
#: 飞书请求体的上限：紧凑 JSON 按 UTF-8 编码的字节数。
BODY_LIMIT_BYTES = 20 * 1024
#: 正文被截断时接在末尾的标记。
TRUNCATED_MARK = "…（已截断）"


def body_bytes(body: Mapping[str, Any]) -> int:
    """请求体序列化之后（实际发出去的样子）的字节数。"""
    return len(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def text_message(text: str, at_all: bool) -> dict[str, Any]:
    """文本消息的请求体，与控制面相同（messages.ts 的 `textMessage`）：
    超过 20 KB 时留下最长的、放得下的正文前缀，接上「…（已截断）」，「@所有人」仍在最后。"""
    tail = AT_ALL if at_all else ""

    def body(kept: str) -> dict[str, Any]:
        return {"msg_type": "text", "content": {"text": kept + tail}}

    if body_bytes(body(text)) <= BODY_LIMIT_BYTES:
        return body(text)
    low, high = 0, len(text)
    while high - low > 1:
        middle = (low + high) // 2
        if body_bytes(body(text[:middle] + TRUNCATED_MARK)) <= BODY_LIMIT_BYTES:
            low = middle
        else:
            high = middle
    return body(text[:low] + TRUNCATED_MARK)


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
    whole = _card(title, markdown, color)
    if body_bytes(whole) <= BODY_LIMIT_BYTES:
        return whole
    # 每个字符至少占一个字节，放得下的前缀不会超过上限的字符数：正文再长也只看开头这一段。
    chars = markdown[:BODY_LIMIT_BYTES]

    def cut(length: int) -> dict[str, Any]:
        return _card(title, chars[:length] + TRUNCATED_MARK, color)

    if body_bytes(cut(0)) > BODY_LIMIT_BYTES:
        raise ValueError(
            f"sfly.feishu.card 的标题太长（{len(title)} 个字符），连截断后的正文都放不下，"
            "整张卡片不能超过 20 KB"
        )
    # 前缀越长请求体越大，二分找出放得下的最长前缀。
    low, high = 0, len(chars)
    while low < high:
        middle = (low + high + 1) // 2
        if body_bytes(cut(middle)) <= BODY_LIMIT_BYTES:
            low = middle
        else:
            high = middle - 1
    return cut(low)


def raw_message_problem(value: object) -> str | None:
    """原始消息（完整的飞书请求体，原样发出）不合格的原因（中文）；合格时是 `None`。

    与控制面相同（messages.ts 的 `rawMessage`）：只校验它是一个对象、`msg_type` 是飞书支持的类型、
    不超过 20 KB；不截断（截断会弄坏结构）。
    """
    if not isinstance(value, dict):
        return "原始消息不是一个对象，需要完整的飞书请求体（JSON 对象）"
    msg_type = value.get("msg_type")
    if not isinstance(msg_type, str) or msg_type not in _MSG_TYPES:
        shown = json.dumps(msg_type, ensure_ascii=False) if "msg_type" in value else "没有"
        return f"原始消息的 msg_type 必须是 {'、'.join(_MSG_TYPES)} 之一（现在是 {shown}）"
    size = body_bytes(value)
    if size > BODY_LIMIT_BYTES:
        return f"原始消息有 {size / 1024:.1f} KB，超过飞书请求体 20 KB 的上限；原始消息不截断"
    return None
