"""运行视图里大的输出只给大小（#633）：`describe_outputs` 把这样的节点列出来（内容是 None），
`_with_full_outputs` 只对要显示的那些取全文（`GET /tasks/<任务>/io`）；没有输出的节点不取。"""

from __future__ import annotations

from typing import Any

from sfly.cli.run_results import _with_full_outputs, describe_outputs


def _attempt(task_id: str, attempt: int = 1) -> dict[str, Any]:
    return {"task_id": task_id, "attempt": attempt, "status": "success"}


def _node(
    node_id: str,
    outputs: dict[str, Any] | None,
    omitted: int | None,
    attempts: list[dict[str, Any]],
    status: str = "success",
) -> dict[str, Any]:
    return {
        "node_id": node_id,
        "kind": "package",
        "status": status,
        "outputs": outputs,
        "outputs_omitted_bytes": omitted,
        "attempts": attempts,
    }


def _run(nodes: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "chains": [
            {
                "id": "chain-1",
                "chain_id": "entry",
                "name": None,
                "depth": 0,
                "nodes": [{"node_id": "entry", "kind": "entry", "attempts": [], "outputs": None}]
                + nodes,
            }
        ]
    }


class _Client:
    """记下取了哪些任务的全文。"""

    def __init__(self, full: dict[str, dict[str, Any] | None]) -> None:
        self.full = full
        self.asked: list[str] = []

    def get(self, path: str) -> dict[str, Any]:
        task = path.removeprefix("/tasks/").removesuffix("/io")
        self.asked.append(task)
        return {"task_id": task, "inputs": {}, "outputs": self.full[task]}


def test_omitted_outputs_are_listed_with_no_content_and_fetched_only_for_shown_rows() -> None:
    run = _run(
        [
            _node("small", {"ok": True}, None, [_attempt("t-small")]),
            _node("big", None, 40960, [_attempt("t-big-1", 1), _attempt("t-big-2", 2)]),
            _node("big2", None, 20480, [_attempt("t-big2")]),
            _node("none", None, None, [_attempt("t-none")], status="failed"),
        ]
    )

    rows = describe_outputs(run, None)

    # 没有内容也没被省略的（失败的节点）不在里面；被省略的在里面，内容是 None，任务是最后一次尝试。
    assert [(r["node"], r["outputs"], r["task"]) for r in rows] == [
        ("small", {"ok": True}, "t-small"),
        ("big", None, "t-big-2"),
        ("big2", None, "t-big2"),
    ]
    client = _Client({"t-big-2": {"text": "x" * 40_000}, "t-big2": {"text": "y"}})
    shown = _with_full_outputs(client, rows[:2])
    assert [r["outputs"] for r in shown] == [{"ok": True}, {"text": "x" * 40_000}]
    # 只取要显示的、被省略的那一个：没被省略的不取，没显示的（--limit 之外）也不取。
    assert client.asked == ["t-big-2"]


def test_an_omitted_output_that_is_gone_when_fetched_is_left_out() -> None:
    rows = describe_outputs(_run([_node("big", None, 20480, [_attempt("t")])]), None)

    assert _with_full_outputs(_Client({"t": None}), rows) == []
