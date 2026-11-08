"""短节点链路的性能测试用的节点（#76）。

这里只放空节点：入口是 `sfly_short:empty`，执行器导入这个模块时除了 SDK 什么也不多导入，测出的是
「一个任务一个进程」本身的开销。重依赖节点在 `sfly_short.heavy`，导入它时才导入那一大批模块。
"""

from sfly import node


@node(title="空节点", outputs=[])
def empty() -> dict[str, object]:
    return {}
