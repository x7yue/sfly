"""`port_assert`：在真实的执行器进程里检查一次端口能否连接（`sfly.testing.run_node`）。"""

from __future__ import annotations

import socket
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from sfly.testing import Execution, run_node
from sfly_std.port_assert import port_assert


def run(tmp_path: Path, **inputs: Any) -> Execution:
    return run_node(port_assert, inputs, work_dir=tmp_path / "task")


def failure(result: Execution) -> str:
    assert result.status == "failed", result.outputs
    assert result.error is not None
    return result.error.message


@pytest.fixture
def listening() -> Iterator[int]:
    """本机一个正在监听的端口。"""
    with socket.create_server(("127.0.0.1", 0)) as server:
        yield server.getsockname()[1]


@pytest.fixture
def closed() -> int:
    """本机一个没有监听的端口（刚释放）。"""
    with socket.create_server(("127.0.0.1", 0)) as server:
        port: int = server.getsockname()[1]
    return port


def test_passes_when_the_port_accepts_connections(tmp_path: Path, listening: int) -> None:
    result = run(tmp_path, port=listening)

    assert result.status == "success", result.error
    assert result.outputs == {"passed": True}


def test_fails_with_the_connect_error_when_the_port_is_closed(tmp_path: Path, closed: int) -> None:
    assert failure(run(tmp_path, port=closed)) == (
        f"sfly_std.port_assert.PortAssertionFailed: 127.0.0.1:{closed} 应能连接，"
        "实际连接失败：[Errno 111] Connection refused"
    )


def test_reachable_false_passes_when_closed_and_fails_when_listening(
    tmp_path: Path, closed: int, listening: int
) -> None:
    assert run(tmp_path, port=closed, reachable=False).status == "success"
    assert failure(run(tmp_path, port=listening, reachable=False)) == (
        f"sfly_std.port_assert.PortAssertionFailed: 127.0.0.1:{listening} 应不能连接，实际能连接"
    )


def test_fails_either_way_when_the_host_cannot_be_resolved(tmp_path: Path) -> None:
    # .invalid 保证解析不到（RFC 6761）：主机名写错时不能当成「不能连接」而通过。
    for reachable in (True, False):
        message = failure(run(tmp_path, host="nosuch.invalid", port=80, reachable=reachable))
        assert message.startswith(
            "sfly_std.port_assert.PortAssertionFailed: 无法解析主机名 nosuch.invalid："
        )


def test_rejects_a_port_out_of_range(tmp_path: Path) -> None:
    assert (
        failure(run(tmp_path, port=70000)) == "ValueError: port 必须在 1–65535 之间，实际为 70000"
    )
