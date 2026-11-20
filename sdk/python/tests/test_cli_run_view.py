"""命令行里的状态用词、子流程的空名称写法和界面一致：界面改了用词，这里的测试会失败。"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from sfly.cli.removed_document_fields import REMOVED_DOCUMENT_FIELDS, removed_fields_message
from sfly.cli.removed_nodes import REMOVED_NODE_KINDS, removed_kind_label
from sfly.cli.run_view import (
    NODE_STATUS_LABEL,
    RUN_STATUS_LABEL,
    UNNAMED_SUBFLOW,
    format_duration,
    node_type_label,
)

REPO = Path(__file__).resolve().parents[3]


def _web(path: str) -> str:
    return (REPO / "apps/web/src" / path).read_text(encoding="utf-8")


def test_node_status_words_are_the_ones_the_console_shows() -> None:
    found = re.findall(r'\n\t(\w+): \{\n\t\tlabel: "([^"]+)"', _web("lib/node-status.ts"))
    assert found, "没有从 lib/node-status.ts 里读到节点状态的中文标签"
    assert NODE_STATUS_LABEL == dict(found)


def test_run_status_words_are_the_ones_the_console_shows() -> None:
    block = re.search(r"RUN_STATUS_LABEL[^{]*\{(.*?)\n\};", _web("lib/copy.ts"), re.DOTALL)
    assert block, "没有从 lib/copy.ts 里读到 RUN_STATUS_LABEL"
    assert RUN_STATUS_LABEL == dict(re.findall(r'(\w+): "([^"]+)"', block[1]))


def test_unnamed_subflow_is_written_the_way_the_console_writes_it() -> None:
    source = (REPO / "packages/orchestration/src/chain-label.ts").read_text(encoding="utf-8")
    found = re.search(r'UNNAMED_SUBFLOW_LABEL = "([^"]+)"', source)
    assert found
    assert UNNAMED_SUBFLOW == found[1]


def test_durations_are_written_one_way_in_every_command() -> None:
    assert [
        format_duration(ms) for ms in (None, 16, 999, 1000, 9_949, 12_400, 185_000, 3_725_000)
    ] == ["-", "16ms", "999ms", "1.0s", "9.9s", "12s", "3m05s", "1h02m"]


def test_node_types_are_named_by_kind_and_package() -> None:
    assert node_type_label({"kind": "entry"}) == "入口"
    assert node_type_label({"kind": "stop_subflow"}) == "停止子流程"
    assert node_type_label({"kind": "package", "package": "stub", "node": "echo"}) == "stub/echo"
    # 只知道种类（读不到场景版本）时，包节点写 package
    assert node_type_label({"kind": "package"}) == "package"


@pytest.mark.parametrize("kind", ["feishu_notify", "timer", "sleep"])
def test_a_removed_node_kind_is_named_the_way_the_control_plane_names_it(kind: str) -> None:
    """已移除的种类（ADR 0028：feishu_notify、timer、sleep）在历史版本和历史运行里还留着：写成
    「已移除的节点类型 <种类名>」，和控制面的 removedKindLabel 一致。"""
    assert node_type_label({"kind": kind}) == f"已移除的节点类型 {kind}"
    assert removed_kind_label(kind) == f"已移除的节点类型 {kind}"


def test_an_unknown_node_kind_is_named_as_it_is() -> None:
    """不认识的种类原样写种类名；已移除的种类的写法和控制面的 removedKindLabel 是同一个模板。"""
    assert node_type_label({"kind": "some_future_kind"}) == "some_future_kind"
    source = (REPO / "packages/schema/src/removed-nodes.ts").read_text(encoding="utf-8")
    assert "`已移除的节点类型 ${kind}`" in source


def test_the_removed_kinds_are_the_ones_the_control_plane_registers() -> None:
    """命令行读控制面的 REMOVED_NODE_KINDS 导出的 JSON（`pnpm gen`），不另写一份：
    种类名、原来的名称、替换办法逐项一致，不会有一项被漏掉。"""
    source = (REPO / "packages/schema/src/removed-nodes.ts").read_text(encoding="utf-8")
    body = source[source.index("export const REMOVED_NODE_KINDS") :].split("} as const", 1)[0]
    registered = re.findall(r"^\t(\w+): \{$", body, re.MULTILINE)
    assert registered, "没有从 removed-nodes.ts 里读到已移除的种类"
    assert sorted(REMOVED_NODE_KINDS) == sorted(registered)
    for label, replacement in REMOVED_NODE_KINDS.values():
        assert label
        assert replacement


def test_the_removed_document_fields_are_the_ones_the_control_plane_registers() -> None:
    """命令行读控制面的 REMOVED_DOCUMENT_FIELDS 导出的 JSON（`pnpm gen`），不另写一份：
    字段名、名称、替换办法逐项和 removed-document-fields.ts 里登记的一致；
    拒绝保存时的那一句话（removedFieldsMessage）和命令行本地检查的用同一个句式。"""
    source = (REPO / "packages/schema/src/removed-document-fields.ts").read_text(encoding="utf-8")
    body = source[source.index("export const REMOVED_DOCUMENT_FIELDS") :].split("} as const", 1)[0]
    registered = {
        field: (label, replacement)
        for field, label, replacement in re.findall(
            r'^\t(\w+): \{\n\t\tlabel: "([^"]+)",\n\t\treplacement: "([^"]+)",\n\t\},$',
            body,
            re.MULTILINE,
        )
    }
    assert registered, "没有从 removed-document-fields.ts 里读到已移除的字段"
    assert REMOVED_DOCUMENT_FIELDS == registered
    assert (
        "`场景文档里的 ${named}已不再支持，先把这一项删掉再保存。替换办法：${advice}`" in source
    ), "removedFieldsMessage 的句式变了：命令行的 removed_fields_message 要跟着改"
    assert removed_fields_message(["sticky_notes"]) == (
        "场景文档里的 sticky_notes（便签）已不再支持，先把这一项删掉再保存。"
        "替换办法：便签：要留的内容写进节点的备注或注释框的备注"
    )
