"""库存服务的本地替身：`python -m svc_stock.stub_service --port 8765`，一直运行到被结束。

GET /health 返回 {"status": "ok"}；GET /stock/<商品编号> 返回 {"sku", "quantity"}，
没有这个商品时 404。起来时在 /tmp/svc-stock-stub/started 记一行，每次查库存在 requests.jsonl 记一行
（商品编号、时间），排查用。
"""

import argparse
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

RECORD_DIR = Path("/tmp/svc-stock-stub")

STOCK = {"A-100": 37, "B-200": 0, "C-300": 112}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health":
            self._reply(200, {"status": "ok"})
            return
        sku = self.path.removeprefix("/stock/")
        if self.path.startswith("/stock/"):
            record("requests.jsonl", {"sku": sku, "time": time.time()})
        if self.path.startswith("/stock/") and sku in STOCK:
            self._reply(200, {"sku": sku, "quantity": STOCK[sku]})
        else:
            self._reply(404, {"error": f"没有 {self.path}"})

    def _reply(self, status: int, body: Any) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def record(name: str, line: dict[str, Any]) -> None:
    RECORD_DIR.mkdir(parents=True, exist_ok=True)
    with (RECORD_DIR / name).open("a", encoding="utf-8") as f:
        f.write(json.dumps(line) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="库存服务的本地替身")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    record("started", {"pid": os.getpid(), "port": args.port, "time": time.time()})
    print(f"库存服务替身在 http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
