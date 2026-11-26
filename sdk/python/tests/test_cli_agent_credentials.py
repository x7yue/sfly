"""`sfly agent credentials issue|list|revoke`、`register-dev`、`revoke-dev`（#492）。

假控制面（http.server）按契约（`packages/schema/src/http/agents.ts`）回答，记下每个请求；
经 `main([...])` 跑真实的命令：签发的原值只出现在 stdout（`--token-only` 时只有原值一行），
不进 stderr 和错误信息；没有登录凭据时 `register-dev` 退出码 5 且不发请求；
`--env` 只有两行 `KEY=值`；重名的提示换 `--host`。
"""

from __future__ import annotations

import json
import re
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from sfly.cli import main
from sfly.cli.agent import EXIT_NAME_TAKEN, EXIT_NOT_LOGGED_IN, default_host

AGENT_TOKEN = "sfly_agt_" + "0123456789abcdef" * 3
DEV_TOKEN = "sfly_agt_" + "fedcba9876543210" * 3
PERSONAL = "sfly_pat_" + "00112233445566778899aabbccddeeff" * 1
CREDENTIAL_ID = "11111111-2222-4333-8444-555555555555"


class FakeControlPlane:
    """记下请求，按配置回答的假控制面。"""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        # 非空时 POST /projects/default/dev-agents 回这个错误：(状态码, 错误码, 说明)。
        self.dev_error: tuple[int, str, str] | None = None
        # 非空时 POST /agents/:name/credentials 回这个错误。
        self.issue_error: tuple[int, str, str] | None = None
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def _send(self, status: int, body: Any = None) -> None:
                data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _body(self) -> Any:
                length = int(self.headers.get("content-length") or 0)
                return json.loads(self.rfile.read(length)) if length else None

            def _record(self, body: Any = None) -> None:
                outer.requests.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "authorization": self.headers.get("authorization"),
                        "body": body,
                    }
                )

            def do_POST(self) -> None:
                body = self._body()
                self._record(body)
                if re.fullmatch(r"/agents/[^/]+/credentials", self.path):
                    if outer.issue_error:
                        status, code, message = outer.issue_error
                        return self._send(status, {"error": {"code": code, "message": message}})
                    return self._send(
                        201,
                        {
                            "credential": _credential(CREDENTIAL_ID, AGENT_TOKEN),
                            "token": AGENT_TOKEN,
                        },
                    )
                if self.path == "/projects/default/dev-agents":
                    if outer.dev_error:
                        status, code, message = outer.dev_error
                        return self._send(status, {"error": {"code": code, "message": message}})
                    return self._send(
                        201,
                        {
                            "name": f"dev-alice-{body['host']}",
                            "credential": _credential(CREDENTIAL_ID, DEV_TOKEN, user="爱丽丝"),
                            "token": DEV_TOKEN,
                        },
                    )
                self._send(404, {"error": {"code": "not_found", "message": "没有这个接口"}})

            def do_GET(self) -> None:
                self._record()
                if re.fullmatch(r"/agents/[^/]+/credentials", self.path):
                    return self._send(
                        200,
                        {
                            "credentials": [
                                _credential(CREDENTIAL_ID, AGENT_TOKEN, last_used=True),
                                _credential(
                                    "99999999-2222-4333-8444-555555555555",
                                    "sfly_agt_" + "abcdef0123456789" * 3,
                                    revoked=True,
                                    user="爱丽丝",
                                ),
                            ]
                        },
                    )
                self._send(404, {"error": {"code": "not_found", "message": "没有这个接口"}})

            def do_DELETE(self) -> None:
                self._record()
                if re.fullmatch(r"/agents/[^/]+/credentials/[^/]+", self.path) or re.fullmatch(
                    r"/projects/default/dev-agents/[^/]+", self.path
                ):
                    return self._send(204)
                self._send(404, {"error": {"code": "not_found", "message": "没有这个接口"}})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def _credential(
    id_: str,
    token: str,
    *,
    last_used: bool = False,
    revoked: bool = False,
    user: str | None = None,
) -> dict[str, Any]:
    return {
        "id": id_,
        "prefix": token[:13],
        "created_at": "2026-11-25T01:00:00.000Z",
        "last_used_at": "2026-11-25T02:00:00.000Z" if last_used else None,
        "revoked_at": "2026-11-25T03:00:00.000Z" if revoked else None,
        "user": user,
    }


