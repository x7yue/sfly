"""评测的镜像站录缓存时取 uv（#847）：`LatestRelease` 下的文件取固定版本的，
不取会变的 `LatestRelease`；上游出错时说出来（502），不当成「没有这个文件」。
上游是本机起的假服务。"""

from __future__ import annotations

import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import mirror
import pytest

LATEST = "/github-release/astral-sh/uv/LatestRelease/uv-installer.sh"


class Upstream:
    """假的上游：`files` 里有的 200，`failing` 里的回那个状态码，其余 404；记下每个请求的路径。"""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.failing: dict[str, int] = {}
        self.requests: list[str] = []
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                pass

            def do_GET(self) -> None:
                upstream.requests.append(self.path)
                body = upstream.files.get(self.path)
                code = upstream.failing.get(self.path, 200 if body is not None else 404)
                self.send_response(code)
                self.send_header("content-length", str(len(body or b"")))
                self.end_headers()
                self.wfile.write(body or b"")

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


def start_mirror(cache: Path, *, record: bool) -> tuple[str, mirror.Server]:
    handler = type("H", (mirror.Handler,), {"store": mirror.Store(cache), "record": record})
    server = mirror.Server(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}", server


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch) -> Iterator[Upstream]:
    fake = Upstream()
    monkeypatch.setitem(mirror.UPSTREAMS, "github-release", f"{fake.url}/ustc")
    monkeypatch.setattr(mirror, "UV_GITHUB", f"{fake.url}/github/{mirror.UV_VERSION}/")
    yield fake
    fake.server.shutdown()


def get(url: str) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def test_latest_release_is_fetched_from_the_pinned_version(
    upstream: Upstream, tmp_path: Path
) -> None:
    pinned = f"/ustc/astral-sh/uv/{mirror.UV_VERSION}/uv-installer.sh"
    upstream.files[pinned] = b"installer"
    base, server = start_mirror(tmp_path, record=True)
    try:
        assert get(base + LATEST) == (200, b"installer")
    finally:
        server.shutdown()
    # 没有去取会变的 LatestRelease。
    assert upstream.requests == [pinned]

    # 离线（只从缓存返回）时按 LatestRelease 的路径命中。
    base, server = start_mirror(tmp_path, record=False)
    try:
        assert get(base + LATEST) == (200, b"installer")
    finally:
        server.shutdown()


def test_pinned_version_gone_from_the_mirror_falls_back_to_github(
    upstream: Upstream, tmp_path: Path
) -> None:
    upstream.files[f"/github/{mirror.UV_VERSION}/uv-installer.sh"] = b"from github"
    base, server = start_mirror(tmp_path, record=True)
    try:
        assert get(base + LATEST) == (200, b"from github")
    finally:
        server.shutdown()
    assert upstream.requests == [
        f"/ustc/astral-sh/uv/{mirror.UV_VERSION}/uv-installer.sh",
        f"/github/{mirror.UV_VERSION}/uv-installer.sh",
    ]


def test_mirror_error_on_the_pinned_version_also_falls_back_to_github(
    upstream: Upstream, tmp_path: Path
) -> None:
    upstream.failing[f"/ustc/astral-sh/uv/{mirror.UV_VERSION}/uv-installer.sh"] = 503
    upstream.files[f"/github/{mirror.UV_VERSION}/uv-installer.sh"] = b"from github"
    base, server = start_mirror(tmp_path, record=True)
    try:
        assert get(base + LATEST) == (200, b"from github")
    finally:
        server.shutdown()


def test_upstream_errors_are_502_not_404_and_are_not_cached(
    upstream: Upstream, tmp_path: Path
) -> None:
    upstream.failing[f"/ustc/astral-sh/uv/{mirror.UV_VERSION}/uv-installer.sh"] = 503
    upstream.failing[f"/github/{mirror.UV_VERSION}/uv-installer.sh"] = 502
    upstream.failing["/ustc/astral-sh/python-build-standalone/x.tar.gz"] = 429
    base, server = start_mirror(tmp_path, record=True)
    try:
        code, body = get(base + LATEST)
        assert code == 502
        assert "上游没有取到" in body.decode()
        assert get(base + "/github-release/astral-sh/python-build-standalone/x.tar.gz")[0] == 502
        # 上游真的没有（404）：照旧 404。
        assert get(base + "/github-release/astral-sh/nothing")[0] == 404
    finally:
        server.shutdown()
    assert list((tmp_path / "objects").rglob("*.meta")) == []
