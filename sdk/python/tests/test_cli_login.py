"""`sfly login`、`sfly logout`、平台命令带令牌（ADR 0029「凭据」，#491）。

用一个本地的假控制面（http.server，只回答令牌相关的几个接口和 `GET /runs`），
经 `main([...])` 跑真实的命令：
凭据文件的权限、令牌和密码不出现在输出和命令行参数里、`SFLY_API_TOKEN` 优先于凭据文件、
有令牌时昵称被忽略并提示一次、401 的错误信息写明 `sfly login`。
"""

from __future__ import annotations

import io
import json
import os
import stat
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from sfly.cli import credentials, main
from sfly.cli.client import Client
from sfly.cli.errors import CliError
from sfly.cli.run_view import resolve_run

TOKEN = "sfly_pat_" + "0123456789abcdef" * 3
OTHER_TOKEN = "sfly_pat_" + "fedcba9876543210" * 3
PASSWORD = "correct-horse-battery-1"


class FakeServer:
    """假控制面：记下每个请求（方法、路径、请求头、请求体），按配置的结果回答。"""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        # POST /account/tokens 的回答：(状态码, 响应体)；None 表示发出令牌。
        self.issue_error: tuple[int, dict[str, Any]] | None = None
        # 按顺序用掉的错误（每次 POST /account/tokens 取一个，用完了再看 issue_error）。
        self.issue_errors: list[tuple[int, dict[str, Any]]] = []
        # POST /packages 的回答状态码（201 是成功）。
        self.publish_status = 201
        # 非空时 GET /redirect 返回 302 跳到这个地址。
        self.redirect_to: str | None = None
        self.revoke_status = 204
        self.revoke_error_code = "unauthorized"
        self.runs_status = 200
        self.runs_error_code = "unauthorized"
        self.issued = 0
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def _read(self) -> Any:
                length = int(self.headers.get("content-length") or 0)
                return json.loads(self.rfile.read(length)) if length else None

            def _send(self, status: int, body: Any = None) -> None:
                data = b"" if body is None else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _record(self, body: Any = None) -> None:
                outer.requests.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "headers": {k.lower(): v for k, v in self.headers.items()},
                        "body": body,
                    }
                )

            def do_POST(self) -> None:
                if self.path == "/packages":
                    length = int(self.headers.get("content-length") or 0)
                    raw = self.rfile.read(length)
                    self._record(raw)
                    if outer.publish_status != 201:
                        return self._send(
                            outer.publish_status,
                            {"error": {"code": "unauthorized", "message": "需要登录或令牌"}},
                        )
                    return self._send(201, {"name": "demo", "version": "1.0.0", "sha256": "0" * 64})
                body = self._read()
                self._record(body)
                if self.path == "/account/tokens":
                    if outer.issue_errors:
                        status, payload = outer.issue_errors.pop(0)
                        return self._send(status, payload)
                    if outer.issue_error:
                        status, payload = outer.issue_error
                        return self._send(status, payload)
                    outer.issued += 1
                    return self._send(
                        201,
                        {
                            "id": f"00000000-0000-4000-8000-00000000000{outer.issued}",
                            "kind": "personal",
                            "name": body["name"],
                            "prefix": TOKEN[:13],
                            "scopes": body.get("scopes") or ["read", "run", "edit"],
                            "project": None,
                            "created_at": "2026-01-01T00:00:00.000Z",
                            "expires_at": None,
                            "revoked_at": None,
                            "last_used_at": None,
                            "current": False,
                            "token": TOKEN if outer.issued == 1 else OTHER_TOKEN,
                        },
                    )
                self._send(404, {"error": {"code": "not_found", "message": "没有这个接口"}})

            def do_DELETE(self) -> None:
                self._record()
                if outer.revoke_status == 204:
                    return self._send(204)
                self._send(
                    outer.revoke_status,
                    {"error": {"code": outer.revoke_error_code, "message": "凭据无效"}},
                )

            def do_GET(self) -> None:
                self._record()
                path = self.path.split("?")[0]
                if path == "/redirect" and outer.redirect_to:
                    self.send_response(302)
                    self.send_header("location", outer.redirect_to)
                    self.send_header("content-length", "0")
                    self.end_headers()
                    return
                if path == "/landing":
                    return self._send(200, {"landed": True})
                if path == "/account/tokens":
                    return self._send(
                        200,
                        {
                            "tokens": [],
                            "user": {
                                "id": "u1",
                                "login_name": "alice",
                                "display_name": "爱丽丝",
                                "is_platform_admin": False,
                            },
                        },
                    )
                if path == "/runs":
                    if outer.runs_status != 200:
                        return self._send(
                            outer.runs_status,
                            {"error": {"code": outer.runs_error_code, "message": "需要登录或令牌"}},
                        )
                    return self._send(
                        200,
                        {
                            "runs": [
                                {
                                    "id": "3f9a1c2e-7b4d-4a55-9c1e-0d2b6a8e4f10",
                                    "orchestration_id": "00000000-0000-4000-8000-0000000000a1",
                                    "orchestration_name": "巡检",
                                    "orchestration_version": 1,
                                    "status": "success",
                                    "cancelling": False,
                                    "triggered_by": "爱丽丝",
                                    "triggered_via": None,
                                    "started_at": "2026-01-01T00:00:00.000Z",
                                    "ended_at": "2026-01-01T00:00:05.000Z",
                                    "failures": 0,
                                }
                            ],
                            "counts": {},
                        },
                    )
                self._send(404, {"error": {"code": "not_found", "message": "没有这个接口"}})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def headers_of(self, method: str, path: str) -> dict[str, str]:
        found = [r for r in self.requests if r["method"] == method and r["path"].startswith(path)]
        assert found, (
            f"没有收到 {method} {path}：{[(r['method'], r['path']) for r in self.requests]}"
        )
        headers: dict[str, str] = found[-1]["headers"]
        return headers


