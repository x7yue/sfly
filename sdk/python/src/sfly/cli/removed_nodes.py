"""已移除的节点种类（ADR 0028）：历史版本和历史运行里还留着它们，命令行只读显示，
保存时说明怎么替换。

和控制面的 `packages/schema/src/removed-nodes.ts` 是同一份清单：`tests/test_cli_run_view.py`
逐项核对种类名、名称和替换办法，改一边不改另一边会失败。
"""

from __future__ import annotations

# 种类名 → (原来的名称, 替换办法)。
REMOVED_NODE_KINDS: dict[str, tuple[str, str]] = {
    "feishu_notify": ("飞书通知", "在节点代码里用 ctx.notify 发飞书消息"),
    "timer": ("定时", "在节点代码里等到那个时刻，或把场景拆成两次运行"),
    "sleep": ("Sleep", "在节点代码里等待，或把场景拆成两次运行"),
}


def removed_kind_label(kind: str) -> str:
    """已移除的种类在历史记录里的名称：「已移除的节点类型」加它当时的种类名。"""
    return f"已移除的节点类型 {kind}"
