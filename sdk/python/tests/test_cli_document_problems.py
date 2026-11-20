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


@pytest.mark.parametrize(
    ("node", "advice"),
    [
        (
            {"id": "at", "kind": "timer", "at": "10:00:00"},
            "别的节点引用了它的输出（triggered_at、late）的，也要一起改。",
        ),
        (
            {"id": "pause", "kind": "sleep", "duration": "5s"},
            "别的节点引用了它的输出（triggered_at）的，也要一起改。",
        ),
        ({"id": "notify", "kind": "feishu_notify"}, None),
    ],
    ids=["timer", "sleep", "feishu_notify"],
)
def test_a_removed_kind_that_had_outputs_says_the_nodes_using_them_must_change_too(
    node: dict[str, str], advice: str | None
) -> None:
    """原来有输出的已移除种类（定时、Sleep）：下游引用过它们的输出的节点删掉节点之后也要改，
    和控制面预检里的说明是同一句；没有输出的种类（飞书通知）不加这一句。"""
    problems = _document_problems({"nodes": [{"id": "entry", "kind": "entry"}, node]})
    assert len(problems) == 1
    if advice is None:
        assert "引用了它的输出" not in problems[0]
    else:
        assert advice in problems[0]


def test_another_unknown_node_kind_still_lists_the_known_kinds() -> None:
    problems = _document_problems({"nodes": [{"id": "ghost", "kind": "teleport"}]})
    assert len(problems) == 1
    assert "kind 'teleport' 不是已知的节点类型，可选：" in problems[0]


STICKY_NOTES_MESSAGE = (
    "场景文档里的 sticky_notes（便签）已不再支持，先把这一项删掉再保存。"
    "替换办法：便签：要留的内容写进节点的备注或注释框的备注"
)


@pytest.mark.parametrize(
    "notes",
    [[], [{"id": "sticky_1", "title": "跑之前确认", "text": "- Agent 都在线"}]],
    ids=["空的便签", "有内容的便签"],
)
def test_sticky_notes_are_reported_as_no_longer_supported_with_the_replacement(
    notes: list[dict[str, str]],
) -> None:
    """已移除的顶层字段（便签 `sticky_notes`，ADR 0028）：不只报 JSON Schema 的
    additionalProperties，写明这一项已不再支持、怎么办，和控制面拒绝保存时是同一句。"""
    problems = _document_problems(
        {"nodes": [{"id": "entry", "kind": "entry"}], "sticky_notes": notes}
    )
    assert problems == [f"  (根): {STICKY_NOTES_MESSAGE}"]


def test_sticky_notes_do_not_hide_the_other_problems_in_the_document() -> None:
    problems = _document_problems(
        {"nodes": [{"id": "ghost", "kind": "teleport"}], "sticky_notes": []}
    )
    assert len(problems) == 2
    assert f"  (根): {STICKY_NOTES_MESSAGE}" in problems
    assert any("kind 'teleport' 不是已知的节点类型" in p for p in problems)


def test_another_unexpected_top_level_field_is_still_reported_as_unexpected() -> None:
    """只有登记过的已移除字段写替换办法；别的多出来的字段照旧报「不允许的属性」。"""
    problems = _document_problems(
        {"nodes": [{"id": "entry", "kind": "entry"}], "sticky_notes": [], "ghost_field": 1}
    )
    assert f"  (根): {STICKY_NOTES_MESSAGE}" in problems
    assert any("ghost_field" in p and "Additional properties" in p for p in problems)
    assert not any("sticky_notes" in p and "Additional properties" in p for p in problems)


def test_a_document_without_removed_fields_has_no_such_problem() -> None:
    problems = _document_problems({"nodes": [{"id": "entry", "kind": "entry"}]})
    assert not any("已不再支持" in p for p in problems)
