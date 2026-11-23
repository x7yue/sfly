"""`sfly scenario push` 的本地校验：已移除的节点种类（ADR 0028）说明怎么替换，
别的未知种类照旧列出可选的种类。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

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


STICKY_NOTES = [
    {"id": "sticky_1", "title": "跑之前确认", "text": "- Agent 都在线"},
    {"id": "sticky_2", "text": "已知问题"},
]
STICKY_NOTES_MESSAGE = (
    "场景文档里的 sticky_notes（便签）有 2 条内容，已不再支持，不能保存："
    "先把要留的内容挪走，再把这一项删掉。"
    "替换办法：便签：要留的内容写进节点的备注或注释框的备注"
)


def test_sticky_notes_with_content_are_reported_with_the_count_and_the_replacement() -> None:
    """已移除的顶层字段（便签 `sticky_notes`，ADR 0028）里有内容：不只报 JSON Schema 的
    「数组太长」，写明有几条、怎么办，和控制面拒绝保存时是同一句。"""
    problems = _document_problems(
        {"nodes": [{"id": "entry", "kind": "entry"}], "sticky_notes": STICKY_NOTES}
    )
    assert problems == [f"  (根): {STICKY_NOTES_MESSAGE}"]


def test_empty_sticky_notes_are_not_a_problem() -> None:
    """每个旧版本都带着 `sticky_notes: []`，pull 出来的旧文件原样 push 不该被拒绝：
    空数组控制面接受并丢掉，本地检查也不报。"""
    assert (
        _document_problems({"nodes": [{"id": "entry", "kind": "entry"}], "sticky_notes": []}) == []
    )


def test_sticky_notes_with_content_do_not_hide_the_other_problems_in_the_document() -> None:
    problems = _document_problems(
        {"nodes": [{"id": "ghost", "kind": "teleport"}], "sticky_notes": STICKY_NOTES}
    )
    assert len(problems) == 2
    assert f"  (根): {STICKY_NOTES_MESSAGE}" in problems
    assert any("kind 'teleport' 不是已知的节点类型" in p for p in problems)


def test_empty_sticky_notes_do_not_add_a_problem_next_to_other_problems() -> None:
    problems = _document_problems(
        {"nodes": [{"id": "ghost", "kind": "teleport"}], "sticky_notes": []}
    )
    assert len(problems) == 1
    assert "便签" not in problems[0]
    assert "sticky_notes" not in problems[0]


def test_another_unexpected_top_level_field_is_still_reported_as_unexpected() -> None:
    """只有登记过的已移除字段写替换办法；别的多出来的字段照旧报「不允许的属性」。"""
    problems = _document_problems(
        {"nodes": [{"id": "entry", "kind": "entry"}], "sticky_notes": [], "ghost_field": 1}
    )
    assert any("ghost_field" in p and "Additional properties" in p for p in problems)
    assert not any("sticky_notes" in p for p in problems)


def test_a_document_without_removed_fields_has_no_such_problem() -> None:
    problems = _document_problems({"nodes": [{"id": "entry", "kind": "entry"}]})
    assert not any("已不再支持" in p for p in problems)


@pytest.mark.parametrize("timeout", [4_294_967_296, 5_000_000_000])
def test_a_node_timeout_over_the_limit_is_reported_with_the_node_and_the_limit(
    timeout: int,
) -> None:
    """场景里节点的超时上限和节点类型声明的超时一样（#476）：派发给 Agent 的超时是 uint32。"""
    document = {
        "nodes": [
            {"id": "entry", "kind": "entry"},
            {"id": "slow", "kind": "package", "package": "p", "node": "n", "timeout": timeout},
        ]
    }

    problems = _document_problems(document)

    assert problems == [
        f"  nodes/1/timeout（节点 slow）: 节点 slow：timeout 必须是 1 到 4294967295 之间的正整数"
        f"（秒），实际是 {timeout}"
    ]


def test_a_node_timeout_at_the_limit_is_accepted() -> None:
    document = {
        "nodes": [
            {"id": "entry", "kind": "entry"},
            {
                "id": "slow",
                "kind": "package",
                "package": "p",
                "node": "n",
                "timeout": 4_294_967_295,
            },
        ]
    }

    assert _document_problems(document) == []


