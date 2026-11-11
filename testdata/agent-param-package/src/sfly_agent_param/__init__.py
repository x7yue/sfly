"""「Agent」类型的输入的全栈测试用的节点（#197）。"""

from __future__ import annotations

from sfly import AgentName, Context, node


@node(title="访问 Agent", outputs=["source", "reached"])
def reach(ctx: Context, source: AgentName) -> dict[str, object]:
    """输出收到的参数值（Agent 名称），并访问那台 Agent 一次：节点所在的 Agent 用控制面随任务下发的
    地址和端口连过去，连得上时 `reached` 是那台 Agent 上 `/` 的路径。"""
    return {"source": source, "reached": ctx.agent(source).files.stat("/").path}
