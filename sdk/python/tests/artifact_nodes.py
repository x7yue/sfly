"""产物上限的测试节点（#477）：`sfly.testing.run_node` 按模块路径找节点函数，所以它们放在这里。"""

from __future__ import annotations

from typing import Any

from sfly import Context, node


@node(outputs=["limit"])
def probe_limit(ctx: Context) -> dict[str, Any]:
    ctx.artifacts.save("big.bin", b"x" * 100_000)
    return {"limit": ctx.artifacts.limit_bytes}