@pytest.fixture
def server() -> Iterator[FakeServer]:
    fake = FakeServer()
    yield fake
    fake.close()


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, server: FakeServer) -> Path:
    """SFLY_HOME 指到临时目录，控制面地址指到假控制面；清掉会干扰的环境变量。"""
    root = tmp_path / "sfly-home"
    monkeypatch.setenv("SFLY_HOME", str(root))
    monkeypatch.setenv("SFLY_SERVER", server.url)
    for name in ("SFLY_API_TOKEN", "SFLY_NICKNAME", "SFLY_CONTROL_PLANE_URL"):
        monkeypatch.delenv(name, raising=False)
    return root


def run(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    *argv: str,
    stdin: str | None = None,
) -> tuple[int, str, str]:
    if stdin is not None:
        monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    code = main(list(argv))
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def login(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    *extra: str,
    password: str = PASSWORD,
) -> tuple[int, str, str]:
    return run(
        capsys,
        monkeypatch,
        "login",
        "--login-name",
        "alice",
        "--password-stdin",
        *extra,
        stdin=password + "\n",
    )


class TestCredentialsFile:
    def test_saved_file_is_0600_and_the_directory_0700_even_with_a_loose_umask(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "newdir" / "credentials.json"
        old = os.umask(0)
        try:
            credentials.save(
                "http://sfly.example:8080/",
                credentials.StoredCredential(
                    TOKEN, "id-1", "alice", "笔记本", "2026-01-01T00:00:00Z"
                ),
                path,
            )
        finally:
            os.umask(old)
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["servers"]["http://sfly.example:8080"]["token"] == TOKEN
        # 重写（覆盖已有的文件）之后权限不变。
        credentials.save(
            "http://sfly.example:8080",
            credentials.StoredCredential(
                OTHER_TOKEN, "id-2", "alice", "笔记本", "2026-01-02T00:00:00Z"
            ),
            path,
        )
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert not [p for p in path.parent.iterdir() if p != path], "没有留下临时文件"

    def test_several_servers_each_keep_their_own_and_removing_the_last_deletes_the_file(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "credentials.json"
        a = credentials.StoredCredential(TOKEN, "a", "alice", "n", "t")
        b = credentials.StoredCredential(OTHER_TOKEN, "b", "bob", "n", "t")
        credentials.save("http://a.example", a, path)
        credentials.save("http://b.example/", b, path)
        assert credentials.load("http://a.example/", path) == a
        assert credentials.load("http://b.example", path) == b
        assert credentials.load("http://c.example", path) is None
        assert credentials.delete("http://a.example", path) is True
        assert credentials.delete("http://a.example", path) is False
        assert credentials.load("http://b.example", path) == b
        assert credentials.delete("http://b.example", path) is True
        assert not path.exists()

    def test_a_broken_or_foreign_file_is_treated_as_no_credentials(self, tmp_path: Path) -> None:
        path = tmp_path / "credentials.json"
        for text in ("", "not json", "[]", '{"servers": []}', '{"servers": {"http://a": 1}}'):
            path.write_text(text, encoding="utf-8")
            assert credentials.load("http://a", path) is None, text

    def test_env_token_beats_the_file_and_the_file_beats_nothing(self, tmp_path: Path) -> None:
        path = tmp_path / "credentials.json"
        stored = credentials.StoredCredential(TOKEN, "a", "alice", "n", "t")
        credentials.save("http://a.example", stored, path)
        assert credentials.resolve_token("http://a.example", {}, path) == credentials.ResolvedToken(
            TOKEN, "file", stored
        )
        env = {"SFLY_API_TOKEN": f"  {OTHER_TOKEN} "}
        resolved = credentials.resolve_token("http://a.example", env, path)
        assert resolved and resolved.token == OTHER_TOKEN and resolved.source == "env"
        assert credentials.resolve_token("http://nowhere", {}, path) is None
        # 不用 SFLY_TOKEN：它是 Agent 的共享注册令牌，会和这里混。
        assert (
            credentials.resolve_token("http://nowhere", {"SFLY_TOKEN": "agent-secret"}, path)
            is None
        )


class TestLogin:
    def test_exchanges_the_password_for_a_token_and_stores_it_0600_without_printing_it(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        code, out, err = login(capsys, monkeypatch, "--name", "我的电脑")
        assert code == 0, err
        # 令牌的原值和密码都不出现在输出里。
        for text in (out, err):
            assert TOKEN not in text
            assert PASSWORD not in text
        assert server.url in out and "alice" in out and "我的电脑" in out
        request = next(r for r in server.requests if r["method"] == "POST")
        assert request["path"] == "/account/tokens"
        assert request["body"] == {
            "name": "我的电脑",
            "login_name": "alice",
            "password": PASSWORD,
        }
        path = home / "credentials.json"
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        stored = credentials.load(server.url)
        assert stored and stored.token == TOKEN and stored.login_name == "alice"
        assert stored.token_id == "00000000-0000-4000-8000-000000000001"

    def test_json_output_has_no_token_either(
        self,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        code, out, err = login(capsys, monkeypatch, "--json")
        assert code == 0, err
        summary = json.loads(out)
        assert summary["login_name"] == "alice"
        assert summary["credentials_file"] == str(home / "credentials.json")
        assert "token" not in summary
        assert TOKEN not in out

    def test_the_exchange_request_never_carries_an_existing_token_or_nickname_identity(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("SFLY_API_TOKEN", OTHER_TOKEN)
        code, _, err = login(capsys, monkeypatch)
        assert code == 0, err
        assert "authorization" not in server.headers_of("POST", "/account/tokens")

    def test_the_password_cannot_be_given_on_the_command_line(
        self,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        with pytest.raises(SystemExit) as caught:
            main(["login", "--login-name", "alice", "--password", PASSWORD])
        assert caught.value.code == 2
        assert "unrecognized arguments" in capsys.readouterr().err

    def test_no_terminal_and_no_password_stdin_is_an_error_that_says_what_to_do(
        self,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO(""))
        code, _, err = run(capsys, monkeypatch, "login", "--login-name", "alice")
        assert code == 2
        assert "--password-stdin" in err and "SFLY_API_TOKEN" in err
        assert not (home / "credentials.json").exists()
        code, _, err = run(
            capsys, monkeypatch, "login", "--login-name", "alice", "--password-stdin", stdin=""
        )
        assert code == 2 and "没有从标准输入读到密码" in err

    def test_wrong_password_is_reported_plainly_and_nothing_is_stored(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        server.issue_error = (
            401,
            {"error": {"code": "invalid_credentials", "message": "登录名或密码不对"}},
        )
        code, _, err = login(capsys, monkeypatch, password="wrong-password-1")
        assert code == 2
        assert "登录名或密码不对" in err
        # 登录名或密码不对不是「没登录」：不叫人再运行 sfly login。
        assert "下一步：sfly login" not in err
        assert "wrong-password-1" not in err
        assert not (home / "credentials.json").exists()

    def test_rate_limited_and_name_taken_say_what_to_do_next(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        server.issue_error = (
            429,
            {"error": {"code": "too_many_attempts", "message": "失败次数太多，请 30 秒之后再试"}},
        )
        code, _, err = login(capsys, monkeypatch)
        assert code == 2 and "30 秒之后再试" in err and "稍后再运行 sfly login" in err
        server.issue_error = (
            409,
            {"error": {"code": "token_name_taken", "message": "已经有一个同名的有效令牌"}},
        )
        code, _, err = login(capsys, monkeypatch)
        assert code == 2 and "sfly login --name" in err

    def test_logging_in_again_issues_the_new_token_first_then_revokes_the_previous_with_itself(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        server.requests.clear()
        assert login(capsys, monkeypatch)[0] == 0
        methods = [(r["method"], r["path"]) for r in server.requests]
        # 先换到新的（存好），再吊销旧的：反过来的话密码输错时旧登录没了、新的又没签出来。
        assert methods == [
            ("POST", "/account/tokens"),
            ("DELETE", "/account/tokens/00000000-0000-4000-8000-000000000001"),
        ]
        # 旧令牌用它自己吊销它自己；新令牌换进了凭据文件。
        assert server.requests[1]["headers"]["authorization"] == f"Bearer {TOKEN}"
        stored = credentials.load(server.url)
        assert stored and stored.token == OTHER_TOKEN

    def test_a_failing_revoke_of_the_old_token_does_not_block_logging_in(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        server.revoke_status = 401  # 旧令牌已经失效
        assert login(capsys, monkeypatch)[0] == 0
        stored = credentials.load(server.url)
        assert stored and stored.token == OTHER_TOKEN

    def test_a_wrong_password_on_a_second_login_leaves_the_working_login_alone(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        server.requests.clear()
        server.issue_error = (
            401,
            {"error": {"code": "invalid_credentials", "message": "登录名或密码不对"}},
        )
        code, _, err = login(capsys, monkeypatch, password="wrong-password-1")
        assert code == 2 and "登录名或密码不对" in err
        # 没有吊销任何令牌，凭据文件里原来的令牌原封不动，之后的命令照常。
        assert [(r["method"], r["path"]) for r in server.requests] == [("POST", "/account/tokens")]
        stored = credentials.load(server.url)
        assert stored and stored.token == TOKEN
        assert run(capsys, monkeypatch, "run", "list")[0] == 0

    def test_rate_limited_or_unreachable_second_login_also_keeps_the_old_one(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        server.requests.clear()
        server.issue_error = (429, {"error": {"code": "too_many_attempts", "message": "太快了"}})
        assert login(capsys, monkeypatch)[0] == 2
        assert [r["method"] for r in server.requests] == ["POST"]
        stored = credentials.load(server.url)
        assert stored and stored.token == TOKEN

    def test_the_old_token_holding_the_default_name_does_not_block_the_new_one(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        server.requests.clear()
        # 旧令牌还有效，占着这个名字：第一次换新的撞上同名，带后缀再换一次；成功之后才吊销旧的。
        server.issue_errors = [
            (409, {"error": {"code": "token_name_taken", "message": "已经有一个同名的有效令牌"}})
        ]
        code, _, err = login(capsys, monkeypatch, "--name", "我的电脑")
        assert code == 0, err
        posts = [r for r in server.requests if r["method"] == "POST"]
        assert [r["body"]["name"] for r in posts] == ["我的电脑", "我的电脑·新"]
        assert [r["method"] for r in server.requests] == ["POST", "POST", "DELETE"]
        stored = credentials.load(server.url)
        assert stored and stored.token == OTHER_TOKEN and stored.name == "我的电脑·新"

    def test_a_name_taken_without_a_previous_login_is_not_retried(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        server.issue_errors = [
            (409, {"error": {"code": "token_name_taken", "message": "已经有一个同名的有效令牌"}})
        ]
        code, _, err = login(capsys, monkeypatch)
        assert code == 2 and "sfly login --name" in err
        assert [r["method"] for r in server.requests] == ["POST"]

    def test_the_password_prompt_is_hidden_getpass_not_input(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        asked: list[str] = []

        def fake_getpass(prompt: str = "") -> str:
            asked.append(prompt)
            return PASSWORD

        def no_input(prompt: str = "") -> str:
            raise AssertionError(f"密码不能用会回显的 input 读：{prompt!r}")

        monkeypatch.setattr("sfly.cli.login._interactive", lambda: True)
        monkeypatch.setattr("getpass.getpass", fake_getpass)
        monkeypatch.setattr("builtins.input", no_input)
        code, _, err = run(
            capsys, monkeypatch, "login", "--server", server.url, "--login-name", "alice"
        )
        assert code == 0, err
        assert asked == ["密码："]
        request = next(r for r in server.requests if r["method"] == "POST")
        assert request["body"]["password"] == PASSWORD


class TestLogout:
    def test_the_token_revokes_itself_then_the_local_entry_is_deleted(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        server.requests.clear()
        code, out, err = run(capsys, monkeypatch, "logout")
        assert code == 0, err
        assert [(r["method"], r["path"]) for r in server.requests] == [
            ("DELETE", "/account/tokens/00000000-0000-4000-8000-000000000001")
        ]
        assert server.requests[0]["headers"]["authorization"] == f"Bearer {TOKEN}"
        assert credentials.load(server.url) is None
        assert not (home / "credentials.json").exists()
        assert "令牌已吊销" in out
        assert TOKEN not in out + err

    def test_an_already_invalid_token_is_fine_and_an_unreachable_server_keeps_the_file(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        server.revoke_status = 401
        code, _, err = run(capsys, monkeypatch, "logout")
        assert code == 0, err
        assert credentials.load(server.url) is None

        # 再登录，然后让控制面连不上：不删本机的（令牌还没吊销），--local 才删。
        server.revoke_status = 204
        server.issued = 0
        assert login(capsys, monkeypatch)[0] == 0
        monkeypatch.setenv("SFLY_SERVER", "http://127.0.0.1:1")
        credentials.save(
            "http://127.0.0.1:1",
            credentials.StoredCredential(TOKEN, "id-1", "alice", "n", "t"),
        )
        code, _, err = run(capsys, monkeypatch, "logout")
        assert code == 2
        assert "没有被吊销" in err and "sfly logout --local" in err
        assert credentials.load("http://127.0.0.1:1") is not None
        code, _, err = run(capsys, monkeypatch, "logout", "--local")
        assert code == 0, err
        assert credentials.load("http://127.0.0.1:1") is None

    def test_a_401_deletes_the_local_entry_but_says_the_token_was_not_revoked_by_this_logout(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        # 令牌已经失效了（账号被停用时令牌照样能吊销它自己，不是这个原因）
        server.revoke_status = 401
        code, out, err = run(capsys, monkeypatch, "logout")
        assert code == 0, err
        assert credentials.load(server.url) is None
        # 如实说：这次登出没有吊销令牌；去哪里核对。
        assert "本机的凭据已删除" in out and "令牌已吊销" not in out
        assert "401" in out and "没有吊销" in out and "令牌」页" in out
        assert "账号被停用" not in out
        assert TOKEN not in out + err
        # --json 里分得清：没有吊销，被控制面拒绝了。
        assert login(capsys, monkeypatch)[0] == 0
        code, out, _ = run(capsys, monkeypatch, "logout", "--json")
        summary = json.loads(out)
        assert (summary["logged_out"], summary["revoked"], summary["rejected"]) == (
            True,
            False,
            True,
        )

    @pytest.mark.parametrize("status", [403, 500])
    def test_a_failed_revoke_that_is_not_a_401_keeps_the_local_entry(
        self,
        status: int,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        server.revoke_status = status
        server.revoke_error_code = "forbidden" if status == 403 else "internal"
        code, _, err = run(capsys, monkeypatch, "logout")
        assert code == 2
        assert "sfly logout --local" in err
        # 说明令牌没有被吊销、本机的凭据保留着（和连不上时一样），不只是给下一步。
        assert "令牌没有被吊销" in err and "本机的凭据保留着" in err
        # 令牌没有被吊销，本机的凭据保留着：不能让本机以为登出了、令牌还有效。
        stored = credentials.load(server.url)
        assert stored and stored.token == TOKEN

    def test_not_logged_in_says_so_and_the_env_token_is_not_ours_to_remove(
        self,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        code, out, _ = run(capsys, monkeypatch, "logout")
        assert code == 0 and "本机没有登录过" in out
        monkeypatch.setenv("SFLY_API_TOKEN", OTHER_TOKEN)
        code, out, _ = run(capsys, monkeypatch, "logout")
        assert code == 0 and "SFLY_API_TOKEN" in out and "不归 sfly logout 管" in out


class TestPlatformCommandsUseTheToken:
    def test_the_stored_token_goes_in_authorization_and_no_nickname_is_sent(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        server.requests.clear()
        code, _, err = run(capsys, monkeypatch, "run", "list", "--json")
        assert code == 0, err
        headers = server.headers_of("GET", "/runs")
        assert headers["authorization"] == f"Bearer {TOKEN}"
        assert "x-sfly-nickname" not in headers
        assert headers["x-sfly-client"].startswith("sfly-cli/")

    def test_without_a_token_the_nickname_is_sent_as_before(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        code, _, err = run(capsys, monkeypatch, "run", "list", "--nickname", "小明")
        assert code == 0, err
        headers = server.headers_of("GET", "/runs")
        assert "authorization" not in headers
        assert headers["x-sfly-nickname"] == "%E5%B0%8F%E6%98%8E"

    def test_sfly_api_token_beats_the_credentials_file(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        monkeypatch.setenv("SFLY_API_TOKEN", OTHER_TOKEN)
        code, _, err = run(capsys, monkeypatch, "run", "list")
        assert code == 0, err
        assert server.headers_of("GET", "/runs")["authorization"] == f"Bearer {OTHER_TOKEN}"

    def test_an_explicit_nickname_with_a_token_is_ignored_with_one_notice(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        # --nickname 和 SFLY_NICKNAME 都一样：被忽略，提示一次（不是每个请求一次）。
        code, _, err = run(capsys, monkeypatch, "run", "list", "--nickname", "小明")
        assert code == 0
        assert err.count("身份由令牌决定") == 1
        monkeypatch.setenv("SFLY_NICKNAME", "小红")
        code, _, err = run(capsys, monkeypatch, "run", "list")
        assert err.count("身份由令牌决定") == 1
        assert "x-sfly-nickname" not in server.headers_of("GET", "/runs")
        # 两次请求（同一个 Client）也只提示一次。
        client = Client(server.url, "小明", token=TOKEN, nickname_ignored=True)
        client.get("/runs")
        client.get("/runs")
        assert capsys.readouterr().err.count("身份由令牌决定") == 1

    def test_no_notice_when_no_nickname_was_given(
        self,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        _, _, err = run(capsys, monkeypatch, "run", "list")
        assert "身份由令牌决定" not in err

    def test_a_401_says_to_run_sfly_login_with_or_without_a_token(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        server.runs_status = 401
        # 旧版命令行不带令牌：控制面开始要求凭据（#494）之后收到 401。
        code, _, err = run(capsys, monkeypatch, "run", "list")
        assert code == 2
        assert "sfly login" in err
        assert "下一步：sfly login" in err
        assert "SFLY_API_TOKEN" in err
        # 带着失效的令牌也一样。
        monkeypatch.setenv("SFLY_API_TOKEN", OTHER_TOKEN)
        code, out, err = run(capsys, monkeypatch, "run", "list", "--json")
        assert code == 2
        body = json.loads(err)["error"]
        assert body["code"] == "unauthorized" and body["next"] == "sfly login"
        assert "sfly login" in body["message"]

    def test_latest_uses_the_display_name_of_the_tokens_user(
        self,
        server: FakeServer,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client = Client(server.url, "系统用户名", token=TOKEN)
        assert client.owner_name() == "爱丽丝"
        assert resolve_run(client, "latest") == "3f9a1c2e-7b4d-4a55-9c1e-0d2b6a8e4f10"
        asked = [r["path"] for r in server.requests if r["path"].startswith("/runs")]
        assert asked and "triggered_by=%E7%88%B1%E4%B8%BD%E4%B8%9D" in asked[0]
        # 用户的显示名只问一次。
        assert len([r for r in server.requests if r["path"] == "/account/tokens"]) == 1
        # 没有令牌时「自己」是昵称。
        assert Client(server.url, "小明").owner_name() == "小明"

    def test_a_project_token_has_no_user_so_latest_says_so(self, server: FakeServer) -> None:
        # 项目令牌不能读 /account/tokens（403）：「自己触发的运行」没有意义。
        class Forbidden(Client):
            def get(self, path: str, query: Any = None) -> Any:
                from sfly.cli.client import ApiError

                raise ApiError(403, "forbidden", "这个接口只认登录和个人令牌")

        with pytest.raises(CliError) as caught:
            Forbidden(server.url, "x", token=TOKEN).owner_name()
        assert caught.value.code == "token_without_user"


class TestTokenNeverLeavesTheControlPlane:
    """令牌只发给控制面：重定向到别的源（协议、主机、端口任一不同）时不带 `Authorization`。"""

    @pytest.fixture
    def other(self) -> Iterator[FakeServer]:
        fake = FakeServer()
        yield fake
        fake.close()

    def test_a_redirect_to_another_host_or_port_drops_the_token(
        self,
        server: FakeServer,
        other: FakeServer,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # 另一个端口的同一台机器也是另一个源。
        server.redirect_to = f"{other.url}/landing"
        client = Client(server.url, "alice", token=TOKEN)
        assert client.request("GET", "/redirect") == {"landed": True}
        assert "authorization" not in other.headers_of("GET", "/landing")
        # 控制面自己收到的是带令牌的。
        assert server.headers_of("GET", "/redirect")["authorization"] == f"Bearer {TOKEN}"

    def test_a_redirect_within_the_same_origin_keeps_the_token(
        self, server: FakeServer, home: Path
    ) -> None:
        server.redirect_to = f"{server.url}/landing"
        client = Client(server.url, "alice", token=TOKEN)
        assert client.request("GET", "/redirect") == {"landed": True}
        assert server.headers_of("GET", "/landing")["authorization"] == f"Bearer {TOKEN}"

    def test_a_redirect_to_a_different_scheme_is_a_different_origin(self) -> None:
        from sfly.cli.client import origin_of

        assert origin_of("http://cp.example:8080/a") == origin_of("HTTP://CP.example:8080/b")
        assert origin_of("http://cp.example/a") == origin_of("http://cp.example:80/b")
        assert origin_of("http://cp.example/a") != origin_of("https://cp.example/a")
        assert origin_of("http://cp.example:8080/a") != origin_of("http://cp.example:8081/a")
        assert origin_of("http://cp.example/a") != origin_of("http://cp2.example/a")


class TestPlainHttpNote:
    def test_a_token_over_non_local_http_is_noted_once(self) -> None:
        err = io.StringIO()
        client = Client("http://cp.example.test:1", "alice", token=TOKEN, stderr=err, timeout=0.2)
        for _ in range(2):
            with pytest.raises(CliError):
                client.get("/runs")
        text = err.getvalue()
        assert text.count("明文") == 1 and "https" in text
        assert TOKEN not in text

    def test_no_note_for_localhost_https_or_without_a_token(self) -> None:
        for server, token in (
            ("http://127.0.0.1:1", TOKEN),
            ("http://localhost:1", TOKEN),
            ("https://cp.example.test:1", TOKEN),
            ("http://cp.example.test:1", None),
        ):
            err = io.StringIO()
            client = Client(server, "alice", token=token, stderr=err, timeout=0.2)
            with pytest.raises(CliError):
                client.get("/runs")
            assert "明文" not in err.getvalue(), (server, token)


class TestPlainHttpPasswordNote:
    """第一次 `sfly login`（还没有令牌）往不是本机的 `http://` 地址发密码：发之前也提示。"""

    def test_login_over_non_local_http_notes_that_the_password_is_sent_in_the_clear(
        self,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        code, out, err = login(capsys, monkeypatch, "--server", "http://cp.example.test:1")
        assert code == 2  # 连不上：提示在发之前
        assert err.count("明文") == 1 and "密码" in err and "https" in err
        assert PASSWORD not in out + err

    def test_no_note_for_localhost_or_https(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        code, _, err = login(capsys, monkeypatch)  # 本机的假控制面
        assert code == 0 and "明文" not in err
        for url in ("http://localhost:1", "http://127.0.0.1:1", "https://cp.example.test:1"):
            _, _, err = login(capsys, monkeypatch, "--server", url)
            assert "明文" not in err, url


class TestCredentialsFilePermissions:
    def test_a_world_readable_file_is_noted(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        path = home / "credentials.json"
        assert credentials.loose_permissions(path) is None
        code, _, err = run(capsys, monkeypatch, "run", "list")
        assert code == 0 and "权限" not in err

        path.chmod(0o644)
        assert credentials.loose_permissions(path) == "0644"
        code, _, err = run(capsys, monkeypatch, "run", "list")
        assert code == 0
        assert "0644" in err and "chmod 600" in err
        assert TOKEN not in err

    def test_the_environment_token_does_not_trigger_it(
        self,
        server: FakeServer,
        home: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        (home / "credentials.json").chmod(0o644)
        monkeypatch.setenv("SFLY_API_TOKEN", OTHER_TOKEN)
        _, _, err = run(capsys, monkeypatch, "run", "list")
        assert "权限" not in err


class TestPublishUsesTheToken:
    def test_publish_sends_the_token_and_the_archive_bytes(
        self,
        server: FakeServer,
        home: Path,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        assert login(capsys, monkeypatch)[0] == 0
        archive = tmp_path / "demo-1.0.0.sflypkg"
        archive.write_bytes(b"archive-bytes")
        code, out, err = run(capsys, monkeypatch, "publish", str(archive))
        assert code == 0, err
        assert "已发布 demo@1.0.0" in out
        request = next(r for r in server.requests if r["path"] == "/packages")
        assert request["headers"]["authorization"] == f"Bearer {TOKEN}"
        assert request["headers"]["content-type"] == "application/octet-stream"
        assert request["body"] == b"archive-bytes"
        assert TOKEN not in out + err

    def test_publish_without_a_token_still_works_and_a_401_says_to_log_in(
        self,
        server: FakeServer,
        home: Path,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        archive = tmp_path / "demo-1.0.0.sflypkg"
        archive.write_bytes(b"archive-bytes")
        code, out, err = run(capsys, monkeypatch, "publish", str(archive))
        assert code == 0, err
        request = next(r for r in server.requests if r["path"] == "/packages")
        assert "authorization" not in request["headers"]

        server.publish_status = 401
        code, _, err = run(capsys, monkeypatch, "publish", str(archive))
        assert code == 1
        assert "401" in err and "sfly login" in err
