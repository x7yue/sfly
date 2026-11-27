import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest
from sfly.testing import run_node

from svc_stock.stock import stock_check


@pytest.fixture
def service() -> Iterator[str]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            pass

        def do_GET(self) -> None:
            known = {"/stock/X-1": {"sku": "X-1", "quantity": 5}}
            body = known.get(self.path)
            data = json.dumps(body).encode()
            self.send_response(200 if body is not None else 404)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def test_stock_check(service: str) -> None:
    result = run_node(stock_check, {"base_url": service, "sku": "X-1"})
    assert result.status == "success"
    assert result.outputs == {"sku": "X-1", "quantity": 5, "in_stock": True}
    assert [a.name for a in result.actions] == ["查询库存"]


def test_stock_check_unknown_sku(service: str) -> None:
    result = run_node(stock_check, {"base_url": service, "sku": "Z-9"})
    assert result.status == "failed"
