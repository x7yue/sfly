"""`sfly_std.waiting`：直接调用等待与轮询的辅助函数。"""

from __future__ import annotations

import socket
import threading
import time
from pathlib import Path

import pytest
from direct_context import DirectRun

from sfly_std.waiting import poll_until, wait_for_file, wait_for_port


def test_poll_until_returns_the_value_and_how_long_it_waited() -> None:
    calls = []

    def check() -> str | None:
        calls.append(1)
        return "好了" if len(calls) == 3 else None

    result = poll_until(check, what="条件成立", wait=5, poll=0.05)

    assert result.value == "好了" and len(calls) == 3
    assert 0.1 <= result.waited < 2


def test_poll_until_times_out_with_what_and_the_detail() -> None:
    with pytest.raises(TimeoutError, match="等待条件成立超时：已等 0.2 秒.*还差一点"):
        poll_until(lambda: None, what="条件成立", wait=0.2, poll=0.05, detail=lambda: "还差一点")
    # 不给 detail 时信息到「已等 … 秒」为止。
    with pytest.raises(TimeoutError) as error:
        poll_until(lambda: None, what="条件成立", wait=0.1, poll=0.05)
    assert str(error.value) == "等待条件成立超时：已等 0.1 秒"


def test_poll_until_validates_wait_and_poll() -> None:
    with pytest.raises(ValueError, match="wait 不能为负数，实际为 -1"):
        poll_until(lambda: True, what="x", wait=-1, poll=0.1)
    with pytest.raises(ValueError, match="poll 必须大于 0，实际为 0"):
        poll_until(lambda: True, what="x", wait=1, poll=0)


def test_wait_for_port_returns_once_something_listens(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    port = server.getsockname()[1]
    threading.Timer(0.4, server.listen).start()
    try:
        ready = wait_for_port(run.ctx, port, wait=10, poll=0.1)
    finally:
        server.close()

    assert (ready.host, ready.port) == ("127.0.0.1", port)
    assert 0.2 <= ready.waited < 5


def test_wait_for_port_times_out_naming_the_address_and_the_last_error(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]

    with pytest.raises(TimeoutError, match=rf"127\.0\.0\.1:{port}.*最后一次连接"):
        wait_for_port(run.ctx, port, wait=0.3, poll=0.1)
    with pytest.raises(ValueError):
        wait_for_port(run.ctx, 70000)


def test_wait_for_file_waits_for_the_file_to_exist_and_stop_changing(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)
    report = tmp_path / "report.txt"

    def write() -> None:
        time.sleep(0.3)
        report.write_text("a")
        time.sleep(0.3)
        report.write_text("abc")

    writer = threading.Thread(target=write)
    writer.start()
    started = time.monotonic()
    try:
        ready = wait_for_file(run.ctx, report, stable=0.8, wait=10, poll=0.1)
    finally:
        writer.join()

    assert ready.size == 3 and ready.path == report  # 路径参数可以是 Path，返回的路径是 Path
    assert ready.waited >= 0.3 + 0.3 + 0.8 - 0.2
    assert time.monotonic() - started >= 0.3 + 0.3 + 0.8 - 0.2  # 最后一次写入之后又静止了 stable 秒


def test_wait_for_file_times_out_saying_what_it_saw(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)

    with pytest.raises(TimeoutError, match="文件不存在"):
        wait_for_file(run.ctx, str(tmp_path / "missing"), wait=0.2, poll=0.05)
    with pytest.raises(TimeoutError, match="不是文件"):
        wait_for_file(run.ctx, str(tmp_path), wait=0.2, poll=0.05)
    with pytest.raises(ValueError, match="stable 不能为负数"):
        wait_for_file(run.ctx, str(tmp_path), stable=-1)


def test_seconds_parameters_reject_booleans(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)

    with pytest.raises(ValueError, match="wait 是秒数，不能是布尔值"):
        wait_for_port(run.ctx, 1, wait=True)
    with pytest.raises(ValueError, match="poll 是秒数，不能是布尔值"):
        poll_until(lambda: True, what="x", wait=1, poll=True)
    with pytest.raises(ValueError, match="stable 是秒数，不能是布尔值"):
        wait_for_file(run.ctx, tmp_path, stable=True)
