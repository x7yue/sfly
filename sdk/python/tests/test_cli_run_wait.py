"""`run start --wait` 的进度行：排队中的节点写在等什么，等的情况变了再写一行，没变时隔一阵重写。"""

from __future__ import annotations

from typing import Any

from sfly.cli.run_wait import QUEUE_REPEAT_SECONDS, _Progress

NOW = "2026-01-01T00:05:00.000Z"
QUEUED_AT = "2026-01-01T00:04:55.000Z"


def _wait(state: str = "offline", holders: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "agent": "agent-a",
        "now": NOW,
        "state": state,
        "since": "2026-01-01T00:03:00.000Z" if state == "offline" else None,
        "expires_at": "2026-01-01T00:09:55.000Z",
        "slots": None if state == "offline" else 1,
        "holders": holders or [],
        "other_project_holders": 0,
    }


def _run(status: str, wait: dict[str, Any] | None) -> dict[str, Any]:
    attempt = {
        "attempt": 1,
        "status": status,
        "queued_at": QUEUED_AT,
        "started_at": None,
        "ended_at": None,
        "queue_wait": wait,
    }
    node = {
        "node_id": "a",
        "display_name": "准备环境",
        "kind": "package",
        "status": status,
        "attempts": [attempt],
    }
    return {"chains": [{"id": "c1", "name": None, "nodes": [node]}]}


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_a_queued_node_is_written_with_what_it_waits_for_and_only_again_when_that_changes() -> None:
    lines: list[str] = []
    clock = _Clock()
    progress = _Progress(lines.append, clock)

    progress.update(_run("queued", _wait()))
    assert lines == [
        "main:a「准备环境」 排队中：等 agent-a（不在线，已离线 2m00s）· 排队 5.0s · 4m55s 后超时"
    ]
    assert progress.queued

    # 等的情况没变（只是时间过去了）：不重复写。
    clock.now = 30
    progress.update(_run("queued", _wait()))
    assert len(lines) == 1

    # Agent 上线了、槽位被占满：等的情况变了，再写一行。
    holder = {
        "run_id": "5e2d1c7a-0000-4000-8000-000000000001",
        "orchestration_id": "o1",
        "orchestration_name": "压测",
        "node_id": "soak",
        "chain_name": None,
        "attempt": 1,
        "status": "running",
        "started_at": None,
    }
    clock.now = 40
    progress.update(_run("queued", _wait("slots_full", [holder])))
    assert len(lines) == 2
    assert "等 agent-a（槽位占满，1 / 1）" in lines[1]
    assert "占着槽位的任务：压测（运行 5e2d1c7a）的 main:soak" in lines[1]

    # 派发之后不再排队。
    progress.update(_run("dispatched", None))
    assert lines[-1] == "main:a「准备环境」 准备中"
    assert not progress.queued


def test_a_node_still_waiting_for_the_same_thing_is_written_again_after_a_while() -> None:
    lines: list[str] = []
    clock = _Clock()
    progress = _Progress(lines.append, clock)
    progress.update(_run("queued", _wait()))
    clock.now = QUEUE_REPEAT_SECONDS - 1
    progress.update(_run("queued", _wait()))
    assert len(lines) == 1
    clock.now = QUEUE_REPEAT_SECONDS
    progress.update(_run("queued", _wait()))
    assert len(lines) == 2
