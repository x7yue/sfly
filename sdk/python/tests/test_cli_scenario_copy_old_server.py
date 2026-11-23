"""`sfly scenario copy` 对着还没有 #576 的控制面（复制的响应里没有 `warnings`）：照常成功。

命令行对版本不一致的约定是告警一次、命令照常执行，不报错。这里要特别小心：复制的请求已经发出去了，副本已经
建好，这时候再抛 `KeyError`，用户看不到新场景的 id，重试一次又会多出一个副本。
"""

from __future__ import annotations

import argparse
import io
import json
from typing import Any

import pytest

from sfly.cli.output import Output
from sfly.cli.scenario_edit import _copy
from sfly.cli.session import Session

SOURCE = "11111111-1111-4111-8111-111111111111"
COPY = "22222222-2222-4222-8222-222222222222"

#: 旧控制面的 OrchestrationView：没有 `warnings`。
OLD_COPY: dict[str, Any] = {
    "id": COPY,
    "name": "副本",
    "description": "",
    "head_version": 1,
    "created_at": "2026-11-23T00:00:00.000Z",
    "archived_at": None,
    "run_notification": {"bot": None, "trigger": "failed", "title": None, "note": None},
    "focus_items": [],
    "focus_edit": None,
}
WARNING = {
    "code": "timeout_out_of_range",
    "message": "节点 a：timeout 必须是 1 到 4294967295 之间的正整数（秒），实际是 5000000000",
    "node_id": "a",
}


class FakeClient:
    def __init__(self, copied: dict[str, Any]) -> None:
        self.copied = copied
        self.copies = 0

    def get(self, path: str, query: dict[str, Any] | None = None) -> Any:
        assert path == f"/orchestrations/{SOURCE}"
        return {"id": SOURCE, "name": "源", "description": "", "head_version": 3}

    def request(self, method: str, path: str, **_: Any) -> Any:
        assert (method, path) == ("POST", f"/orchestrations/{SOURCE}/copy")
        self.copies += 1
        return self.copied


def run_copy(copied: dict[str, Any], *, json_mode: bool) -> tuple[FakeClient, str]:
    client = FakeClient(copied)
    stdout = io.StringIO()
    session = Session(client, Output(json_mode=json_mode, stdout=stdout))  # type: ignore[arg-type]
    _copy(session, argparse.Namespace(scenario=SOURCE, name="副本"))
    return client, stdout.getvalue()


def test_a_response_without_warnings_still_prints_the_new_scenario() -> None:
    client, text = run_copy(OLD_COPY, json_mode=False)

    assert client.copies == 1
    assert f"（{COPY}）" in text
    assert "已把场景「源」复制为「副本」" in text
    assert "警告" not in text


def test_a_response_without_warnings_still_prints_the_json() -> None:
    client, text = run_copy(OLD_COPY, json_mode=True)

    assert client.copies == 1
    data = json.loads(text)
    assert data["id"] == COPY
    assert data["warnings"] == []


@pytest.mark.parametrize("json_mode", [False, True])
def test_a_response_with_warnings_prints_them(json_mode: bool) -> None:
    _, text = run_copy({**OLD_COPY, "warnings": [WARNING]}, json_mode=json_mode)

    if json_mode:
        assert json.loads(text)["warnings"] == [WARNING]
    else:
        assert "警告（1）：" in text
        assert WARNING["message"] in text
