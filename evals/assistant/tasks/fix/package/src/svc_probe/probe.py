"""探测被测服务的 HTTP 接口。"""

import json
import time
import urllib.error
import urllib.request
from typing import Annotated, TypedDict

from sfly import Context, Doc, Metric, node


class ReadyOutputs(TypedDict):
    waited_s: Annotated[float, Doc("等到服务就绪用了多少秒")]


@node(title="等服务就绪")
def wait_ready(
    ctx: Context,
    base_url: Annotated[str, Doc("被测服务的地址，不带末尾的 /，例如 http://sut:9000")],
    timeout_s: Annotated[float, Doc("最多等多少秒")] = 30,
) -> ReadyOutputs:
    """每秒请求一次 /health，直到返回 200。

    失败：超过 timeout_s 秒还没有返回 200。
    """
    started = time.monotonic()
    with ctx.action("等待 /health 返回 200", 地址=base_url):
        while True:
            try:
                with urllib.request.urlopen(f"{base_url}/health", timeout=5) as resp:
                    if resp.status == 200:
                        break
            except (urllib.error.URLError, OSError) as error:
                ctx.log.info("服务还没就绪：%s", error)
            if time.monotonic() - started > timeout_s:
                raise TimeoutError(f"{base_url} 在 {timeout_s} 秒内没有就绪")
            time.sleep(1)
    waited = round(time.monotonic() - started, 2)
    ctx.log.info("%s 已就绪，等了 %.2f 秒", base_url, waited)
    return {"waited_s": waited}


class ItemsOutputs(TypedDict):
    item_count: Annotated[int, Doc("商品列表里的条目数")]
    total_price: Annotated[float, Doc("全部条目的价格之和，保留两位小数")]


@node(
    title="检查商品列表",
    metrics=[Metric("latency_ms", unit="ms", description="请求 /items 的耗时")],
    primary_metric="latency_ms",
)
def inspect_items(
    ctx: Context,
    base_url: Annotated[str, Doc("被测服务的地址，不带末尾的 /，例如 http://sut:9000")],
    min_items: Annotated[int, Doc("条目数至少要有多少")] = 1,
) -> ItemsOutputs:
    """请求被测服务的 /items，统计条目数和价格之和。

    失败：接口返回的不是 2xx，或条目数少于 min_items。
    """
    url = f"{base_url}/items"
    with ctx.action("请求商品列表", 地址=url):
        started = time.monotonic()
        with urllib.request.urlopen(url, timeout=10) as resp:
            body = json.load(resp)
        latency_ms = (time.monotonic() - started) * 1000
    ctx.metric("latency_ms", latency_ms)
    items = body
    total_price = 0
    for item in items:
        total_price += item["price"]
    if len(items) < min_items:
        raise RuntimeError(f"{url} 只有 {len(items)} 条，少于 {min_items} 条")
    ctx.log.info("%s 有 %d 条，价格之和 %s", url, len(items), total_price)
    return {"item_count": len(items), "total_price": round(total_price, 2)}
