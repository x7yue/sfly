"""产物上限的测试节点（#477）：`sfly.testing.run_node` 按模块路径找节点函数，所以它们放在这里。"""

from __future__ import annotations

from typing import Any

from sfly import Context, node


@node(outputs=["limit"])
def probe_limit(ctx: Context) -> dict[str, Any]:
    ctx.artifacts.save("big.bin", b"x" * 100_000)
    return {"limit": ctx.artifacts.limit_bytes}


def save_too_much_in_a_child(directory: str, limit: int) -> str:
    """子进程里的节点代码：`Context().artifacts.save` 超限。放在能按名字导入的模块里：
    `spawn` 方式启动的子进程要按名字找到它。"""
    from sfly import Context

    ctx = Context(
        events_path=None,
        cancel_path=None,
        artifacts_dir=directory,
        artifacts_url=None,
        artifact_limit_bytes=limit,
    )
    return ctx.artifacts.save("big.bin", b"x" * (limit + 1))
