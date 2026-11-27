import socket
import subprocess
import sys
import time
from collections.abc import Iterator

import pytest
from sfly.testing import run_node

from svc_stock.stock import stock_check


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def reachable(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


@pytest.fixture
def stub() -> Iterator[str]:
    port = free_port()
    argv = [sys.executable, "-m", "svc_stock.stub_service", "--port", str(port)]
    proc = subprocess.Popen(argv)
    try:
        deadline = time.monotonic() + 20
        while not reachable(port):
            assert proc.poll() is None, "替身没起来"
            assert time.monotonic() < deadline, "替身 20 秒内没有能连上"
            time.sleep(0.1)
        yield f"http://127.0.0.1:{port}"
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def test_stock_check_against_the_stub(stub: str) -> None:
    result = run_node(stock_check, {"base_url": stub, "sku": "A-100"})
    assert result.status == "success"
    assert result.outputs == {"sku": "A-100", "quantity": 37, "in_stock": True}


def test_unknown_sku_fails(stub: str) -> None:
    result = run_node(stock_check, {"base_url": stub, "sku": "Z-9"})
    assert result.status == "failed"
