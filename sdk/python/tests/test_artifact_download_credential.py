"""`ctx.artifacts.download` 带任务凭据（#492）：只对控制面给的前缀之下、后面接着 `tasks/` 的地址带，
别的地址、写法不规矩的地址、重定向之后的请求都不带。

本进程里起几个本地 HTTP 服务，记下每个请求带的 `Authorization`：一个扮演控制面（`SFLY_ARTIFACTS_URL`
的地址），别的是「别的主机」（同一台机器上端口不同也是别的主机）。判断本身（`_is_control_plane_download`）
只比较文本，不依赖 Python 的小版本；CI 只在 `.python-version` 上跑，支持的每个小版本（3.10 到 3.14）
本地都跑过这个文件。
"""

from __future__ import annotations

import http.server
import threading
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from sfly import ArtifactDownloadError, Context
from sfly.context import Artifacts
from sfly.download import _control_plane_prefix, _is_control_plane_download, download

TOKEN = "sfly_tsk_0123456789abcdef0123456789abcdef"


class _Server:
    """记下每个请求（路径、`Authorization`）的本地 HTTP 服务；`redirects` 里的路径回 302。"""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str | None]] = []
        self.redirects: dict[str, str] = {}
        self.redirect_status = 302
        self.status: dict[str, int] = {}
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:
                pass

            def do_GET(self) -> None:
                owner.requests.append((self.path, self.headers.get("Authorization")))
                if self.path in owner.redirects:
                    self.send_response(owner.redirect_status)
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


