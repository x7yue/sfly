"""写给人看的控制面地址不带用户名段（`用户名:密码@`）（#492）。

`--server`、`SFLY_SERVER` 里可以写 `http://用户名:密码@主机`。报错、提示里写出地址的地方都去掉那一段；
规则和 Agent 的 `without_userinfo`（`agent/src/secret.rs`）相同，两边的表一样。
"""

from __future__ import annotations

import http.client
import io
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from sfly.cli import credentials, main
from sfly.cli.client import Client, scrub_userinfo, without_userinfo
from sfly.cli.init import InitError, fetch_settings
from sfly.cli.run_summary import run_url

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


class Counting:
    """数收到几个请求的假控制面：地址里带用户名段时一个请求都不该发出来。"""

    def __init__(self) -> None:
        self.requests = 0
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def do_GET(self) -> None:
                outer.requests += 1
                self.send_response(200)
                self.send_header("content-length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            do_POST = do_GET

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def counting() -> Iterator[Counting]:
    fake = Counting()
    yield fake
    fake.close()


def _with_userinfo(counting: Counting) -> list[str]:
    """带用户名段的几种写法：不带端口的 http、https（`http.client` 把整段当主机名，
    异常原文里有密码），和带端口的、不带协议的。"""
    return [
        f"http://user:{PASSWORD}@127.0.0.1",
        f"https://user:{PASSWORD}@example.invalid",
        f"http://user:{PASSWORD}@127.0.0.1:{counting.port}",
        f"user:{PASSWORD}@127.0.0.1:{counting.port}",
    ]


@pytest.mark.parametrize("argv", [["agent", "list"], ["agent", "list", "--json"]])
def test_an_address_with_a_user_name_is_refused_before_any_request(
    home: Path, counting: Counting, capsys: pytest.CaptureFixture[str], argv: list[str]
) -> None:
    for address in _with_userinfo(counting):
        code = main([*argv, "--server", address])
        captured = capsys.readouterr()
        text = captured.out + captured.err
        assert code != 0, address
        assert PASSWORD not in text, address
        assert "控制面地址里不要带用户名和密码" in text, address
        assert "SFLY_API_TOKEN" in text and "sfly login" in text, address
    assert counting.requests == 0


def test_the_address_from_the_environment_is_checked_too(
    home: Path,
    counting: Counting,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SFLY_SERVER", f"http://user:{PASSWORD}@127.0.0.1")
    code = main(["agent", "list"])
    captured = capsys.readouterr()
    assert code != 0 and PASSWORD not in captured.out + captured.err
    assert "http://127.0.0.1）" in captured.err
    assert counting.requests == 0


def test_a_clean_address_still_connects(home: Path, counting: Counting) -> None:
    assert Client(f"http://127.0.0.1:{counting.port}", "tester").get("/anything") == {}
    assert counting.requests == 1


@pytest.mark.parametrize(
    ("text", "scrubbed"),
    [
        ("nonnumeric port: 'pw@127.0.0.1'", "nonnumeric port: '127.0.0.1'"),
        ("failed for http://user:pw@host/path", "failed for http://host/path"),
        ("failed for https://user@host:8443", "failed for https://host:8443"),
        ("[Errno 8] nodename nor servname provided", "[Errno 8] nodename nor servname provided"),
        ("mail me at a@b.example", "mail me at a@b.example"),
    ],
)
def test_scrub_userinfo(text: str, scrubbed: str) -> None:
    assert scrub_userinfo(text) == scrubbed


def test_a_low_level_error_text_with_a_user_name_is_scrubbed_as_a_fallback(
    home: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    import sfly.cli.client as client_module

    def refuse(self: object, request: object, timeout: float) -> Any:
        raise http.client.InvalidURL(f"nonnumeric port: '{PASSWORD}@127.0.0.1'")

    monkeypatch.setattr(client_module._OPENER, "open", refuse.__get__(client_module._OPENER))
    code = main(["agent", "list", "--server", "http://127.0.0.1"])
    captured = capsys.readouterr()
    assert code != 0
    assert PASSWORD not in captured.out + captured.err
    assert "nonnumeric port: '127.0.0.1'" in captured.err


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


def test_the_run_link_does_not_show_the_password() -> None:
    client = Client(f"https://user:{PASSWORD}@plane.example", "tester")
    assert run_url(client, "run-1") == "https://plane.example/runs/run-1"


def test_init_refuses_an_address_with_a_user_name_without_a_traceback(
    home: Path, counting: Counting, capsys: pytest.CaptureFixture[str]
) -> None:
    for address in _with_userinfo(counting):
        with pytest.raises(InitError) as caught:
            fetch_settings(address)
        assert PASSWORD not in str(caught.value), address
        assert "不要带用户名和密码" in str(caught.value), address
        code = main(["init", str(home / "pkg"), "--server", address])
        captured = capsys.readouterr()
        text = captured.out + captured.err
        assert code != 0 and PASSWORD not in text and "Traceback" not in text, address
        assert "不要带用户名和密码" in text, address
    assert counting.requests == 0


def test_init_catches_the_invalid_url_error_and_scrubs_it(
    home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import urllib.request

    def broken(url: str, timeout: float) -> Any:
        raise http.client.InvalidURL(f"nonnumeric port: '{PASSWORD}@plane.example'")

    monkeypatch.setattr(urllib.request, "urlopen", broken)
    with pytest.raises(InitError) as caught:
        fetch_settings("https://plane.example")
    assert PASSWORD not in str(caught.value)
    assert "无法连接控制面 https://plane.example：" in str(caught.value)


class TestLoginAndLogout:
    SERVER = f"https://user:{PASSWORD}@plane.example"
    SHOWN = "https://plane.example"

    def test_logout_when_not_logged_in(
        self, home: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code = main(["logout", "--server", self.SERVER, "--json"])
        captured = capsys.readouterr()
        assert code == 0
        assert PASSWORD not in captured.out + captured.err
        assert json.loads(captured.out)["server"] == self.SHOWN
        code = main(["logout", "--server", self.SERVER])
        captured = capsys.readouterr()
        assert f"本机没有登录过 {self.SHOWN}（" in captured.out
        assert PASSWORD not in captured.out + captured.err

    def test_local_logout_of_a_stored_login(
        self, home: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        stored = credentials.StoredCredential(
            token="sfly_pat_" + "00" * 16,
            token_id="id-1",
            login_name="alice",
            name="laptop",
            saved_at=credentials.now_iso(),
        )
        credentials.save(self.SERVER, stored)
        code = main(["logout", "--server", self.SERVER, "--local", "--json"])
        captured = capsys.readouterr()
        assert code == 0, captured.err
        assert PASSWORD not in captured.out + captured.err
        assert json.loads(captured.out)["server"] == self.SHOWN
        credentials.save(self.SERVER, stored)
        code = main(["logout", "--server", self.SERVER, "--local"])
        captured = capsys.readouterr()
        assert f"已登出 {self.SHOWN}：" in captured.out
        assert PASSWORD not in captured.out + captured.err

    def test_login_refuses_an_address_with_a_user_name_before_reading_the_password(
        self,
        home: Path,
        counting: Counting,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        for address in _with_userinfo(counting):
            stdin = io.StringIO(PASSWORD + "\n")
            monkeypatch.setattr("sys.stdin", stdin)
            code = main(
                [
                    "login",
                    "--server",
                    address,
                    "--login-name",
                    "alice",
                    "--password-stdin",
                    "--json",
                ]
            )
            captured = capsys.readouterr()
            text = captured.out + captured.err
            assert code != 0, address
            assert PASSWORD not in text, address
            assert "不要带用户名和密码" in text, address
            # 密码还在标准输入里：没读。
            assert stdin.tell() == 0, address
        assert counting.requests == 0

    def test_the_interactive_default_address_is_shown_without_the_user_name(
        self,
        home: Path,
        counting: Counting,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        import sfly.cli.login as login_module

        prompts: list[str] = []
        monkeypatch.setattr(login_module, "_interactive", lambda: True)

        def ask(prompt: str) -> str:
            prompts.append(prompt)
            return ""

        monkeypatch.setattr(login_module, "_ask", ask)
        monkeypatch.setenv("SFLY_SERVER", f"http://user:{PASSWORD}@127.0.0.1")
        code = main(["login", "--login-name", "alice"])
        captured = capsys.readouterr()
        assert code != 0
        assert prompts and PASSWORD not in prompts[0]
        assert "[http://127.0.0.1]" in prompts[0]
        assert PASSWORD not in captured.out + captured.err
        assert counting.requests == 0
