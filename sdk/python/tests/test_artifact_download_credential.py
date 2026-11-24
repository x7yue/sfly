"""`ctx.artifacts.download` 带任务凭据（#492）：只对控制面的地址带，
别的地址和重定向到别处的请求都不带。

本进程里起几个本地 HTTP 服务，记下每个请求带的 `Authorization`：一个扮演控制面（`SFLY_ARTIFACTS_URL`
的地址），别的是「别的主机」（同一台机器上端口不同也是别的主机，和浏览器的同源是同一个比法）。
"""

from __future__ import annotations

import http.server
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from sfly import ArtifactDownloadError, Context
from sfly.context import Artifacts
from sfly.download import _same_origin, download

TOKEN = "sfly_tsk_0123456789abcdef0123456789abcdef"


class _Server:
    """记下每个请求（路径、`Authorization`）的本地 HTTP 服务；`redirects` 里的路径回 302。"""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str | None]] = []
        self.redirects: dict[str, str] = {}
        self.status: dict[str, int] = {}
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:
                pass

            def do_GET(self) -> None:
                owner.requests.append((self.path, self.headers.get("Authorization")))
                if self.path in owner.redirects:
                    self.send_response(302)
                    self.send_header("Location", owner.redirects[self.path])
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = owner.status.get(self.path, 200)
                body = b"content" if status == 200 else b""
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def authorizations(self, path: str | None = None) -> list[str | None]:
        return [auth for p, auth in self.requests if path is None or p == path]


@pytest.fixture
def control_plane() -> Iterator[_Server]:
    server = _Server()
    yield server
    server.close()


@pytest.fixture
def elsewhere() -> Iterator[_Server]:
    server = _Server()
    yield server
    server.close()


def _fetch(ref: str, dest: Path, control_plane_url: str | None, token: str | None = TOKEN) -> Path:
    return download(
        ref,
        dest,
        retries=0,
        timeout=5,
        local={},
        cancelled=lambda: False,
        task_token=token,
        control_plane_url=control_plane_url,
    )


def test_the_task_token_goes_to_the_control_plane_address(
    control_plane: _Server, tmp_path: Path
) -> None:
    prefix = f"{control_plane.url}/tasks/t1/artifacts/"
    got = _fetch(prefix + "a.txt", tmp_path / "a.txt", prefix)
    assert got.read_bytes() == b"content"
    assert control_plane.authorizations() == [f"Bearer {TOKEN}"]


def test_it_is_not_sent_to_another_host_or_port(
    control_plane: _Server, elsewhere: _Server, tmp_path: Path
) -> None:
    """产物引用可以是任何 http(s) 地址（上游节点能写任何东西）：别的主机、别的端口都不带。"""
    prefix = f"{control_plane.url}/tasks/t1/artifacts/"
    _fetch(f"{elsewhere.url}/x.txt", tmp_path / "x.txt", prefix)
    assert elsewhere.authorizations() == [None]
    # 同一台机器上换一种写法（localhost 和 127.0.0.1）也是别的主机。
    port = control_plane.url.rsplit(":", 1)[1]
    _fetch(f"http://localhost:{port}/y.txt", tmp_path / "y.txt", prefix)
    assert control_plane.authorizations() == [None]


def test_a_redirect_from_the_control_plane_to_another_host_drops_the_token(
    control_plane: _Server, elsewhere: _Server, tmp_path: Path
) -> None:
    """urllib 默认把请求头带到重定向的新地址：控制面的地址重定向到别处时，跟着去的请求里不能带。"""
    prefix = f"{control_plane.url}/tasks/t1/artifacts/"
    control_plane.redirects["/tasks/t1/artifacts/r.txt"] = f"{elsewhere.url}/moved.txt"
    got = _fetch(prefix + "r.txt", tmp_path / "r.txt", prefix)
    assert got.read_bytes() == b"content"
    assert control_plane.authorizations("/tasks/t1/artifacts/r.txt") == [f"Bearer {TOKEN}"]
    assert elsewhere.authorizations() == [None]


def test_a_redirect_that_comes_back_does_not_get_the_token_again(
    control_plane: _Server, elsewhere: _Server, tmp_path: Path
) -> None:
    """离开控制面之后又被重定向回来：请求是从离开时没有凭据的那个请求派生的，不重新带上。"""
    prefix = f"{control_plane.url}/tasks/t1/artifacts/"
    control_plane.redirects["/tasks/t1/artifacts/a.txt"] = f"{elsewhere.url}/hop"
    elsewhere.redirects["/hop"] = f"{control_plane.url}/tasks/t1/artifacts/b.txt"
    _fetch(prefix + "a.txt", tmp_path / "a.txt", prefix)
    assert control_plane.authorizations() == [f"Bearer {TOKEN}", None]
    assert elsewhere.authorizations() == [None]


