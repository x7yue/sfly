"""`sfly scenario push` 的本地校验：已移除的节点种类（ADR 0028）说明怎么替换，
别的未知种类照旧列出可选的种类。"""

from __future__ import annotations

import pytest

from sfly.cli.scenario_edit import _document_problems


@pytest.mark.parametrize(
    ("node", "replacement"),
    [
        ({"id": "notify", "kind": "feishu_notify"}, "在节点代码里用 ctx.notify 发飞书消息"),
        (
            {"id": "at", "kind": "timer", "at": "10:00:00"},
            "在节点代码里等到那个时刻，或把场景拆成两次运行",
        ),
        (
            {"id": "pause", "kind": "sleep", "duration": "5s"},
            "在节点代码里等待，或把场景拆成两次运行",
        ),
    ],
    ids=["feishu_notify", "timer", "sleep"],
)
def test_a_removed_node_kind_is_reported_with_the_replacement(
    node: dict[str, str], replacement: str
) -> None:
    problems = _document_problems({"nodes": [{"id": "entry", "kind": "entry"}, node]})
    assert len(problems) == 1
    assert node["id"] in problems[0]
    assert f"已移除的节点类型 {node['kind']}：这种节点已不再支持，先删掉再保存" in problems[0]
    assert f"替换办法：{replacement}" in problems[0]


def test_another_unknown_node_kind_still_lists_the_known_kinds() -> None:
    problems = _document_problems({"nodes": [{"id": "ghost", "kind": "teleport"}]})
    assert len(problems) == 1
    assert "kind 'teleport' 不是已知的节点类型，可选：" in problems[0]
