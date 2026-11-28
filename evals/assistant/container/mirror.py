"""评测环境里的镜像站：PyPI 镜像和 GitHub Release 镜像，控制面把它们下发给 Agent 和 `sfly init`。

两种模式：
- `record`：缓存里没有的从上游（默认中科大镜像）取，存进缓存再返回；
- `serve`：只从缓存返回，没有就 404。离线包里用这个模式，断网的环境照样能装 uv、Python 和依赖。

缓存按「路径 + 要的格式」存：PyPI 的 simple 页面按 Accept 有 HTML 和 JSON 两种。
页面里的文件链接是相对地址（`../../packages/…`），所以下载文件也经过这里。
只用标准库，在工作台镜像自带的 python3 里运行。
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import shutil
import socketserver
import sys
import tempfile
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

UPSTREAMS = {
    "pypi": "https://mirrors.ustc.edu.cn/pypi",
    "github-release": "https://mirrors.ustc.edu.cn/github-release",
}

JSON_SIMPLE = "application/vnd.pypi.simple.v1+json"

# 录缓存时 uv 用的固定版本（#847）。Agent 和 install.sh 按产品的写法从
# `astral-sh/uv/LatestRelease/` 取 uv；中科大镜像只留最新的一个版本，`LatestRelease` 跟着上游变。
# 录缓存时这个路径下的文件取固定版本的：先从中科大取，中科大没取到（已经换成新版本，或者出错）时
# 从 GitHub 上这个版本的 Release 取。缓存仍按 `LatestRelease` 的路径存，离线时照样命中。
UV_VERSION = "0.13.10"
UV_LATEST = "/github-release/astral-sh/uv/LatestRelease/"
UV_GITHUB = f"https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/"


def upstream_urls(path: str, prefix: str) -> list[str]:
    """录缓存时这个路径依次去哪里取：前一个没取到才取下一个（uv 的固定版本有两个来源）。"""
    if path.startswith(UV_LATEST):
        name = path[len(UV_LATEST) :]
        return [f"{UPSTREAMS[prefix]}/astral-sh/uv/{UV_VERSION}/{name}", UV_GITHUB + name]
    return [UPSTREAMS[prefix] + path[len(prefix) + 1 :]]


def cache_key(path: str, accept: str) -> str:
    """缓存文件名：路径的哈希，simple 页面再按要的格式区分。"""
    flavor = "json" if JSON_SIMPLE in accept and "/simple" in path else "raw"
    return hashlib.sha256(f"{flavor} {path}".encode()).hexdigest()


class Store:
    def __init__(self, root: Path) -> None:
        self.root = root
        (root / "objects").mkdir(parents=True, exist_ok=True)

    def _paths(self, key: str) -> tuple[Path, Path]:
        base = self.root / "objects" / key[:2] / key
        return base, base.with_suffix(".meta")

    def get(self, key: str) -> tuple[Path, dict[str, Any]] | None:
        body, meta = self._paths(key)
        if body.exists() and meta.exists():
            return body, json.loads(meta.read_text())
        return None

    def put(self, key: str, source: Any, meta: dict[str, Any], length: int | None) -> Path | None:
        """存下来返回文件；取到的是空的，或者和 content-length 对不上时不存，返回 None。"""
        body, meta_path = self._paths(key)
        body.parent.mkdir(parents=True, exist_ok=True)
        tmp = tempfile.NamedTemporaryFile(dir=body.parent, delete=False)
        try:
            with tmp:
                shutil.copyfileobj(source, tmp, 1 << 20)
            size = Path(tmp.name).stat().st_size
            if size == 0 or (length is not None and size != length):
                return None
            os.replace(tmp.name, body)
        finally:
            Path(tmp.name).unlink(missing_ok=True)
        meta_path.write_text(json.dumps(meta))
        return body


class Handler(BaseHTTPRequestHandler):
    store: Store
    record = False
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}\n")

    def do_HEAD(self) -> None:
        self._serve(head=True)

    def do_GET(self) -> None:
        self._serve(head=False)

    def _serve(self, head: bool) -> None:
        path = self.path.split("#", 1)[0]
        prefix = path.lstrip("/").split("/", 1)[0]
        accept = self.headers.get("accept", "")
        key = cache_key(path, accept)
        hit: tuple[Path, dict[str, Any]] | int | None = self.store.get(key)
        if hit is None and self.record and prefix in UPSTREAMS:
            hit = self._fetch(path, prefix, accept, key)
        if hit is None or isinstance(hit, int):
            code = 404 if hit is None else hit
            where = "镜像里没有" if hit is None else f"上游没有取到（{code}，原因在镜像站的日志里）"
            self._status(code, f"{where} {path}")
            return
        body, meta = hit
        self.send_response(200)
        self.send_header("content-type", meta.get("content_type", "application/octet-stream"))
        self.send_header("content-length", str(body.stat().st_size))
        self.end_headers()
        if not head:
            with body.open("rb") as f:
                shutil.copyfileobj(f, self.wfile, 1 << 20)

    def _fetch(
        self, path: str, prefix: str, accept: str, key: str
    ) -> tuple[Path, dict[str, Any]] | int:
        """取到了返回缓存的文件；都没取到返回给客户端的状态码（看最后一个来源）：上游 404 是 404，
        别的失败（5xx、限流、连不上、200 但内容是空的或不完整）是 502。"""
        code = 404
        for url in upstream_urls(path, prefix):
            request = urllib.request.Request(
                url, headers={"accept": accept or "*/*", "user-agent": "sfly-aeval-mirror/1"}
            )
            try:
                with urllib.request.urlopen(request, timeout=120) as resp:
                    meta = {
                        "content_type": resp.headers.get("content-type", ""),
                        "url": resp.geturl(),
                    }
                    length = resp.headers.get("content-length")
                    body = self.store.put(key, resp, meta, int(length) if length else None)
                    if body is not None:
                        return body, meta
                    sys.stderr.write(f"上游 {url} 返回 200，但内容是空的或和长度对不上\n")
                    code = 502
            except urllib.error.HTTPError as error:
                sys.stderr.write(f"上游 {url} 返回 {error.code}（最后的地址 {error.geturl()}）\n")
                code = 404 if error.code == 404 else 502
            except (OSError, http.client.HTTPException) as error:
                sys.stderr.write(f"上游 {url} 失败：{error!r}\n")
                code = 502
        return code

    def _status(self, code: int, message: str) -> None:
        data = message.encode()
        self.send_response(code)
        self.send_header("content-type", "text/plain; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="评测环境的镜像站")
    parser.add_argument("mode", choices=["record", "serve"])
    parser.add_argument("--cache", type=Path, default=Path("/cache"))
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args(argv)
    Handler.store = Store(args.cache)
    Handler.record = args.mode == "record"
    with Server(("0.0.0.0", args.port), Handler) as server:
        sys.stderr.write(f"镜像站（{args.mode}）在 :{args.port}，缓存 {args.cache}\n")
        server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
