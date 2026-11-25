"""`sfly run logs`：控制面的页里说明有任务的日志文件不在了、变短了，命令行读到时说出来（#721）。

控制面在运行页里带 `file_problems`（范围内有问题的任务，最多 20 个）和
`file_problems_total`。命令行：
- 跨页汇总（同一个任务只算一次，总数取各页里最大的）；
- 说明写到标准错误，标准输出里只有日志行；`--json` 时标准错误里是一行 JSON
  （`file_problems`、`file_problems_total`）；
- 退出码不变（读到的是真的、剩下的内容；下载没下完才报错）；
- 没有日志行时不再说成「没有日志」。
这里用一个假的控制面客户端，页的内容直接给定。
"""

from __future__ import annotations

import argparse
import io
import json
from types import SimpleNamespace
from typing import Any

from sfly.cli.output import Output
from sfly.cli.run_logs import DEFAULT_TAIL, Selection, _logs, read_logs

RUN = "11111111-1111-4111-8111-111111111111"
CHAIN = "22222222-2222-4222-8222-222222222222"
TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TASK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


def _run_view() -> dict[str, Any]:
    def node(node_id: str, task: str) -> dict[str, Any]:
        return {
            "node_id": node_id,
            "kind": "package",
            "attempts": [{"task_id": task, "status": "success"}],
        }

    return {
        "id": RUN,
        "chains": [
            {"id": CHAIN, "name": None, "nodes": [node("a", TASK_A), node("b", TASK_B)]},
        ],
    }


def _line(task: str, node_id: str, seq: int) -> dict[str, Any]:
    return {
        "seq": seq,
        "time": f"2026-01-01T00:00:0{seq}.000Z",
        "agent_time": None,
        "source": "stdout",
        "level": "info",
        "text": f"{node_id} 第 {seq} 行",
        "task_id": task,
        "chain_instance_id": CHAIN,
        "subflow": None,
        "node_id": node_id,
        "attempt": 1,
    }


def _problem(task: str, node_id: str, problem: str) -> dict[str, Any]:
    return {
        "task_id": task,
        "chain_instance_id": CHAIN,
        "subflow": None,
        "node_id": node_id,
        "attempt": 1,
        "problem": problem,
    }


def _page(
    lines: list[dict[str, Any]],
    problems: list[dict[str, Any]],
    *,
    total: int | None = None,
    reached_start: bool = True,
    before: str = "b0",
) -> dict[str, Any]:
    return {
        "run_id": RUN,
        "lines": lines,
        "before": before,
        "after": "a0",
        "reached_start": reached_start,
        "reached_end": True,
        "live_after": "l0",
        "truncated_tasks": [],
        "expired": False,
        "file_problems": problems,
        "file_problems_total": len(problems) if total is None else total,
    }


class FakeClient:
    """`/runs/<id>` 给运行视图，`/runs/<id>/logs` 按顺序给定好的页。"""

    def __init__(self, *pages: dict[str, Any]) -> None:
        self.pages = list(pages)
        self.calls: list[dict[str, Any]] = []

    def get(self, path: str, query: dict[str, Any] | None = None) -> dict[str, Any]:
        if path == f"/runs/{RUN}":
            return _run_view()
        assert path == f"/runs/{RUN}/logs", path
        self.calls.append(dict(query or {}))
        return self.pages.pop(0)


def _args(**over: Any) -> argparse.Namespace:
    options: dict[str, Any] = {
        "run": RUN,
        "all": None,
        "failed": False,
        "node": None,
        "level": None,
        "before": None,
        "after": None,
        "tail": DEFAULT_TAIL,
    }
    return argparse.Namespace(**{**options, **over})


def _run_logs(client: FakeClient, *, json_mode: bool) -> tuple[str, str]:
    stdout, stderr = io.StringIO(), io.StringIO()
    session = SimpleNamespace(
        client=client, out=Output(json_mode=json_mode, stdout=stdout, stderr=stderr)
    )
    _logs(session, _args())  # type: ignore[arg-type]
    return stdout.getvalue(), stderr.getvalue()


def test_problems_are_collected_across_pages_once_per_task() -> None:
    first = _page(
        [_line(TASK_A, "a", 1)],
        [_problem(TASK_B, "b", "missing")],
        total=3,
        reached_start=False,
    )
    second = _page(
        [_line(TASK_A, "a", 2)],
        [_problem(TASK_B, "b", "missing"), _problem(TASK_A, "a", "short")],
        total=3,
    )
    client = FakeClient(first, second)

    read = read_logs(
        client,  # type: ignore[arg-type]
        RUN,
        Selection(nodes=None, task_ids=None),
        tail=100,
        level=None,
        before=None,
        after=None,
    )

    assert [p["task_id"] for p in read.file_problems] == [TASK_B, TASK_A]
    assert read.file_problems_total == 3
    assert len(client.calls) == 2


def test_the_note_goes_to_stderr_and_stdout_has_only_log_lines() -> None:
    client = FakeClient(_page([_line(TASK_A, "a", 1)], [_problem(TASK_B, "b", "missing")]))

    stdout, stderr = _run_logs(client, json_mode=False)

    assert stdout.strip().splitlines() == [stdout.strip()]
    assert "a 第 1 行" in stdout
    assert "注意" not in stdout
    assert "main:b" in stderr
    assert "不在了" in stderr
    # 来路和以后的下载都写明（和下载的 410 同一套说法）。
    assert "掉电" in stderr


def test_a_shorter_file_is_named_as_shorter() -> None:
    client = FakeClient(_page([_line(TASK_A, "a", 1)], [_problem(TASK_B, "b", "short")]))

    _, stderr = _run_logs(client, json_mode=False)

    assert "main:b" in stderr
    assert "比记录的短" in stderr


def test_more_problems_than_listed_are_counted() -> None:
    client = FakeClient(_page([], [_problem(TASK_B, "b", "missing")], total=25))

    _, stderr = _run_logs(client, json_mode=False)

    assert "25" in stderr


def test_no_log_lines_is_not_reported_as_no_logs() -> None:
    client = FakeClient(
        _page([], [_problem(TASK_A, "a", "missing"), _problem(TASK_B, "b", "missing")])
    )

    stdout, stderr = _run_logs(client, json_mode=False)

    assert "没有日志" not in stdout
    assert stdout.strip() == ""
    assert "不在了" in stderr


def test_json_mode_keeps_stdout_to_log_lines_and_writes_the_problems_as_one_json_line() -> None:
    client = FakeClient(_page([_line(TASK_A, "a", 1)], [_problem(TASK_B, "b", "short")], total=4))

    stdout, stderr = _run_logs(client, json_mode=True)

    rows = [json.loads(line) for line in stdout.splitlines()]
    assert [row["task_id"] for row in rows] == [TASK_A]
    notes = [json.loads(line) for line in stderr.splitlines() if line.startswith("{")]
    assert notes == [
        {"file_problems": [_problem(TASK_B, "b", "short")], "file_problems_total": 4},
    ]


def test_nothing_is_written_when_there_is_no_problem() -> None:
    client = FakeClient(_page([_line(TASK_A, "a", 1)], []))

    stdout, stderr = _run_logs(client, json_mode=False)

    assert "a 第 1 行" in stdout
    assert stderr == ""
