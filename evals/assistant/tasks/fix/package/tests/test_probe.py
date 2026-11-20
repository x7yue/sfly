import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest
from sfly.testing import run_node

from svc_probe.probe import inspect_items, wait_ready

ITEMS = [{"id": "a1", "price": 12.5}, {"id": "b2", "price": 20}, {"id": "c3", "price": 10}]


@pytest.fixture
def service() -> Iterator[str]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            pass

        def do_GET(self) -> None:
            body = {"/health": {"status": "ok"}, "/items": ITEMS}.get(self.path)
            data = json.dumps(body).encode()
            self.send_response(200 if body is not None else 404)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def test_wait_ready(service: str) -> None:
    result = run_node(wait_ready, {"base_url": service})
    assert result.status == "success"


def test_inspect_items(service: str) -> None:
    result = run_node(inspect_items, {"base_url": service, "min_items": 3})
    assert result.status == "success"
    assert result.outputs == {"item_count": 3, "total_price": 42.5}
    assert [a.name for a in result.actions] == ["请求商品列表"]


def test_inspect_items_too_few(service: str) -> None:
    result = run_node(inspect_items, {"base_url": service, "min_items": 5})
    assert result.status == "failed"
