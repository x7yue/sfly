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
    """假的上游：`files` 里有的 200，`failing` 里的回那个状态码，其余 404；`truncated` 里的
    content-length 比内容长、发完内容就断开；`lengths` 里的 content-length 原样写成给的字节。
    记下每个请求的路径。"""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.failing: dict[str, int] = {}
        self.truncated: set[str] = set()
        self.lengths: dict[str, bytes] = {}
        self.requests: list[str] = []
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                pass

            def do_GET(self) -> None:
                upstream.requests.append(self.path)
                body = upstream.files.get(self.path)
                code = upstream.failing.get(self.path, 200 if body is not None else 404)
                extra = 100 if self.path in upstream.truncated else 0
                length = str(len(body or b"") + extra).encode()
                raw = upstream.lengths.get(self.path, length)
                # 头写成原样的字节（send_header 会按 latin-1 编码、拒绝别的字符）。
                head = f"HTTP/1.0 {code} X\r\n".encode() + b"content-length: " + raw + b"\r\n\r\n"
                self.wfile.write(head + (body or b""))
                self.close_connection = True

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


@pytest.mark.parametrize("broken", ["empty", "truncated"])
def test_a_200_with_an_empty_or_cut_off_body_falls_back_and_is_not_cached(
    upstream: Upstream, tmp_path: Path, broken: str
) -> None:
    # CI 上中科大对 GitHub 的机器回过 200 但内容是空的：uv 的安装脚本随后报校验和对不上。
    pinned = f"/ustc/astral-sh/uv/{mirror.UV_VERSION}/uv-installer.sh"
    upstream.files[pinned] = b"cut" if broken == "truncated" else b""
    if broken == "truncated":
        upstream.truncated.add(pinned)
    upstream.files[f"/github/{mirror.UV_VERSION}/uv-installer.sh"] = b"from github"
    base, server = start_mirror(tmp_path, record=True)
    try:
        assert get(base + LATEST) == (200, b"from github")
    finally:
        server.shutdown()
    # 坏的那份没有留在缓存目录里（临时文件也删了）：缓存里只有 GitHub 的那份。
    files = [p for p in (tmp_path / "objects").rglob("*") if p.is_file()]
    assert sorted(p.suffix for p in files) == ["", ".meta"]


BAD_LENGTHS = ["unknown", "²", "", "-1", "1.0", "+5", "１２", "٣"]


@pytest.mark.parametrize("raw", [*BAD_LENGTHS, " ", "1 2"])
def test_content_length_is_ascii_digits_only(raw: str) -> None:
    assert mirror.content_length(raw) == (False, None)


def test_content_length_valid_and_missing() -> None:
    assert mirror.content_length(" 12 ") == (True, 12)
    assert mirror.content_length("0") == (True, 0)
    assert mirror.content_length(None) == (True, None)


def header_bytes(raw: str) -> bytes:
    """头里的字节：latin-1 写得下的按 latin-1（客户端按 latin-1 解出原字符，例如 `²`），
    写不下的按 UTF-8。"""
    if all(ord(ch) < 256 for ch in raw):
        return raw.encode("latin-1")
    return raw.encode()


def cached_files(cache: Path) -> list[Path]:
    return [p for p in (cache / "objects").rglob("*") if p.is_file()]


@pytest.mark.parametrize("raw", BAD_LENGTHS)
def test_a_bad_content_length_fails_that_source_and_falls_back(
    upstream: Upstream, tmp_path: Path, raw: str
) -> None:
    # 正文不是空的：拒收是因为长度头，不是因为空正文。
    pinned = f"/ustc/astral-sh/uv/{mirror.UV_VERSION}/uv-installer.sh"
    github = f"/github/{mirror.UV_VERSION}/uv-installer.sh"
    upstream.files[pinned] = b"from ustc"
    upstream.lengths[pinned] = header_bytes(raw)
    upstream.files[github] = b"from github"
    base, server = start_mirror(tmp_path, record=True)
    try:
        assert get(base + LATEST) == (200, b"from github")
    finally:
        server.shutdown()
    assert upstream.requests == [pinned, github]
    assert sorted(p.suffix for p in cached_files(tmp_path)) == ["", ".meta"]
    assert (
        next(p for p in cached_files(tmp_path) if p.suffix == "")
    ).read_bytes() == b"from github"


def test_bad_content_length_on_every_source_is_502_and_not_cached(
    upstream: Upstream, tmp_path: Path
) -> None:
    pinned = f"/ustc/astral-sh/uv/{mirror.UV_VERSION}/uv-installer.sh"
    github = f"/github/{mirror.UV_VERSION}/uv-installer.sh"
    for path in (pinned, github):
        upstream.files[path] = b"body"
        upstream.lengths[path] = b"unknown"
    base, server = start_mirror(tmp_path, record=True)
    try:
        assert get(base + LATEST)[0] == 502
    finally:
        server.shutdown()
    assert upstream.requests == [pinned, github]
    assert cached_files(tmp_path) == []


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
