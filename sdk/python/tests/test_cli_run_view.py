"""命令行里的状态用词、子流程的空名称写法和界面一致：界面改了用词，这里的测试会失败。"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from sfly.cli.removed_document_fields import (
    REMOVED_DOCUMENT_FIELDS,
    removed_fields_message,
    removed_fields_with_content,
)
from sfly.cli.removed_nodes import REMOVED_NODE_KINDS, removed_kind_label
from sfly.cli.run_view import (
    NODE_STATUS_LABEL,
    RUN_STATUS_LABEL,
    UNNAMED_SUBFLOW,
    format_duration,
    node_type_label,
    queue_wait_text,
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


# ---------------------------------------------------------------- 排队中的节点在等什么

NOW = "2026-01-01T00:05:00.000Z"
QUEUED_AT = "2026-01-01T00:01:55.000Z"  # 排了 3m05s


def _wait(**fields: object) -> dict[str, object]:
    return {
        "agent": "agent-a",
        "now": NOW,
        "state": "offline",
        "since": None,
        "expires_at": None,
        "slots": None,
        "holders": [],
        "other_project_holders": 0,
        **fields,
    }


def test_a_queued_node_on_an_offline_agent_says_who_how_long_and_when_it_times_out() -> None:
    wait = _wait(since="2026-01-01T00:02:50.000Z", expires_at="2026-01-01T00:11:55.000Z")
    assert queue_wait_text(wait, QUEUED_AT) == (
        "等 agent-a（不在线，已离线 2m10s）· 排队 3m05s · 6m55s 后超时"
    )


def test_a_disabled_agent_says_disabled_and_for_how_long_not_offline() -> None:
    wait = _wait(
        state="disabled", since="2026-01-01T00:02:50.000Z", expires_at="2026-01-01T00:11:55.000Z"
    )
    text = queue_wait_text(wait, QUEUED_AT)
    assert text == "等 agent-a（已停用 2m10s）· 排队 3m05s · 6m55s 后超时"
    assert "不在线" not in text


def test_a_state_this_cli_has_not_seen_is_written_as_it_is_not_guessed_as_dispatching() -> None:
    """比命令行新的控制面可能带没见过的状态：写出状态名，不说「正在派发」（说错了会让人以为马上开始）。"""
    text = queue_wait_text(_wait(state="quarantined"), QUEUED_AT)
    assert text == "等 agent-a（quarantined）· 排队 3m05s"
    assert "正在派发" not in text


def test_no_last_seen_time_and_no_queue_timeout_means_nothing_to_count_down() -> None:
    assert queue_wait_text(_wait(), QUEUED_AT) == "等 agent-a（不在线）· 排队 3m05s"


def test_past_the_deadline_the_control_plane_has_not_swept_yet_says_about_to_time_out() -> None:
    wait = _wait(expires_at="2026-01-01T00:04:59.000Z")
    assert queue_wait_text(wait, QUEUED_AT).endswith("· 即将超时")


def test_an_agent_preparing_its_environment_says_for_how_long() -> None:
    wait = _wait(state="preparing", since="2026-01-01T00:03:50.000Z", slots=4)
    assert queue_wait_text(wait, QUEUED_AT) == "等 agent-a（准备环境中 1m10s）· 排队 3m05s"


def test_a_version_mismatch_says_no_new_tasks_are_dispatched() -> None:
    wait = _wait(state="version_mismatch", slots=4)
    assert queue_wait_text(wait, QUEUED_AT) == (
        "等 agent-a（版本与控制面不一致，不派新任务）· 排队 3m05s"
    )


def _holder(
    node: str, chain_name: str | None = None, display_name: str | None = None
) -> dict[str, object]:
    return {
        "run_id": "5e2d1c7a-0000-4000-8000-000000000001",
        "orchestration_id": "00000000-0000-4000-8000-0000000000f1",
        "orchestration_name": "撮合压测",
        "node_id": node,
        **({"display_name": display_name} if display_name else {}),
        "chain_name": chain_name,
        "attempt": 1,
        "status": "running",
        "started_at": "2026-01-01T00:00:00.000Z",
    }


def test_full_slots_name_the_tasks_holding_them_at_most_three() -> None:
    holders = [
        _holder("soak", display_name="浸泡"),
        _holder("probe", chain_name="监控"),
        _holder("report"),
        _holder("cleanup"),
        _holder("verify"),
    ]
    wait = _wait(state="slots_full", slots=5, holders=holders)
    assert queue_wait_text(wait, QUEUED_AT) == (
        "等 agent-a（槽位占满，5 / 5）· 排队 3m05s；占着槽位的任务："
        "撮合压测（运行 5e2d1c7a）的 main:soak「浸泡」、撮合压测（运行 5e2d1c7a）的 监控:probe、"
        "撮合压测（运行 5e2d1c7a）的 main:report，还有 2 个"
    )


def test_slots_held_by_other_projects_are_only_a_count() -> None:
    own = _wait(
        state="slots_full",
        slots=3,
        holders=[_holder("soak", display_name="浸泡")],
        other_project_holders=2,
    )
    assert queue_wait_text(own, QUEUED_AT).endswith(
        "；占着槽位的任务：撮合压测（运行 5e2d1c7a）的 main:soak「浸泡」，另有别的项目的任务 2 个"
    )
    only_others = _wait(state="slots_full", slots=2, other_project_holders=2)
    assert queue_wait_text(only_others, QUEUED_AT).endswith("；占着槽位的任务：别的项目的任务 2 个")


def test_waiting_words_are_the_ones_the_console_shows() -> None:
    """界面（copy.ts 的 QUEUE_WAIT 和 agents/queue-timing.ts）和命令行用同样的话。"""
    copy = _web("lib/copy.ts") + _web("agents/queue-timing.ts")
    for phrase in (
        "已停用",
        "不在线",
        "已离线",
        "准备环境中",
        "版本与控制面不一致，不派新任务",
        "槽位占满",
        "正在派发",
        "占着槽位的任务",
        "后超时",
        "即将超时",
    ):
        assert phrase in copy, f"界面里没有「{phrase}」"


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
    template = (
        "`场景文档里的 ${named}，已不再支持，不能保存：先把要留的内容挪走，再把这一项删掉。"
        "替换办法：${advice}`"
    )
    assert template in source, (
        "removedFieldsMessage 的句式变了：命令行的 removed_fields_message 要跟着改"
    )
    assert removed_fields_message([("sticky_notes", 2)]) == (
        "场景文档里的 sticky_notes（便签）有 2 条内容，已不再支持，不能保存："
        "先把要留的内容挪走，再把这一项删掉。"
        "替换办法：便签：要留的内容写进节点的备注或注释框的备注"
    )
    assert "有 ${c.count} 条内容" in source, "句式里「有几条」的写法变了：命令行要跟着改"


def test_removed_fields_with_content_follows_the_control_plane_rule() -> None:
    """有内容才算：空数组、null、没有的不算；不是数组的值算 1 条
    （和控制面的 removedFieldsWithContent 一致）。"""
    assert removed_fields_with_content({"sticky_notes": [1, 2, 3]}) == [("sticky_notes", 3)]
    assert removed_fields_with_content({"sticky_notes": "x"}) == [("sticky_notes", 1)]
    documents: list[object] = [
        {"sticky_notes": []},
        {"sticky_notes": None},
        {},
        [],
        None,
        3,
    ]
    for document in documents:
        assert removed_fields_with_content(document) == []
