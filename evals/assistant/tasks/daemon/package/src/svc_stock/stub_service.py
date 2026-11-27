"""库存服务的本地替身：`python -m svc_stock.stub_service --port 8765`，一直运行到被结束。

GET /health 返回 {"status": "ok"}；GET /stock/<商品编号> 返回 {"sku", "quantity"}，
没有这个商品时 404。
"""

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

STOCK = {"A-100": 37, "B-200": 0, "C-300": 112}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health":
            self._reply(200, {"status": "ok"})
            return
        sku = self.path.removeprefix("/stock/")
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


def main() -> None:
    parser = argparse.ArgumentParser(description="库存服务的本地替身")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"库存服务替身在 http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
