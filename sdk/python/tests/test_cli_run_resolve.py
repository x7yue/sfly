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


S1 = "0b7e6a52-2d0c-4f7e-9d43-6a1f0c2e9b11"
S2 = "5c1d9e40-8a3b-4c6d-b2f1-7e9a0d4c3b22"


def item(
    run_id: str,
    by: str = "alice",
    started: str = "2026-01-01T00:00:00.000Z",
    session: str | None = None,
) -> dict[str, Any]:
    run: dict[str, Any] = {
        "id": run_id,
        "orchestration_name": "巡检",
        "status": "success",
        "triggered_by": by,
        "started_at": started,
    }
    if session is not None:
        run["session"] = {"id": session, "title": "会话"}
    return run


class FakeClient:
    """只回答 `GET /runs`，和控制面一样：`id_prefix` 只看编号前缀，`triggered_by` 要昵称整个相等，
    `q` 按编号前缀或触发人包含匹配；`limit` 取最近的几个（`runs` 已经是从新到旧）。
    `session_id` 只要那个会话触发的。
    `old=True` 模仿比命令行旧的控制面：不认 `id_prefix`、`triggered_by`、`session_id`，当没给。
    `session_token=True` 模仿带着会话令牌，`session_id` 是 `SFLY_SESSION_ID`。"""

    def __init__(
        self,
        runs: list[dict[str, Any]],
        nickname: str = "alice",
        *,
        old: bool = False,
        session_token: bool = False,
        session_id: str | None = None,
    ) -> None:
        self.runs = runs
        self.nickname = nickname
        self.old = old
        self.session_token = session_token
        self.session_id = session_id
        self.requests: list[tuple[str, dict[str, Any]]] = []

    def owner_name(self) -> str:
        """「自己」在运行记录里的名字：没有令牌时就是昵称（和 `Client.owner_name` 一样）。"""
        assert not self.session_token, "会话令牌不问所属用户"
        return self.nickname

    def get(self, path: str, query: dict[str, Any] | None = None) -> Any:
        query = query or {}
        self.requests.append((path, query))
        assert path == "/runs"
        found = self.runs
        if not self.old and "id_prefix" in query:
            found = [r for r in found if r["id"].startswith(str(query["id_prefix"]).lower())]
        if not self.old and "triggered_by" in query:
            found = [r for r in found if r["triggered_by"] == query["triggered_by"]]
        if not self.old and "session_id" in query:
            found = [r for r in found if (r.get("session") or {}).get("id") == query["session_id"]]
        if "q" in query:
            q = str(query["q"]).lower()
            found = [r for r in found if r["id"].startswith(q) or q in r["triggered_by"].lower()]
        return {"runs": found[: query.get("limit", 200)], "counts": {}}


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


def test_a_prefix_that_matches_nothing_or_is_not_hex_is_run_not_found() -> None:
    fake = client([item(A)])
    for ref in ("ffff", "zzzzzzzz", "", "3f9a 1c"):
        with pytest.raises(CliError) as caught:
            resolve_run(fake, ref)
        assert caught.value.code == "run_not_found"
        assert caught.value.next == "sfly run list"


def test_a_prefix_shorter_than_four_characters_says_how_many_are_needed() -> None:
    fake = client([item(A)])
    for ref in ("3", "3f", "3f9", "3F9"):
        with pytest.raises(CliError) as caught:
            resolve_run(fake, ref)
        error = caught.value
        assert error.code == "run_prefix_too_short"
        assert error.message.splitlines()[0].startswith("运行编号的前缀至少写 4 个字符")
        assert repr(ref) in error.message
        assert error.next == "sfly run list"
    assert fake.requests == []
    assert MIN_RUN_PREFIX == 4


def test_the_control_plane_looks_the_prefix_up_by_id_only() -> None:
    fake = client([item(A)])
    resolve_run(fake, "3f9a")
    assert fake.requests == [("/runs", {"id_prefix": "3f9a", "limit": 500})]


def test_a_username_that_contains_the_prefix_does_not_make_it_ambiguous() -> None:
    # 编号前缀只按编号找（控制面的 `id_prefix`）：昵称里有 beef 的人触发的运行不算。
    other = "11111111-2222-4333-8444-555555555555"
    fake = client([item(other, by="beefy"), item("beef0000-0000-4000-8000-000000000000")])
    assert resolve_run(fake, "beef") == "beef0000-0000-4000-8000-000000000000"


def test_an_old_control_plane_that_ignores_id_prefix_still_gives_the_right_run() -> None:
    # 比命令行旧的控制面不认 `id_prefix`，返回最近的一批：命令行再筛一遍。
    fake = FakeClient([item(B), item(A), item(C)], old=True)
    assert resolve_run(fake, "b617") == C  # type: ignore[arg-type]


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
    # 控制面按触发人精确筛、只要最近的一个，不用取一批再在这里筛。
    assert fake.requests[0] == ("/runs", {"triggered_by": "alice", "limit": 1})
    assert len(fake.requests) == 2


def test_latest_ignores_runs_by_users_whose_name_contains_the_nickname() -> None:
    fake = client([item(B, by="alice-bot"), item(A, by="alice")])
    assert resolve_run(fake, "latest") == A


def test_latest_against_an_old_control_plane_falls_back_to_filtering_a_batch() -> None:
    # 不认 `triggered_by` 的控制面返回的最近一次是别人的：
    # 退回到按关键字取一批再筛，不能误报「没有」。
    fake = FakeClient([item(B, by="bob"), item(A, by="alice-bot"), item(C, by="alice")], old=True)
    assert resolve_run(fake, "latest") == C  # type: ignore[arg-type]
    assert fake.requests == [
        ("/runs", {"triggered_by": "alice", "limit": 1}),
        ("/runs", {"q": "alice", "limit": 500}),
    ]


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


def test_latest_with_a_session_token_is_the_sessions_latest_run() -> None:
    # 会话令牌：不问所属用户，按 SFLY_SESSION_ID 找这个会话触发的最近一次；
    # 发起人自己（不经会话）和别的会话后来触发的不算。
    runs = [
        item(C, started="2026-01-01T00:03:00.000Z"),
        item(B, started="2026-01-01T00:02:00.000Z", session=S2),
        item(A, started="2026-01-01T00:01:00.000Z", session=S1),
    ]
    fake = FakeClient(runs, session_token=True, session_id=S1)
    assert resolve_run(fake, "latest") == A  # type: ignore[arg-type]
    assert fake.requests == [("/runs", {"session_id": S1, "limit": 1})]
    # 比命令行旧的控制面不认 session_id：返回的最近一次不是这个会话的，不能当成它的。
    old = FakeClient(runs, old=True, session_token=True, session_id=S1)
    with pytest.raises(CliError) as caught:
        resolve_run(old, "latest")  # type: ignore[arg-type]
    assert caught.value.code == "no_recent_run"
    assert S1 in caught.value.message


def test_latest_with_a_session_token_but_no_session_id_says_what_is_missing() -> None:
    fake = FakeClient([item(A, session=S1)], session_token=True)
    with pytest.raises(CliError) as caught:
        resolve_run(fake, "latest")  # type: ignore[arg-type]
    assert caught.value.code == "session_id_missing"
    assert "会话令牌" in caught.value.message and "SFLY_SESSION_ID" in caught.value.message
    assert "项目令牌" not in caught.value.message
    assert fake.requests == []
