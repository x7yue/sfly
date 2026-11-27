"""查库存服务。"""

import json
import urllib.parse
import urllib.request
from typing import Annotated, TypedDict

from sfly import Context, Doc, node


class StockOutputs(TypedDict):
    sku: Annotated[str, Doc("商品编号")]
    quantity: Annotated[int, Doc("库存数量")]
    in_stock: Annotated[bool, Doc("是否有货（库存大于 0）")]


@node(title="库存检查")
def stock_check(
    ctx: Context,
    base_url: Annotated[str, Doc("库存服务的地址，例如 http://127.0.0.1:8765")],
    sku: Annotated[str, Doc("商品编号，例如 A-100")],
) -> StockOutputs:
    """请求库存服务的 /stock/<商品编号>。

    失败：服务连不上，或返回的不是 2xx（没有这个商品时是 404）。
    """
    url = f"{base_url}/stock/{urllib.parse.quote(sku)}"
    with ctx.action("查询库存", 地址=url):
        with urllib.request.urlopen(url, timeout=10) as resp:
            body = json.load(resp)
    quantity = int(body["quantity"])
    ctx.log.info("%s 的库存是 %d", sku, quantity)
    return {"sku": sku, "quantity": quantity, "in_stock": quantity > 0}