@pytest.mark.parametrize("queue_timeout", [4_294_967_296, 9_000_000_000_000])
def test_a_node_queue_timeout_over_the_limit_is_reported_with_the_node_the_field_and_the_limit(
    queue_timeout: int,
) -> None:
    """场景里节点的排队超时有上限（#559）：排队截止时间要是有效的时间；和控制面同一句话。"""
    document = {
        "nodes": [
            {"id": "entry", "kind": "entry"},
            {
                "id": "wait",
                "kind": "package",
                "package": "p",
                "node": "n",
                "display_name": "等槽位",
                "queue_timeout": queue_timeout,
            },
        ]
    }

    problems = _document_problems(document)

    assert problems == [
        "  nodes/1/queue_timeout（节点 wait）: 节点 等槽位（wait）：queue_timeout 必须是 1 到 "
        f"4294967295 之间的正整数（秒），实际是 {queue_timeout}"
    ]


def test_a_node_queue_timeout_at_the_limit_is_accepted() -> None:
    document = {
        "nodes": [
            {"id": "entry", "kind": "entry"},
            {
                "id": "wait",
                "kind": "package",
                "package": "p",
                "node": "n",
                "queue_timeout": 4_294_967_295,
            },
        ]
    }

    assert _document_problems(document) == []


def test_timeout_and_queue_timeout_over_the_limit_are_each_reported_with_their_own_field() -> None:
    document = {
        "nodes": [
            {"id": "entry", "kind": "entry"},
            {
                "id": "both",
                "kind": "package",
                "package": "p",
                "node": "n",
                "timeout": 5_000_000_000,
                "queue_timeout": 6_000_000_000,
            },
        ]
    }

    problems = _document_problems(document)

    assert len(problems) == 2
    assert "both：queue_timeout 必须是 1 到 4294967295" in problems[0]
    assert "both：timeout 必须是 1 到 4294967295" in problems[1]


# ---- 节点的 timeout、queue_timeout 写了不合格的值（#576） ----
# 保存、检查（控制面，packages/schema 的 invalidDocumentMessage）和这里的本地检查说同一句话，共用
# testdata/node-timeout-value-cases.json；TypeScript 一端在
# packages/schema/test/node-timeout-values.test.ts。

VALUE_CASES: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "testdata" / "node-timeout-value-cases.json").read_text(
        "utf-8"
    )
)


def _sentence(label: str, field: str, actual: str) -> str:
    """期望的句子：字面写出来，不用实现里的函数拼。"""
    return (
        f"节点 {label}：{field} 必须是 1 到 {VALUE_CASES['max_seconds']} 之间的正整数（秒），"
        f"实际是 {actual}"
    )


def _package_document(node: dict[str, Any]) -> dict[str, Any]:
    return {
        "nodes": [
            {"id": "entry", "kind": "entry"},
            {"kind": "package", "package": "p", "node": "n", **node},
        ]
    }


@pytest.mark.parametrize("field", VALUE_CASES["fields"])
@pytest.mark.parametrize("case", VALUE_CASES["values"], ids=lambda c: c["name"])
def test_an_invalid_timeout_value_is_reported_with_the_same_sentence_as_the_control_plane(
    field: str, case: dict[str, Any]
) -> None:
    problems = _document_problems(_package_document({"id": "a", field: case["value"]}))

    assert problems == [f"  nodes/1/{field}（节点 a）: {_sentence('a', field, case['actual'])}"]


@pytest.mark.parametrize("case", VALUE_CASES["labels"], ids=lambda c: c["label"])
def test_the_sentence_names_the_node_by_display_name_and_id(case: dict[str, Any]) -> None:
    problems = _document_problems(_package_document({**case["node"], "queue_timeout": 0}))

    assert problems == [
        f"  nodes/1/queue_timeout（节点 a）: {_sentence(case['label'], 'queue_timeout', '0')}"
    ]


def test_valid_values_next_to_an_invalid_one_are_not_reported() -> None:
    problems = _document_problems(
        _package_document({"id": "a", "timeout": 4_294_967_295, "queue_timeout": 0})
    )

    assert problems == [
        f"  nodes/1/queue_timeout（节点 a）: {_sentence('a', 'queue_timeout', '0')}"
    ]


def test_the_json_schema_limits_are_the_ones_the_sentence_names() -> None:
    """句子里写的上限和导出给本地检查的 JSON Schema 里的 `maximum` 是同一个数（两个字段都是）。"""
    from sfly.schemas import load_schema

    nodes = load_schema("orchestration-document")["properties"]["nodes"]["items"]["oneOf"]
    package = next(n for n in nodes if "queue_timeout" in n.get("properties", {}))
    for field in VALUE_CASES["fields"]:
        assert package["properties"][field]["maximum"] == VALUE_CASES["max_seconds"], field