@pytest.fixture(autouse=True)
def _no_system_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    """这些用例只连本机起的服务：不经过环境变量或系统设置里的代理（`no_proxy=*`）。"""
    for key in ("http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(key, raising=False)
        monkeypatch.delenv(key.upper(), raising=False)
    monkeypatch.setenv("no_proxy", "*")


def _prefix(server: _Server, base: str = "") -> str:
    """控制面给的产物地址前缀：`<控制面>[<路径前缀>]/tasks/t1/artifacts/`。"""
    return f"{server.url}{base}/tasks/t1/artifacts/"


def test_the_task_token_goes_to_the_control_plane_address(
    control_plane: _Server, tmp_path: Path
) -> None:
    prefix = _prefix(control_plane)
    got = _fetch(prefix + "a.txt", tmp_path / "a.txt", prefix)
    assert got.read_bytes() == b"content"
    # 同一个控制面上别的任务的产物（引用来自别的任务的节点输出）也带：控制面按凭据判断能不能下载。
    _fetch(f"{control_plane.url}/tasks/t2/artifacts/b.txt", tmp_path / "b.txt", prefix)
    assert control_plane.authorizations() == [f"Bearer {TOKEN}", f"Bearer {TOKEN}"]


def test_a_control_plane_under_a_path_prefix_gets_the_token_only_below_that_prefix(
    control_plane: _Server, tmp_path: Path
) -> None:
    """控制面的对外地址可以带路径前缀（`SFLY_PUBLIC_URL`）：同一个主机和端口上别的服务的地址不带。"""
    prefix = _prefix(control_plane, "/sfly")
    _fetch(prefix + "a.txt", tmp_path / "a.txt", prefix)
    _fetch(f"{control_plane.url}/sfly/tasks/t9/artifacts/b.txt", tmp_path / "b.txt", prefix)
    assert control_plane.authorizations() == [f"Bearer {TOKEN}", f"Bearer {TOKEN}"]
    for other in (
        f"{control_plane.url}/other-app/x",
        f"{control_plane.url}/tasks/t1/artifacts/x",  # 没有路径前缀：是同一个主机上别的服务
        f"{control_plane.url}/sfly/other",
        f"{control_plane.url}/sfly-evil/tasks/t1/artifacts/x",
        f"{control_plane.url}/sflyx",
    ):
        control_plane.requests.clear()
        _fetch(other, tmp_path / "x.txt", prefix)
        assert control_plane.authorizations() == [None], other


def test_it_is_not_sent_to_another_host_or_port(
    control_plane: _Server, elsewhere: _Server, tmp_path: Path
) -> None:
    """产物引用可以是任何 http(s) 地址（上游节点能写任何东西）：别的主机、别的端口都不带。"""
    prefix = _prefix(control_plane)
    _fetch(f"{elsewhere.url}/x.txt", tmp_path / "x.txt", prefix)
    assert elsewhere.authorizations() == [None]
    # 同一台机器上换一种写法（localhost 和 127.0.0.1）也是别的主机。
    port = control_plane.url.rsplit(":", 1)[1]
    _fetch(f"http://localhost:{port}/tasks/t1/artifacts/y.txt", tmp_path / "y.txt", prefix)
    assert control_plane.authorizations() == [None]


def test_a_redirect_from_the_control_plane_to_another_host_drops_the_token(
    control_plane: _Server, elsewhere: _Server, tmp_path: Path
) -> None:
    """urllib 默认把请求头带到重定向的新地址：控制面的地址重定向到别处时，跟着去的请求里不能带。"""
    prefix = _prefix(control_plane)
    control_plane.redirects["/tasks/t1/artifacts/r.txt"] = f"{elsewhere.url}/moved.txt"
    got = _fetch(prefix + "r.txt", tmp_path / "r.txt", prefix)
    assert got.read_bytes() == b"content"
    assert control_plane.authorizations("/tasks/t1/artifacts/r.txt") == [f"Bearer {TOKEN}"]
    assert elsewhere.authorizations() == [None]


def test_a_redirect_that_comes_back_does_not_get_the_token_again(
    control_plane: _Server, elsewhere: _Server, tmp_path: Path
) -> None:
    """离开控制面之后又被重定向回来：请求是从离开时没有凭据的那个请求派生的，不重新带上。"""
    prefix = _prefix(control_plane)
    control_plane.redirects["/tasks/t1/artifacts/a.txt"] = f"{elsewhere.url}/hop"
    elsewhere.redirects["/hop"] = f"{control_plane.url}/tasks/t1/artifacts/b.txt"
    _fetch(prefix + "a.txt", tmp_path / "a.txt", prefix)
    assert control_plane.authorizations() == [f"Bearer {TOKEN}", None]
    assert elsewhere.authorizations() == [None]


def test_a_redirect_to_the_very_same_address_does_not_carry_the_token(
    control_plane: _Server, tmp_path: Path
) -> None:
    """重定向之后一律不带，包括重定向到完全相同的地址（各种重定向状态码）。"""
    prefix = _prefix(control_plane)
    for status in (301, 302, 303, 307, 308):
        control_plane.requests.clear()
        path = f"/tasks/t1/artifacts/same{status}.txt"
        control_plane.redirects[path] = path
        control_plane.redirect_status = status
        # 重定向到自己：第一次带，之后不带；urllib 在重定向次数用完之后报错。
        with pytest.raises(ArtifactDownloadError):
            _fetch(prefix + f"same{status}.txt", tmp_path / f"s{status}.txt", prefix)
        auths = control_plane.authorizations()
        assert auths[0] == f"Bearer {TOKEN}", status
        assert len(auths) > 1 and all(a is None for a in auths[1:]), (status, auths)


def test_a_redirect_is_never_followed_with_the_token_even_inside_the_same_prefix(
    control_plane: _Server, tmp_path: Path
) -> None:
    """控制面下载产物不重定向：重定向之后一律不带，指向同一个前缀之下也一样。"""
    prefix = _prefix(control_plane)
    control_plane.redirects["/tasks/t1/artifacts/a.txt"] = (
        f"{control_plane.url}/tasks/t1/artifacts/final.txt"
    )
    control_plane.redirects["/tasks/t1/artifacts/b.txt"] = "/tasks/t1/artifacts/final.txt"
    _fetch(prefix + "a.txt", tmp_path / "a.txt", prefix)
    _fetch(prefix + "b.txt", tmp_path / "b.txt", prefix)
    assert control_plane.authorizations() == [f"Bearer {TOKEN}", None, f"Bearer {TOKEN}", None]


def test_nothing_is_sent_without_a_token_or_without_a_control_plane_address(
    control_plane: _Server, tmp_path: Path
) -> None:
    """本地调试、旧版本的 Agent 或控制面不下发凭据，或者不知道控制面的地址：不带。"""
    prefix = _prefix(control_plane)
    _fetch(prefix + "a.txt", tmp_path / "a.txt", prefix, token=None)
    _fetch(prefix + "b.txt", tmp_path / "b.txt", prefix, token="")
    _fetch(prefix + "c.txt", tmp_path / "c.txt", None)
    assert control_plane.authorizations() == [None, None, None]


def test_a_malformed_address_is_still_requested_but_without_the_token(
    control_plane: _Server, tmp_path: Path
) -> None:
    """不带凭据不是报错：地址写法不规矩时照常发请求（指向外部的地址本来就是允许的用法），只是不带。"""
    prefix = _prefix(control_plane)
    dotted = f"{control_plane.url}/tasks/t1/artifacts/a/b/../c.txt"
    got = _fetch(dotted, tmp_path / "c.txt", prefix)
    assert got.read_bytes() == b"content"
    assert control_plane.authorizations() == [None]


def test_a_reference_that_goes_through_a_proxy_in_another_spelling_carries_no_token(
    control_plane: _Server, elsewhere: _Server, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """经 HTTP 代理时（`http_proxy`、`no_proxy`），这两种写法的请求里不带任务凭据。"""
    proxy = elsewhere
    monkeypatch.setenv("http_proxy", proxy.url)
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    prefix = _prefix(control_plane)
    host = control_plane.url.removeprefix("http://")
    # 正常的引用：控制面在 no_proxy 里，直连，带凭据。
    _fetch(prefix + "ok.txt", tmp_path / "ok.txt", prefix)
    assert control_plane.authorizations() == [f"Bearer {TOKEN}"]
    assert proxy.requests == []
    for spelled in (
        f"http://evil.invalid\\@{host}/tasks/t1/artifacts/a.txt",
        f"http://evil.invalid@{host}/tasks/t1/artifacts/a.txt",
    ):
        proxy.requests.clear()
        try:
            _fetch(spelled, tmp_path / "x.txt", prefix)
        except ArtifactDownloadError:
            pass
        assert proxy.authorizations() == [None], spelled
    assert control_plane.authorizations() == [f"Bearer {TOKEN}"]


ARTIFACTS = "http://127.0.0.1:8080/tasks/t1/artifacts/"
UNDER_PATH = "https://cp.example.com:8443/sfly/tasks/t1/artifacts/"


@pytest.mark.parametrize(
    ("url", "artifacts_url", "sent"),
    [
        # 带：控制面前缀之下、后面接着 tasks/。
        (ARTIFACTS + "a.txt", ARTIFACTS, True),
        ("http://127.0.0.1:8080/tasks/t2/artifacts/a/b.txt", ARTIFACTS, True),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/%E4%B8%96.txt?x=1#y", ARTIFACTS, True),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/a..b.txt", ARTIFACTS, True),
        ("HTTP://127.0.0.1:8080/tasks/t1/artifacts/a", ARTIFACTS, True),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/%252e", ARTIFACTS, False),
        ("http://[::1]:8080/tasks/t1/artifacts/a", "http://[::1]:8080/tasks/t1/artifacts/", True),
        ("HTTPS://CP.Example.COM:8443/sfly/tasks/t9/artifacts/a", UNDER_PATH, True),
        # 不带：前缀之外的同主机地址。
        ("http://127.0.0.1:8080/other-app/a", ARTIFACTS, False),
        ("http://127.0.0.1:8080/", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasksx/t1/artifacts/a", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks", ARTIFACTS, False),
        ("https://cp.example.com:8443/tasks/t1/artifacts/a", UNDER_PATH, False),
        ("https://cp.example.com:8443/sfly/other", UNDER_PATH, False),
        ("https://cp.example.com:8443/Sfly/tasks/t1/artifacts/a", UNDER_PATH, False),
        ("https://cp.example.com:8443/sfly-x/tasks/t1/artifacts/a", UNDER_PATH, False),
        # 不带：别的协议、主机、端口；比较在原文上做，不做别的归一化。
        ("https://127.0.0.1:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://127.0.0.1:8081/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://localhost:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://127.0.0.1.:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://127.0.0.1:08080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://127.0.0.1:+8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://127.0.0.1:٨٠٨٠/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://127.1:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://[::ffff:127.0.0.1]:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        (
            "http://example.com:80/tasks/t1/artifacts/a",
            "http://example.com/tasks/t1/artifacts/",
            False,
        ),
        (
            "http://example.com/tasks/t1/artifacts/a",
            "http://example.com:80/tasks/t1/artifacts/",
            False,
        ),
        ("http://127.0.0.1:8080.evil.test/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("//127.0.0.1:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http:127.0.0.1:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http:/127.0.0.1:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("ftp://127.0.0.1:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("not a url", ARTIFACTS, False),
        # 不带：用户名段。
        ("http://evil.invalid@127.0.0.1:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://evil.invalid:80@127.0.0.1:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://127.0.0.1:8080@evil.invalid/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://evil.invalid%40127.0.0.1:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://127.0.0.1:8080#@evil.invalid/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://127.0.0.1:8080?@evil.invalid/tasks/t1/artifacts/a", ARTIFACTS, False),
        # 不带：反斜杠、空白、控制字符（任何位置）。
        ("http://evil.invalid\\@127.0.0.1:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://127.0.0.1:8080\\@evil.invalid/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks\\t1/artifacts/a", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/a b", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/a\tb", ARTIFACTS, False),
        ("http://127.0.0.1\n:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://ev\til.example@127.0.0.1:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        (" http://127.0.0.1:8080/tasks/t1/artifacts/a", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/a\x00", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/a\u00a0b", ARTIFACTS, False),
        # 不带：路径里的 `..`、`.` 段，编码过的点和斜杠（不分大小写）。
        ("http://127.0.0.1:8080/tasks/t1/artifacts/../../other", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/../other", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/./a", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/a/..", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/%2e%2e/x", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/%2E%2E/x", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/.%2e/x", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/a%2fb", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/a%2Fb", ARTIFACTS, False),
        ("https://cp.example.com:8443/sfly/tasks/t1/artifacts/../../x", UNDER_PATH, False),
        # 不带：路径里有歧义的写法（段以 `..` 开头、编码过的反斜杠和百分号、非 ASCII 字符、
        # 不合法的 UTF-8 编码）。
        ("http://127.0.0.1:8080/tasks/..;/x", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/..%3b/x", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/..%3B/x", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/..a/x", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/...", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/%5c..%5cx", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/%5C..%5Cx", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/a%5cb", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/%252e%252e/x", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/100%25.txt", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/a%25", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/%c0%ae%c0%ae/x", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/%ff", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/\uff0e\uff0e/x", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/\u2025/x", ARTIFACTS, False),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/世界.txt", ARTIFACTS, False),
        ("https://cp.example.com:8443/sfly/tasks/..;/x", UNDER_PATH, False),
        # 带：名称按路径段编码之后的正常写法（合法的 UTF-8 编码、点在名称中间、`..` 不在段的开头）。
        ("http://127.0.0.1:8080/tasks/t1/artifacts/%E4%B8%96%E7%95%8C.txt", ARTIFACTS, True),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/a%20b.txt", ARTIFACTS, True),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/dir/a.b..c", ARTIFACTS, True),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/a%3Bb;c", ARTIFACTS, True),
        # 控制面给的前缀自己不规矩、或不是 `tasks/<id>/artifacts/` 结尾：一律不带。
        (
            "http://127.0.0.1:8080/tasks/t1/artifacts/a",
            "http://127.0.0.1:8080/tasks/t1/artifacts",
            False,
        ),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/a", "http://127.0.0.1:8080/", False),
        (
            "http://127.0.0.1:8080/xtasks/t1/artifacts/a",
            "http://127.0.0.1:8080/xtasks/t1/artifacts/",
            False,
        ),
        (
            "http://127.0.0.1:8080/tasks//artifacts/a",
            "http://127.0.0.1:8080/tasks//artifacts/",
            False,
        ),
        (
            "http://u@127.0.0.1:8080/tasks/t1/artifacts/a",
            "http://u@127.0.0.1:8080/tasks/t1/artifacts/",
            False,
        ),
        (
            "http://127.0.0.1:8080/a/../tasks/t1/artifacts/a",
            "http://127.0.0.1:8080/a/../tasks/t1/artifacts/",
            False,
        ),
        ("http://127.0.0.1:8080/tasks/t1/artifacts/a", "", False),
        ("tasks/t1/artifacts/a", "tasks/t1/artifacts/", False),
    ],
)
def test_the_decision_compares_the_text_under_the_control_planes_prefix(
    url: str, artifacts_url: str, sent: bool
) -> None:
    assert _is_control_plane_download(url, artifacts_url) is sent


def test_the_prefix_is_the_artifacts_address_without_its_tail() -> None:
    assert _control_plane_prefix(ARTIFACTS) == "http://127.0.0.1:8080/"
    assert _control_plane_prefix(UNDER_PATH) == "https://cp.example.com:8443/sfly/"
    assert _control_plane_prefix("http://h/tasks/t1/artifacts") is None
    assert _control_plane_prefix("http://h/x/artifacts/") is None


def test_every_address_that_is_judged_to_be_the_control_plane_is_one_urllib_connects_to_there() -> (
    None
):
    """判断为「可以带」的写法，urllib 实际连的就是控制面的主机和端口（不是别的主机串）。"""
    import http.client
    import urllib.request

    for url in (ARTIFACTS + "a.txt", "HTTP://127.0.0.1:8080/tasks/t1/artifacts/a"):
        assert _is_control_plane_download(url, ARTIFACTS)
        request = urllib.request.Request(url)
        connection = http.client.HTTPConnection(request.host)
        assert (connection.host, connection.port) == ("127.0.0.1", 8080), url
        assert urlsplit(url).hostname == "127.0.0.1"


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
