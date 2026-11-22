"""连到没有 `queue_wait` 字段的旧控制面：运行视图的尝试里没有这个键。

`run show`、`run start --wait` 照常工作，只是不写排队说明（命令行对旧控制面一向降级，不报错）。
"""

from __future__ import annotations

import json
from typing import Any

from sfly.cli.run_query import describe, render
from sfly.cli.run_wait import _Progress

QUEUED_AT = "2026-01-01T00:04:55.000Z"


def _run(status: str) -> dict[str, Any]:
    """旧控制面返回的运行视图：尝试里没有 `queue_wait` 这个键。"""
    attempt = {
        "task_id": "t1",
        "attempt": 1,
        "status": status,
        "agent": "agent-a",
        "queued_at": QUEUED_AT,
        "started_at": None,
        "ended_at": None,
        "error": None,
    }
    node = {
        "node_id": "a",
        "display_name": "准备环境",
        "kind": "package",
        "status": status,
        "agent": "agent-a",
        "error": None,
        "attempts": [attempt],
    }
    return {
        "id": "00000000-0000-4000-8000-000000000001",
        "orchestration_id": "00000000-0000-4000-8000-0000000000f1",
        "orchestration_version": 1,
        "status": "running",
        "triggered_by": "tester",
        "triggered_via": None,
        "preset": None,
        "params": {},
        "started_at": "2026-01-01T00:04:00.000Z",
        "ended_at": None,
        "cancel": None,
        "chains": [
            {
                "id": "c1",
                "name": None,
                "depth": 0,
                "status": "running",
                "started_at": "2026-01-01T00:04:00.000Z",
                "ended_at": None,
                "nodes": [node],
            }
        ],
    }


def test_run_show_text_and_json_work_against_a_server_without_queue_wait() -> None:
    view = describe(_run("queued"), "回归场景")
    attempt = view["chains"][0]["nodes"][0]["attempts"][0]
    assert "queue_wait" not in attempt
    json.dumps(view)  # --json 的输出
    text = render(view)
    assert "a「准备环境」  排队中" in text
    assert "排队中的节点" not in text  # 没有说明可写，不写这一段


def test_run_start_wait_progress_works_against_a_server_without_queue_wait() -> None:
    lines: list[str] = []
    progress = _Progress(lines.append, lambda: 0.0)
    progress.update(_run("queued"))
    assert lines == ["main:a「准备环境」 排队中"]
    assert not progress.queued  # 没有 queue_wait：不当作「还在等」，不为它定时重新读取
    progress.update(_run("dispatched"))
    assert lines[-1] == "main:a「准备环境」 准备中"
