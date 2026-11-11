"""「Agent」类型的输入的全栈测试用的节点（#197）。"""

from __future__ import annotations

from sfly import AgentName, Context, node


@node(title="访问 Agent", outputs=["source", "agents"])
def reach(ctx: Context, source: AgentName) -> dict[str, object]:
    """输出收到的参数值（Agent 名称），以及控制面随任务下发的被引用 Agent 的地址和端口。"""
    return {
        "source": source,
        "agents": {
            name: {
                "address": agent.address,
                "port": agent.port,
                "unavailable_reason": agent.unavailable_reason,
            }
            for name, agent in ctx.task.agents.items()
        },
    }