def test_a_redirect_inside_the_control_plane_keeps_the_token(
    control_plane: _Server, tmp_path: Path
) -> None:
    prefix = f"{control_plane.url}/tasks/t1/artifacts/"
    control_plane.redirects["/tasks/t1/artifacts/a.txt"] = f"{control_plane.url}/final.txt"
    _fetch(prefix + "a.txt", tmp_path / "a.txt", prefix)
    assert control_plane.authorizations() == [f"Bearer {TOKEN}", f"Bearer {TOKEN}"]


def test_nothing_is_sent_without_a_token_or_without_a_control_plane_address(
    control_plane: _Server, tmp_path: Path
) -> None:
    """本地调试、旧版本的 Agent 或控制面不下发凭据，或者不知道控制面的地址：不带。"""
    prefix = f"{control_plane.url}/tasks/t1/artifacts/"
    _fetch(prefix + "a.txt", tmp_path / "a.txt", prefix, token=None)
    _fetch(prefix + "b.txt", tmp_path / "b.txt", prefix, token="")
    _fetch(prefix + "c.txt", tmp_path / "c.txt", None)
    assert control_plane.authorizations() == [None, None, None]


@pytest.mark.parametrize(
    ("url", "other", "same"),
    [
        ("http://127.0.0.1:8080/a", "http://127.0.0.1:8080/b/c", True),
        ("HTTP://Example.COM/a", "http://example.com/b", True),
        ("http://example.com:80/a", "http://example.com/b", True),
        ("https://example.com:443/a", "https://example.com/b", True),
        ("http://user:pw@example.com/a", "http://example.com/b", True),
        ("http://example.com/a", "https://example.com/a", False),
        ("http://example.com:8080/a", "http://example.com:8081/a", False),
        ("http://example.com/a", "http://example.org/a", False),
        ("http://example.com/a", "http://sub.example.com/a", False),
        ("http://example.com/a", "http://example.com.evil.test/a", False),
        ("http://example.com@evil.test/a", "http://example.com/a", False),
        ("ftp://example.com/a", "ftp://example.com/a", False),
        ("not a url", "not a url", False),
        ("http://example.com:99999/a", "http://example.com:99999/a", False),
    ],
)
def test_same_origin_means_same_scheme_host_and_port(url: str, other: str, same: bool) -> None:
    assert _same_origin(url, other) is same


def test_a_refusal_says_the_task_token_is_invalid_and_is_not_retried(
    control_plane: _Server, tmp_path: Path
) -> None:
    """任务结束之后凭据就失效了（401）：不是网络问题，不重试；消息说明原因，不带凭据。"""
    prefix = f"{control_plane.url}/tasks/t1/artifacts/"
    control_plane.status["/tasks/t1/artifacts/a.txt"] = 401
    with pytest.raises(ArtifactDownloadError) as caught:
        download(
            prefix + "a.txt",
            tmp_path / "a.txt",
            retries=3,
            timeout=5,
            local={},
            cancelled=lambda: False,
            task_token=TOKEN,
            control_plane_url=prefix,
        )
    message = str(caught.value)
    assert "HTTP 401" in message and "任务凭据无效或已失效" in message
    assert TOKEN not in message and "sfly_tsk_" not in message
    assert len(control_plane.requests) == 1, "401 不重试"
    assert not (tmp_path / "a.txt").exists()


def test_a_refusal_without_a_token_says_none_was_sent(
    control_plane: _Server, tmp_path: Path
) -> None:
    prefix = f"{control_plane.url}/tasks/t1/artifacts/"
    control_plane.status["/tasks/t1/artifacts/a.txt"] = 403
    with pytest.raises(ArtifactDownloadError, match="没有带任务凭据"):
        _fetch(prefix + "a.txt", tmp_path / "a.txt", prefix, token=None)


def test_artifacts_object_uses_the_token_it_was_given(
    control_plane: _Server, tmp_path: Path
) -> None:
    prefix = f"{control_plane.url}/tasks/t1/artifacts/"
    artifacts = Artifacts(tmp_path / "out", prefix, task_token=TOKEN)
    artifacts.download(prefix + "a.txt", tmp_path / "a.txt")
    assert control_plane.authorizations() == [f"Bearer {TOKEN}"]


def test_context_reads_the_token_and_the_address_from_the_environment_the_agent_sets(
    control_plane: _Server, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    prefix = f"{control_plane.url}/tasks/t1/artifacts/"
    monkeypatch.setenv("SFLY_ARTIFACTS_URL", prefix)
    monkeypatch.setenv("SFLY_ARTIFACTS", str(tmp_path / "out"))
    monkeypatch.setenv("SFLY_TASK_TOKEN", TOKEN)
    Context().artifacts.download(prefix + "a.txt", tmp_path / "a.txt")
    assert control_plane.authorizations() == [f"Bearer {TOKEN}"]
    # 环境变量里没有任务凭据（旧版本的 Agent 或控制面）：不带。
    monkeypatch.delenv("SFLY_TASK_TOKEN")
    Context().artifacts.download(prefix + "b.txt", tmp_path / "b.txt")
    assert control_plane.authorizations() == [f"Bearer {TOKEN}", None]
