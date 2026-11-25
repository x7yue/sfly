"""写给人看的控制面地址不带用户名段（`用户名:密码@`）（#492）。

`--server`、`SFLY_SERVER` 里可以写 `http://用户名:密码@主机`。报错、提示里写出地址的地方都去掉那一段；
规则和 Agent 的 `without_userinfo`（`agent/src/secret.rs`）相同，两边的表一样。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from sfly.cli import main
from sfly.cli.client import Client, without_userinfo

PASSWORD = "hunter2-p4ss"


@pytest.mark.parametrize(
    ("address", "shown"),
    [
        ("http://127.0.0.1:50051", "http://127.0.0.1:50051"),
        ("http://user:pw@host:1", "http://host:1"),
        ("https://user@host/x?y=a@b#c@d", "https://host/x?y=a@b#c@d"),
        ("http://a:b@c@host:2/p", "http://host:2/p"),
        ("http://u:p@[::1]:3", "http://[::1]:3"),
        ("host:50051", "host:50051"),
        # 没写协议（漏了 `http://`）。
        ("user:pw@host:1", "host:1"),
        ("user:pw@host:1/x", "host:1/x"),
        ("a:b@c@host:2?q=x@y", "host:2?q=x@y"),
        ("host:50051/p@q", "host:50051/p@q"),
        ("", ""),
    ],
)
def test_without_userinfo(address: str, shown: str) -> None:
    assert without_userinfo(address) == shown


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("SFLY_HOME", str(tmp_path / "sfly-home"))
    for name in ("SFLY_NICKNAME", "SFLY_CONTROL_PLANE_URL", "SFLY_API_TOKEN", "SFLY_SERVER"):
        monkeypatch.delenv(name, raising=False)
    # 本机有 HTTP 代理时连不上会变成代理回的 502：测试要的是「连不上」那一条路。
    for name in (
        "http_proxy",
        "HTTP_PROXY",
        "https_proxy",
        "HTTPS_PROXY",
        "all_proxy",
        "ALL_PROXY",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "*")
    return tmp_path


def test_connect_error_does_not_show_the_password(
    home: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = main(["agent", "list", "--server", f"http://user:{PASSWORD}@127.0.0.1:1"])
    captured = capsys.readouterr()
    assert code != 0
    assert PASSWORD not in captured.out + captured.err
    assert "无法连接控制面 http://127.0.0.1:1：" in captured.err
    assert "curl http://127.0.0.1:1/health" in captured.err


def test_plain_http_warning_does_not_show_the_password(
    home: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    client = Client(f"http://user:{PASSWORD}@example.invalid", "tester", token="sfly_pat_x")
    client.note_plain_http()
    captured = capsys.readouterr()
    assert "http://example.invalid 是 http 地址" in captured.err
    assert PASSWORD not in captured.err + captured.out
    assert client.url("/health") == f"http://user:{PASSWORD}@example.invalid/health"
    assert client.shown_url("/health") == "http://example.invalid/health"


def test_the_install_command_printed_by_credentials_issue_does_not_show_the_password(
    home: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    token = "sfly_agt_" + "0123456789abcdef" * 3

    def fake_request(self: Client, method: str, path: str, **kwargs: Any) -> Any:
        return {"token": token, "credential": {"prefix": token[:13]}}

    monkeypatch.setattr(Client, "request", fake_request)
    monkeypatch.setenv("SFLY_API_TOKEN", "sfly_pat_" + "00" * 16)
    code = main(
        [
            "agent",
            "credentials",
            "issue",
            "worker-1",
            "--server",
            f"https://user:{PASSWORD}@plane.example",
        ]
    )
    captured = capsys.readouterr()
    assert code == 0, captured.err
    assert PASSWORD not in captured.out + captured.err
    assert "curl -fsSL https://plane.example/install.sh | sh -s -- --name worker-1" in captured.out
