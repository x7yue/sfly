"""依赖 sfly-std 的节点（#556 的全栈测试用）。

场景里没有任何 sfly-std 的节点，sfly-std 只作为依赖装上。
"""

from __future__ import annotations

from importlib import metadata

from sfly import Context, node


@node(title="用到 sfly-std", outputs=["std_version", "std_module"])
def uses_std(ctx: Context) -> dict[str, str]:
    """导入 sfly_std，返回装上的 sfly-std 的版本和模块文件的路径。"""
    import sfly_std

    version = metadata.version("sfly-std")
    ctx.log.info("sfly-std %s：%s", version, sfly_std.__file__)
    return {"std_version": version, "std_module": str(sfly_std.__file__)}
