"""`sfly scenario push` 的本地校验：已移除的节点种类（ADR 0028）说明怎么替换，
别的未知种类照旧列出可选的种类。"""

from __future__ import annotations

from sfly.cli.scenario_edit import _document_problems


def test_a_removed_node_kind_is_reported_with_the_replacement() -> None:
    problems = _document_problems(
        {"nodes": [{"id": "entry", "kind": "entry"}, {"id": "notify", "kind": "feishu_notify"}]}
    )
    assert len(problems) == 1
    assert "notify" in problems[0]
    assert "已移除的节点类型 feishu_notify：这种节点已不再支持，先删掉再保存" in problems[0]
    assert "替换办法：在节点代码里用 ctx.notify 发飞书消息" in problems[0]


def test_another_unknown_node_kind_still_lists_the_known_kinds() -> None:
    problems = _document_problems({"nodes": [{"id": "ghost", "kind": "teleport"}]})
    assert len(problems) == 1
    assert "kind 'teleport' 不是已知的节点类型，可选：" in problems[0]
