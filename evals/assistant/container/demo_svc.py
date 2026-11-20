"""一个通用的 HTTP 服务。

- `GET /health` → `{"status": "ok"}`
- `GET /items` → `{"items": [{"id", "name", "price"}…], "total": 条目数}`
- 每个请求在 `/var/log/demo-svc/access.log` 记一行：时间、级别、方法、路径、状态码、耗时。

只用标准库，在工作台镜像自带的 python3 里运行。
"""

from __future__ import annotations

import argparse
import json
import socketserver
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

ITEMS = [
    {"id": "a1", "name": "alpha", "price": "12.50"},
    {"id": "b2", "name": "beta", "price": "20.00"},
    {"id": "c3", "name": "gamma", "price": "10.00"},
]

ACCESS_LOG = Path("/var/log/demo-svc/access.log")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        started = time.monotonic()
        body: dict[str, object]
        if self.path == "/health":
            status, body = 200, {"status": "ok"}
        elif self.path == "/items":
            status, body = 200, {"items": ITEMS, "total": len(ITEMS)}
        else:
            status, body = 404, {"error": f"没有 {self.path}"}
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        elapsed = (time.monotonic() - started) * 1000
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        level = "INFO" if status < 400 else "WARN"
        with ACCESS_LOG.open("a") as f:
            f.write(f"{now} {level} GET {self.path} {status} {elapsed:.1f}ms\n")


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="被测服务")
    parser.add_argument("--port", type=int, default=9000)
    args = parser.parse_args(argv)
    ACCESS_LOG.parent.mkdir(parents=True, exist_ok=True)
    with Server(("0.0.0.0", args.port), Handler) as server:
        sys.stderr.write(f"被测服务在 :{args.port}\n")
        server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
