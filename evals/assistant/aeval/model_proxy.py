"""宿主机上的模型转发口：容器里的 pi 指向它，它在转发时加上凭据。

- 路径的第一段是 pi 配置里的提供方名
  （`/example/responses` → 提供方 example 的 `baseUrl` + `/responses`）。
- 凭据在进程内从 pi 自己的配置里读（`models.json` 的 `apiKey`，
  或 `auth.json` 里 `type` 为 `api_key` 的项），
  只放进转发出去的请求头，不打印、不写日志、不写文件。客户端带来的凭据头一律丢掉。
- 只转发配置里有的提供方；出错时只写状态码和提供方名。
- 上游要经代理时设 `HTTPS_PROXY`（只支持 http:// 代理，用 CONNECT 隧道）。

用法：`python3 -m aeval.model_proxy --port 18900 [--pi-dir ~/.pi/agent]`。
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import socketserver
import ssl
import sys
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

# 不往上游转发的请求头：逐跳头、凭据、以及要按上游重写的 Host。
_DROP = {
    "host",
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "te",
    "upgrade",
    "authorization",
    "x-api-key",
    "api-key",
    "content-length",
}


@dataclass(frozen=True)
class Upstream:
    name: str
    base_url: str
    api: str
    # 凭据不进 repr：异常和日志里打印出这个对象时也不会带出来。
    key: str = field(repr=False)

    def auth_headers(self) -> dict[str, str]:
        if self.api == "anthropic-messages":
            return {"x-api-key": self.key}
        return {"authorization": f"Bearer {self.key}"}


def _resolve_key(value: Any) -> str | None:
    """`apiKey` 的取值：字面量或 `$环境变量`。`!命令` 不执行（转发口不替 pi 跑命令）。"""
    if not isinstance(value, str) or not value:
        return None
    if value.startswith("!"):
        return None
    if value.startswith("$"):
        return os.environ.get(value[1:]) or None
    return value


def load_upstreams(pi_dir: Path) -> dict[str, Upstream]:
    models = json.loads((pi_dir / "models.json").read_text())
    auth_path = pi_dir / "auth.json"
    auth: dict[str, Any] = json.loads(auth_path.read_text()) if auth_path.exists() else {}
    upstreams: dict[str, Upstream] = {}
    for name, provider in models.get("providers", {}).items():
        key = _resolve_key(provider.get("apiKey"))
        saved = auth.get(name)
        if key is None and isinstance(saved, dict) and saved.get("type") == "api_key":
            key = _resolve_key(saved.get("key"))
        base = provider.get("baseUrl")
        if key is None or not isinstance(base, str):
            continue
        upstreams[name] = Upstream(name, base.rstrip("/"), str(provider.get("api", "")), key)
    return upstreams


def _connect(base_url: str) -> http.client.HTTPConnection:
    parts = urlsplit(base_url)
    host = parts.hostname or ""
    port = parts.port
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if parts.scheme == "https":
        context = ssl.create_default_context()
        if proxy:
            p = urlsplit(proxy)
            conn = http.client.HTTPSConnection(
                p.hostname or "", p.port or 80, context=context, timeout=600
            )
            conn.set_tunnel(host, port or 443)
            return conn
        return http.client.HTTPSConnection(host, port or 443, context=context, timeout=600)
    return http.client.HTTPConnection(host, port or 80, timeout=600)


# 只转发调模型要用的接口：转发口带着凭据、不验调用方的身份，助手的命令也连得到它，
# 别的接口（文件、批处理、账户……）一律不转。
_ALLOWED = {
    "POST": ("chat/completions", "responses", "messages"),
    "GET": ("models",),
}


def allowed(method: str, rest: str) -> bool:
    path = rest.split("?", 1)[0].rstrip("/")
    return any(path == end or path.endswith(f"/{end}") for end in _ALLOWED.get(method, ()))


class _Handler(BaseHTTPRequestHandler):
    upstreams: dict[str, Upstream] = {}
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _forward(self) -> None:
        first, _, rest = self.path.lstrip("/").partition("/")
        upstream = self.upstreams.get(first)
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        if upstream is None:
            self._reply(404, f"没有配置提供方 {first!r}")
            return
        if not allowed(self.command, rest):
            self._reply(
                403, "转发口只转发模型接口（chat/completions、responses、messages、models）"
            )
            return
        target = urlsplit(upstream.base_url + "/" + rest)
        path = target.path + (f"?{target.query}" if target.query else "")
        headers = {k: v for k, v in self.headers.items() if k.lower() not in _DROP}
        headers.update(upstream.auth_headers())
        headers["content-length"] = str(len(body))
        try:
            conn = _connect(upstream.base_url)
            conn.request(self.command, path, body=body, headers=headers)
            resp = conn.getresponse()
        except OSError as error:
            sys.stderr.write(f"转发到 {upstream.name} 失败：{type(error).__name__}\n")
            self._reply(502, f"转发到 {upstream.name} 失败")
            return
        if resp.status >= 400:
            sys.stderr.write(f"{upstream.name} {self.command} /{rest} -> {resp.status}\n")
        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() not in {"transfer-encoding", "connection", "content-length"}:
                self.send_header(k, v)
        self.send_header("transfer-encoding", "chunked")
        self.send_header("connection", "close")
        try:
            self.end_headers()
        except OSError:
            # 客户端在上游回复之前就走了（超时放弃）：不用再转发。
            conn.close()
            self.close_connection = True
            return
        try:
            while True:
                chunk = resp.read1(65536)
                if not chunk:
                    break
                self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (OSError, http.client.HTTPException) as error:
            # 上游中途断开：不写结束块，客户端会看到连接被断开（pi 会自动重试）。
            sys.stderr.write(f"{upstream.name} 的响应中途断开：{type(error).__name__}\n")
        finally:
            conn.close()
        self.close_connection = True

    def _reply(self, status: int, message: str) -> None:
        data = json.dumps({"error": {"message": message}}, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = _forward
    do_POST = _forward


class _Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_server(
    upstreams: dict[str, Upstream], host: str = "127.0.0.1", port: int = 0
) -> socketserver.TCPServer:
    handler = type("Handler", (_Handler,), {"upstreams": upstreams})
    return _Server((host, port), handler)


def serve(port: int, pi_dir: Path, host: str = "127.0.0.1") -> None:
    upstreams = load_upstreams(pi_dir)
    with make_server(upstreams, host, port) as server:
        names = "、".join(sorted(upstreams)) or "（无）"
        sys.stderr.write(f"模型转发口在 {host}:{port}，提供方：{names}\n")
        server.serve_forever()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=18900)
    # Docker Desktop 的 host.docker.internal 能连到宿主机的 127.0.0.1，不必监听所有网卡。
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--pi-dir", type=Path, default=Path.home() / ".pi" / "agent")
    args = parser.parse_args(argv)
    serve(args.port, args.pi_dir, args.host)
    return 0


if __name__ == "__main__":
    sys.exit(main())
