"""上传前扫凭据（`aeval.leakscan`）和 CI 的评测（`aeval.ci`）：扫到什么、漏不漏、退出码。"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from aeval import ci, leakscan
from aeval.env import Stack

REPO = Path(__file__).resolve().parents[3]
PASSWORD = "0f3a9c1d2b7e4f8a9c0d1e2f3a4b5c6d"
SESSION_TOKEN = "sfly_ses_" + "ab12" * 12
COOKIE = "sfly_login=" + "Qx9_" * 11


def put(root: Path, name: str, text: str) -> None:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def test_token_prefixes_match_the_schema() -> None:
    source = (REPO / "packages/schema/src/http/tokens.ts").read_text()
    block = re.search(r"TOKEN_PREFIXES = \{(.*?)\}", source, re.S)
    assert block is not None
    assert sorted(re.findall(r'"(sfly_[a-z]+_)"', block.group(1))) == sorted(
        leakscan.TOKEN_PREFIXES
    )


def test_reports_values_tokens_and_cookies_by_file(tmp_path: Path) -> None:
    put(tmp_path, "a/platform.json", json.dumps({"problem": f"登录被拒：{PASSWORD}"}))
    put(tmp_path, "a/events.jsonl", f'{{"text": "SFLY_TOKEN={SESSION_TOKEN}"}}\n')
    put(tmp_path, "b/driver.log", f"cookie: {COOKIE}; Path=/\n")
    put(tmp_path, "b/agent.env", "SFLY_TOKEN=sfly_agt_" + "f" * 48 + "\n")

    assert leakscan.scan(tmp_path, [PASSWORD, None]) == [
        ("a/events.jsonl", "令牌"),
        ("a/platform.json", leakscan.VALUE),
        ("b/agent.env", "令牌"),
        ("b/driver.log", "登录 Cookie"),
    ]


def test_masked_cut_and_mentioned_credentials_are_not_reported(tmp_path: Path) -> None:
    put(
        tmp_path,
        "s/events.jsonl",
        "\n".join(
            [
                f"密码 {PASSWORD[:-1]}",  # 截断的：只认完整的出现
                "SFLY_TOKEN=sfly_ses_******",
                "sfly_login=******",
                "令牌是 sfly_pat_ 开头的一串",
                f"{SESSION_TOKEN[:20]}",
            ]
        ),
    )
    assert leakscan.scan(tmp_path, [PASSWORD]) == []


def test_symlinks_are_not_followed(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    put(outside, "secret.txt", PASSWORD)
    results = tmp_path / "results"
    results.mkdir()
    (results / "link").symlink_to(outside / "secret.txt")
    assert leakscan.scan(results, [PASSWORD]) == []


def record(passed: bool, invalid: bool = False) -> dict[str, Any]:
    return {
        "invalid": invalid,
        "grade": {"passed": passed, "score": 1.0 if passed else 0.0},
        "failure": None if passed else {"primary": "超时"},
    }


@pytest.fixture
def fake_stack(monkeypatch: pytest.MonkeyPatch) -> Stack:
    stack = Stack(slot=9)
    stack.assistant_secret = "s" * 48
    monkeypatch.setattr(ci, "save_logs", lambda stack, out: out.mkdir(parents=True))
    monkeypatch.setattr(ci, "load_models", lambda: {"fake": object()})
    return stack


def scripted(
    monkeypatch: pytest.MonkeyPatch, outcomes: dict[str, Any], leak: str | None = None
) -> list[str]:
    """run_session 换成照剧本的：每次会话换一个管理员密码（和 reset 一样），按需写进结果目录。"""
    seen: list[str] = []

    def fake_run(stack: Stack, task: Any, model: Any, results: Path, **kw: Any) -> Any:
        stack.admin_password = f"pw-{task.id}-" + "0" * 20
        seen.append(task.id)
        put(results, f"{kw['session_id']}/session.json", "{}")
        if leak == task.id:
            put(results, f"{kw['session_id']}/platform.json", stack.admin_password)
        outcome = outcomes[task.id]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(ci, "run_session", fake_run)
    return seen


def test_all_passed_and_clean(
    fake_stack: Stack, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    seen = scripted(monkeypatch, {t: record(True) for t in ci.TASK_IDS})
    assert ci.run(fake_stack, tmp_path, say=lambda _: None) == ci.PASSED
    assert seen == list(ci.TASK_IDS)
    assert not (tmp_path / "containers").exists()


def test_a_failed_or_invalid_session_fails_but_may_be_uploaded(
    fake_stack: Stack, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    outcomes = {t: record(True) for t in ci.TASK_IDS}
    outcomes["fix"] = record(False)
    outcomes["cross"] = record(True, invalid=True)
    lines: list[str] = []
    scripted(monkeypatch, outcomes)
    assert ci.run(fake_stack, tmp_path, say=lines.append) == ci.FAILED
    assert lines[-1] == "没通过：fix、cross"
    assert (tmp_path / "containers").is_dir()


def test_a_password_of_any_session_is_found_even_after_a_crash(
    fake_stack: Stack, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    outcomes: dict[str, Any] = {t: record(True) for t in ci.TASK_IDS}
    outcomes["orchestrate"] = RuntimeError("驱动出错")
    seen = scripted(monkeypatch, outcomes, leak="write")
    lines: list[str] = []
    assert ci.run(fake_stack, tmp_path, say=lines.append) == ci.LEAKED
    assert seen == ["write", "fix", "orchestrate"]
    assert "结果目录里有凭据（secret 值）：write-fake-p/platform.json" in lines
    assert all("pw-write" not in line for line in lines)


def test_the_shared_assistant_secret_is_scanned(
    fake_stack: Stack, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    scripted(monkeypatch, {t: record(True) for t in ci.TASK_IDS})
    put(tmp_path, "run-info.json", str(fake_stack.assistant_secret))
    assert ci.run(fake_stack, tmp_path, say=lambda _: None) == ci.LEAKED
