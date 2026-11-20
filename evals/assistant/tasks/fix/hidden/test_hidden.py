"""题目「修」里助手看不到的断言：用和被测服务同样格式的假服务执行 inspect_items。

由判分在节点包的 venv 里运行：`AEVAL_PROJECT` 是节点包目录。
"""

import json
import os
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest
from sfly.cli.build import load_project, scan_nodes
from sfly.testing import run_node

PROJECT = Path(os.environ["AEVAL_PROJECT"])


def entry(name: str) -> str:
    nodes = scan_nodes(load_project(PROJECT))
    found = next((n for n in nodes if n["name"] == name), None)
    assert found is not None, f"节点包里没有名为 {name} 的节点"
    return str(found["entry"])


def serve(routes: dict[str, tuple[int, Any]]) -> Iterator[str]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            pass

        def do_GET(self) -> None:
            status, body = routes.get(self.path, (404, {"error": "no"}))
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def items(*prices: str) -> dict[str, Any]:
    rows = [{"id": f"i{n}", "name": f"n{n}", "price": p} for n, p in enumerate(prices)]
    return {"items": rows, "total": len(rows)}


@pytest.fixture
def service() -> Iterator[str]:
    yield from serve(
        {"/health": (200, {"status": "ok"}), "/items": (200, items("12.50", "20.00", "10.00"))}
    )


@pytest.fixture
def odd_prices() -> Iterator[str]:
    yield from serve({"/items": (200, items("0.10", "0.20", "1.05", "3"))})


@pytest.fixture
def broken() -> Iterator[str]:
    yield from serve({"/items": (500, {"error": "boom"})})


def test_counts_and_sums_string_prices(service: str) -> None:
    result = run_node(entry("inspect_items"), {"base_url": service, "min_items": 3})
    assert result.status == "success", result.error
    assert result.outputs["item_count"] == 3
    assert result.outputs["total_price"] == pytest.approx(42.5)


def test_sum_has_no_float_noise(odd_prices: str) -> None:
    result = run_node(entry("inspect_items"), {"base_url": odd_prices})
    assert result.status == "success", result.error
    assert result.outputs["item_count"] == 4
    assert result.outputs["total_price"] == pytest.approx(4.35, abs=1e-9)


def test_still_fails_when_too_few(service: str) -> None:
    result = run_node(entry("inspect_items"), {"base_url": service, "min_items": 4})
    assert result.status == "failed"


def test_fails_on_server_error(broken: str) -> None:
    result = run_node(entry("inspect_items"), {"base_url": broken})
    assert result.status == "failed"


def test_wait_ready_still_works(service: str) -> None:
    result = run_node(entry("wait_ready"), {"base_url": service})
    assert result.status == "success", result.error