@pytest.fixture
def plane() -> Iterator[FakeControlPlane]:
    fake = FakeControlPlane()
    yield fake
    fake.close()


@pytest.fixture
def logged_in(
    plane: FakeControlPlane, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> FakeControlPlane:
    """已经登录（环境变量里的个人令牌），控制面地址指到假控制面。"""
    monkeypatch.setenv("SFLY_HOME", str(tmp_path / "sfly-home"))
    monkeypatch.setenv("SFLY_SERVER", plane.url)
    monkeypatch.setenv("SFLY_API_TOKEN", PERSONAL)
    for name in ("SFLY_NICKNAME", "SFLY_CONTROL_PLANE_URL"):
        monkeypatch.delenv(name, raising=False)
    return plane


def run(capsys: pytest.CaptureFixture[str], *argv: str) -> tuple[int, str, str]:
    code = main(list(argv))
    captured = capsys.readouterr()
    return code, captured.out, captured.err


class TestIssue:
    def test_token_only_writes_exactly_one_line_to_stdout_and_nothing_secret_to_stderr(
        self, logged_in: FakeControlPlane, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, out, err = run(capsys, "agent", "credentials", "issue", "worker-1", "--token-only")
        assert code == 0, err
        assert out == AGENT_TOKEN + "\n"
        assert AGENT_TOKEN not in err and "sfly_agt_" + "0123456789abcdef"[:4] not in err[20:]
        assert "worker-1" in err and "只显示这一次" in err
        request = logged_in.requests[0]
        assert (request["method"], request["path"]) == ("POST", "/agents/worker-1/credentials")
        assert request["authorization"] == f"Bearer {PERSONAL}"

    def test_text_shows_the_token_on_its_own_line_and_how_to_install_without_arguments(
        self, logged_in: FakeControlPlane, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, out, err = run(capsys, "agent", "credentials", "issue", "worker-1")
        assert code == 0, err
        lines = out.splitlines()
        assert AGENT_TOKEN in lines, out
        assert out.count(AGENT_TOKEN) == 1
        assert "read -rs SFLY_TOKEN && export SFLY_TOKEN" in out
        assert f"curl -fsSL {logged_in.url}/install.sh | sh -s -- --name worker-1" in out
        # 安装命令里没有凭据（参数里看得见）：只有 `--token-only` 这个选项名出现。
        assert not re.search(r"--token(?!-only)", out)
        assert err == ""

    def test_the_agent_name_in_the_printed_command_is_quoted_and_the_path_is_encoded(
        self, logged_in: FakeControlPlane, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, out, _ = run(capsys, "agent", "credentials", "issue", "测试 机")
        assert code == 0
        assert logged_in.requests[0]["path"] == "/agents/%E6%B5%8B%E8%AF%95%20%E6%9C%BA/credentials"
        assert "--name '测试 机'" in out

    def test_json_has_the_token_and_the_credential(
        self, logged_in: FakeControlPlane, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, out, _ = run(capsys, "agent", "credentials", "issue", "worker-1", "--json")
        assert code == 0
        value = json.loads(out)
        assert value["token"] == AGENT_TOKEN and value["name"] == "worker-1"
        assert value["credential"]["id"] == CREDENTIAL_ID

    def test_json_and_token_only_are_two_formats(
        self, logged_in: FakeControlPlane, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, out, err = run(
            capsys, "agent", "credentials", "issue", "worker-1", "--json", "--token-only"
        )
        assert code == 2
        assert logged_in.requests == [], "没有发请求"
        assert AGENT_TOKEN not in out + err

    def test_a_refusal_is_an_error_with_exit_code_2_and_no_token_anywhere(
        self, logged_in: FakeControlPlane, capsys: pytest.CaptureFixture[str]
    ) -> None:
        logged_in.issue_error = (403, "forbidden", "需要「管理」范围")
        for extra in ([], ["--token-only"], ["--json"]):
            code, out, err = run(capsys, "agent", "credentials", "issue", "worker-1", *extra)
            assert code == 2, extra
            assert out == "" and "需要「管理」范围" in err, extra
            assert "sfly_agt_" not in out + err, extra


class TestListAndRevoke:
    def test_list_shows_state_and_prefix_but_never_a_token(
        self, logged_in: FakeControlPlane, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, out, err = run(capsys, "agent", "credentials", "list", "worker-1")
        assert code == 0, err
        assert CREDENTIAL_ID in out and "已吊销" in out and "有效" in out
        assert AGENT_TOKEN[:13] + "…" in out
        assert "从未使用" in out and "爱丽丝" in out
        assert AGENT_TOKEN not in out
        code, out, _ = run(capsys, "agent", "credentials", "list", "worker-1", "--json")
        assert [c["id"] for c in json.loads(out)][0] == CREDENTIAL_ID

    def test_revoke_deletes_that_credential_of_that_agent(
        self, logged_in: FakeControlPlane, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, out, err = run(capsys, "agent", "credentials", "revoke", "worker-1", CREDENTIAL_ID)
        assert code == 0, err
        request = logged_in.requests[-1]
        assert (request["method"], request["path"]) == (
            "DELETE",
            f"/agents/worker-1/credentials/{CREDENTIAL_ID}",
        )
        assert "已吊销" in out and CREDENTIAL_ID in out

    def test_the_id_and_the_name_are_encoded_in_the_path(
        self, logged_in: FakeControlPlane, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # 有斜杠、问号、空格的 id 不能变成别的路径（也不能带出查询参数）。
        code, _, err = run(capsys, "agent", "credentials", "revoke", "worker 1", "a/b?c d")
        assert code == 0, err
        assert logged_in.requests[-1]["path"] == "/agents/worker%201/credentials/a%2Fb%3Fc%20d"


class TestRegisterDev:
    def test_it_posts_the_host_and_prints_the_generated_name_and_the_token_once(
        self, logged_in: FakeControlPlane, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, out, err = run(capsys, "agent", "register-dev", "--host", "lab-05")
        assert code == 0, err
        request = logged_in.requests[0]
        assert (request["method"], request["path"]) == ("POST", "/projects/default/dev-agents")
        assert request["body"] == {"host": "lab-05"}, "请求里没有名字，只有主机"
        assert "dev-alice-lab-05" in out and out.count(DEV_TOKEN) == 1
        assert err == ""

    def test_env_prints_two_key_value_lines_and_the_rest_goes_to_stderr(
        self, logged_in: FakeControlPlane, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, out, err = run(capsys, "agent", "register-dev", "--host", "lab-05", "--env")
        assert code == 0, err
        assert out == f"SFLY_AGENT_NAME=dev-alice-lab-05\nSFLY_TOKEN={DEV_TOKEN}\n"
        assert DEV_TOKEN not in err and "dev-alice-lab-05" in err

    def test_the_default_host_is_this_machines_name_made_into_a_valid_segment(
        self,
        logged_in: FakeControlPlane,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr("socket.gethostname", lambda: "Lab_05.Example.COM")
        assert default_host() == "lab-05"
        code, _, err = run(capsys, "agent", "register-dev", "--env")
        assert code == 0, err
        assert logged_in.requests[0]["body"] == {"host": "lab-05"}

    @pytest.mark.parametrize(
        ("hostname", "expected"),
        [
            ("laptop", "laptop"),
            ("My Laptop", "my-laptop"),
            ("-edge-", "edge"),
            ("机器", ""),
            ("a" * 40, "a" * 32),
            ("a" * 31 + "-b", "a" * 31),
        ],
    )
    def test_default_host_rules(
        self, hostname: str, expected: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("socket.gethostname", lambda: hostname)
        assert default_host() == expected

    def test_a_host_name_with_nothing_usable_asks_for_host(
        self,
        logged_in: FakeControlPlane,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr("socket.gethostname", lambda: "机器")
        code, _, err = run(capsys, "agent", "register-dev")
        assert code == 2 and "--host" in err
        assert logged_in.requests == []

    def test_no_login_credentials_is_exit_code_5_and_sends_nothing(
        self,
        plane: FakeControlPlane,
        capsys: pytest.CaptureFixture[str],
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("SFLY_HOME", str(tmp_path / "sfly-home"))
        monkeypatch.setenv("SFLY_SERVER", plane.url)
        monkeypatch.delenv("SFLY_API_TOKEN", raising=False)
        code, out, err = run(capsys, "agent", "register-dev", "--env")
        assert code == EXIT_NOT_LOGGED_IN == 5
        assert out == "" and "sfly login" in err and "SFLY_API_TOKEN" in err
        assert plane.requests == []
        # --json 时错误是一行 JSON，错误码 not_logged_in。
        code, out, err = run(capsys, "agent", "register-dev", "--json")
        assert code == 5 and json.loads(err)["error"]["code"] == "not_logged_in"

    def test_an_address_with_a_user_name_is_refused_before_login_check_and_request(
        self,
        plane: FakeControlPlane,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        monkeypatch.setenv("SFLY_HOME", str(tmp_path / "sfly-home"))
        for logged_in_now in (True, False):
            # 没有登录时地址的问题也先报：不是退出码 5（安装脚本据此让人去登录，登录用的是同一个地址）。
            if logged_in_now:
                monkeypatch.setenv("SFLY_API_TOKEN", PERSONAL)
            else:
                monkeypatch.delenv("SFLY_API_TOKEN", raising=False)
            for address in (
                "http://user:hunter2pw@127.0.0.1",
                plane.url.replace("//", "//user:hunter2pw@"),
            ):
                code, out, err = run(
                    capsys, "agent", "register-dev", "--host", "lab", "--server", address
                )
                assert code == 2 and out == "", (logged_in_now, address)
                assert "hunter2pw" not in err and "不要带用户名和密码" in err
        assert plane.requests == []

    def test_a_duplicate_says_to_pick_another_host(
        self, logged_in: FakeControlPlane, capsys: pytest.CaptureFixture[str]
    ) -> None:
        logged_in.dev_error = (
            409,
            "dev_agent_exists",
            "已经有一台叫 dev-alice-lab 的 Agent：换一个主机名",
        )
        code, out, err = run(capsys, "agent", "register-dev", "--host", "lab")
        # 专门的退出码：安装脚本据此写明几条路。
        assert code == EXIT_NAME_TAKEN == 6 and out == ""
        assert "dev-alice-lab" in err and "--host <另一个主机名>" in err
        # 两种来源都写明：命令行的 --host、install.sh 的 --dev-host；自己以前注册的先 revoke-dev。
        assert "--dev-host" in err and "sfly agent revoke-dev" in err
        code, out, err = run(capsys, "agent", "register-dev", "--host", "lab", "--json")
        assert code == 6 and json.loads(err)["error"]["code"] == "dev_agent_exists"

    def test_revoke_dev(
        self, logged_in: FakeControlPlane, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, out, err = run(capsys, "agent", "revoke-dev", "dev-alice-lab")
        assert code == 0, err
        request = logged_in.requests[-1]
        assert (request["method"], request["path"]) == (
            "DELETE",
            "/projects/default/dev-agents/dev-alice-lab",
        )
        assert "已吊销" in out
