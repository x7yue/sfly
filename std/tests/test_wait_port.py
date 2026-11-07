"""`wait_port`：等本地端口可以连接（`sfly.testing.run_node`，真实的套接字）。"""

from __future__ import annotations

import socket
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from sfly.testing import run_node
from sfly_std.wait_port import wait_port


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port: int = s.getsockname()[1]
        return port


@pytest.fixture
def listener() -> Iterator[socket.socket]:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        yield s


def test_succeeds_when_the_port_accepts_connections(
    tmp_path: Path, listener: socket.socket
) -> None:
    port = listener.getsockname()[1]

    result = run_node(wait_port, {"port": port}, work_dir=tmp_path)

    assert result.status == "success", result.error


def test_keeps_trying_until_the_port_starts_listening(tmp_path: Path) -> None:
    port = free_port()
    server = socket.socket()

    def listen_later() -> None:
        time.sleep(0.5)
        server.bind(("127.0.0.1", port))
        server.listen()

    thread = threading.Thread(target=listen_later)
    thread.start()
    try:
        started = time.monotonic()
        result = run_node(wait_port, {"port": port, "poll": 0.1}, work_dir=tmp_path)
        elapsed = time.monotonic() - started
    finally:
        thread.join()
        server.close()

    assert result.status == "success", result.error
    assert elapsed >= 0.5


def test_fails_after_wait_saying_what_it_waited_for(tmp_path: Path) -> None:
    port = free_port()

    started = time.monotonic()
    result = run_node(wait_port, {"port": port, "wait": 0.5, "poll": 0.1}, work_dir=tmp_path)
    elapsed = time.monotonic() - started

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message.startswith(
        f"TimeoutError: 等待端口 127.0.0.1:{port} 可以连接超时：已等 0.5 秒，"
        "最后一次连接：Connection refused"
    ), result.error.message
    assert 0.5 <= elapsed < 5


def test_host_selects_the_address_to_connect_to(tmp_path: Path) -> None:
    port = free_port()

    result = run_node(
        wait_port,
        {"host": "localhost", "port": port, "wait": 0, "poll": 0.1},
        work_dir=tmp_path,
    )

    assert result.status == "failed"
    assert result.error is not None
    assert f"等待端口 localhost:{port} 可以连接超时：已等 0 秒" in result.error.message
