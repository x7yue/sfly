"""命令行里运行的写法：完整 id、id 的前缀、latest。

前缀对应几个运行、找不到、太短时的错误都给出下一步。
"""

from __future__ import annotations

from typing import Any

import pytest

from sfly.cli.errors import CliError
from sfly.cli.run_view import MIN_RUN_PREFIX, resolve_run

A = "3f9a1c2e-7b4d-4a55-9c1e-0d2b6a8e4f10"
B = "3f9a77d0-1c2e-4b93-8a6f-5e4d3c2b1a09"
C = "b61739b6-0939-40d3-9692-f8ae81ebaf2a"


def item(
    run_id: str, by: str = "alice", started: str = "2026-01-01T00:00:00.000Z"
) -> dict[str, Any]:
    return {
        "id": run_id,
        "orchestration_name": "巡检",
        "status": "success",
        "triggered_by": by,
        "started_at": started,
    }


class FakeClient:
    """只回答 `GET /runs`：按 `q` 筛选运行编号前缀（和触发人包含），和控制面一样。"""

    def __init__(self, runs: list[dict[str, Any]], nickname: str = "alice") -> None:
        self.runs = runs
        self.nickname = nickname
        self.requests: list[tuple[str, dict[str, Any]]] = []

    def get(self, path: str, query: dict[str, Any] | None = None) -> Any:
        query = query or {}
        self.requests.append((path, query))
        assert path == "/runs"
        q = str(query["q"]).lower()
        found = [r for r in self.runs if r["id"].startswith(q) or q in r["triggered_by"].lower()]
        return {"runs": found, "counts": {}}


def client(runs: list[dict[str, Any]], nickname: str = "alice") -> Any:
    return FakeClient(runs, nickname)


def test_a_full_id_is_returned_as_written_without_asking_the_control_plane() -> None:
    fake = FakeClient([])
    assert resolve_run(fake, A.upper()) == A.upper()  # type: ignore[arg-type]
    assert fake.requests == []


def test_a_unique_prefix_gives_the_full_id() -> None:
    fake = client([item(A), item(C)])
    assert resolve_run(fake, "3f9a1c") == A
    assert resolve_run(fake, "3F9A1C2E-7B") == A
    assert resolve_run(fake, "b617") == C


def test_a_prefix_matching_several_runs_lists_them_and_asks_for_more_characters() -> None:
    fake = client([item(A), item(B), item(C)])
    with pytest.raises(CliError) as caught:
        resolve_run(fake, "3f9a")
    error = caught.value
    assert error.code == "run_ambiguous"
    assert error.next == "sfly run list"
    assert (
        error.message.splitlines()[0]
        == "运行编号前缀 3f9a 对应 2 个运行，多写几位，或用完整的 id："
    )
    assert f"  {A}  巡检  成功  2026-01-01T00:00:00.000Z" in error.message
    assert B in error.message
    assert C not in error.message


def test_a_prefix_that_matches_nothing_or_is_too_short_or_is_not_hex_is_run_not_found() -> None:
    fake = client([item(A)])
    for ref in ("ffff", "3f9", "zzzzzzzz", "", "3f9a 1c"):
        with pytest.raises(CliError) as caught:
            resolve_run(fake, ref)
        assert caught.value.code == "run_not_found"
        assert caught.value.next == "sfly run list"
    assert MIN_RUN_PREFIX == 4


def test_a_username_that_contains_the_prefix_does_not_make_it_ambiguous() -> None:
    # `GET /runs?q=` 也按触发人包含匹配：昵称里有 beef 的人触发的运行，不算「编号以 beef 开头」。
    other = "11111111-2222-4333-8444-555555555555"
    fake = client([item(other, by="beefy"), item("beef0000-0000-4000-8000-000000000000")])
    assert resolve_run(fake, "beef") == "beef0000-0000-4000-8000-000000000000"


def test_latest_is_the_most_recent_run_the_caller_started_not_someone_elses() -> None:
    fake = client(
        [
            item(B, by="bob"),
            item(A, by="alice"),
            item(C, by="alice", started="2025-12-31T00:00:00.000Z"),
        ]
    )
    assert resolve_run(fake, "latest") == A
    assert resolve_run(fake, "最近") == A
    assert fake.requests[0] == ("/runs", {"q": "alice", "limit": 500})


def test_latest_ignores_runs_by_users_whose_name_contains_the_nickname() -> None:
    fake = client([item(B, by="alice-bot"), item(A, by="alice")])
    assert resolve_run(fake, "latest") == A


def test_latest_without_any_run_of_ones_own_says_how_to_find_runs() -> None:
    with pytest.raises(CliError) as caught:
        resolve_run(client([item(B, by="bob")]), "latest")
    assert caught.value.code == "no_recent_run"
    assert "alice" in caught.value.message
    assert caught.value.next == "sfly run list"


def test_latest_is_refused_where_it_could_cancel_the_wrong_run() -> None:
    fake = client([item(A)])
    with pytest.raises(CliError) as caught:
        resolve_run(fake, "latest", allow_latest=False)
    assert caught.value.code == "invalid_arguments"
    assert fake.requests == []
    # 前缀照常可以用。
    assert resolve_run(fake, "3f9a", allow_latest=False) == A
