"""`sfly run logs --all`：按响应头 `x-sfly-log-expect` 核对下载有没有下完（#721）。

控制面发现日志文件在下载时被截短，响应已经开始，会断开连接；反向代理用 HTTP/1.0 连控制面时
（不少版本的常见代理默认如此）断开和正常结束分不出来，代理把半截的响应当完整的发给客户端，
命令行靠传输层看不出没下完。所以响应带头 `x-sfly-log-expect: tasks=<m>; last_seq_sum=<S>`：
范围内有日志的任务数、各任务最后一个序号之和（序号可以有缺口，所以不是行数）。命令行读完后按任务
记下读到的最大序号，任务数或合计比头里的少就是没下完：`download_incomplete`，不留文件。
没有这个头（旧控制面）或头读不懂时不核对。
这里用真的套接字，响应是代理转出来的样子：完整的、有 `content-length` 的，只是内容少了。
"""

from __future__ import annotations

import argparse
import json
import socket
import threading
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from sfly.cli.errors import CliError
from sfly.cli.run_logs import (
    DEFAULT_TAIL,
    Selection,
    _complete_lines,
    _write_download,
)

RUN = "11111111-1111-4111-8111-111111111111"


def _row(task: str, seq: int) -> bytes:
    return b'{"seq":%d,"time":null,"text":"x","task_id":"%s"}\n' % (seq, task.encode())


def _serve(body: bytes, expect: str | None) -> Iterator[str]:
    """起一个只回一次的服务：像代理转出来的响应，完整、带 `content-length`，内容是 `body`。"""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)

    def run() -> None:
        conn, _ = server.accept()
        conn.recv(65536)
        head = b"HTTP/1.1 200 OK\r\ncontent-type: application/x-ndjson\r\n"
        if expect is not None:
            head += b"x-sfly-log-expect: " + expect.encode() + b"\r\n"
        conn.sendall(head + b"content-length: %d\r\n\r\n" % len(body) + body)
        conn.close()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.getsockname()[1]}/runs/{RUN}/logs/download"
    finally:
        thread.join(timeout=5)
        server.close()


def _args(target: Path) -> argparse.Namespace:
    return argparse.Namespace(
        run=RUN, all=str(target), failed=False, node=None, level=None, tail=DEFAULT_TAIL
    )


def _download(body: bytes, expect: str | None, target: Path) -> int:
    selection = Selection(nodes=None, task_ids=None)
    for url in _serve(body, expect):
        with urllib.request.urlopen(url) as response:
            return _write_download(_complete_lines(response, _args(target)), target, selection)
    raise AssertionError("没有起服务")


def _incomplete(body: bytes, expect: str | None, target: Path) -> CliError:
    with pytest.raises(CliError) as caught:
        _download(body, expect, target)
    assert caught.value.code == "download_incomplete"
    assert not target.exists()  # 不留半个文件
    return caught.value


def test_a_download_that_reaches_every_last_seq_is_written(tmp_path: Path) -> None:
    body = _row("a", 1) + _row("b", 1) + _row("a", 2) + _row("b", 2) + _row("b", 3)
    target = tmp_path / "logs.jsonl"

    assert _download(body, "tasks=2; last_seq_sum=5", target) == 5

    assert target.read_bytes() == body


def test_a_download_cut_by_a_proxy_is_an_error_and_leaves_no_file(tmp_path: Path) -> None:
    # 控制面断开了连接，HTTP/1.0 的代理把读到的当完整的转出来：b 的第 2、3 行没有了。
    body = _row("a", 1) + _row("b", 1) + _row("a", 2)

    error = _incomplete(body, "tasks=2; last_seq_sum=5", tmp_path / "logs.jsonl")

    assert "没有下载完" in error.message
    assert "download_incomplete" == error.code


def test_the_retry_hint_keeps_the_scope_options(tmp_path: Path) -> None:
    body = _row("a", 1)
    target = tmp_path / "my logs.jsonl"
    selection = Selection(nodes=None, task_ids=None)
    args = _args(target)
    args.failed = True

    for url in _serve(body, "tasks=1; last_seq_sum=2"):
        with urllib.request.urlopen(url) as response, pytest.raises(CliError) as caught:
            _write_download(_complete_lines(response, args), target, selection)

    assert "--failed" in (caught.value.next or "")
    assert "'" in (caught.value.next or "")  # 路径带空格，加了引号


def test_seq_gaps_are_fine_the_sum_is_of_last_seqs_not_rows(tmp_path: Path) -> None:
    # Agent 丢过行：序号 1、2、5，三行，最后一个序号是 5。
    body = _row("a", 1) + _row("a", 2) + _row("a", 5)
    target = tmp_path / "logs.jsonl"

    assert _download(body, "tasks=1; last_seq_sum=5", target) == 3


def test_a_task_that_never_shows_up_is_missing_even_if_the_sum_is_reached(tmp_path: Path) -> None:
    body = _row("a", 1) + _row("a", 2) + _row("a", 7)

    _incomplete(body, "tasks=2; last_seq_sum=7", tmp_path / "logs.jsonl")


def test_more_than_expected_is_fine_a_task_download_may_have_grown(tmp_path: Path) -> None:
    body = _row("a", 1) + _row("a", 2) + _row("a", 3)
    target = tmp_path / "logs.jsonl"

    assert _download(body, "tasks=1; last_seq_sum=2", target) == 3


def test_a_last_line_without_its_newline_is_incomplete(tmp_path: Path) -> None:
    # 合计已经到了（序号 2），但后面还拖着一行被切在当中的：完整的下载不会以半行结尾。
    body = _row("a", 1) + _row("a", 2) + _row("a", 3)[:-12]

    _incomplete(body, "tasks=1; last_seq_sum=2", tmp_path / "logs.jsonl")


def test_a_line_that_is_not_a_log_row_is_incomplete(tmp_path: Path) -> None:
    body = _row("a", 1) + b"not json at all\n"

    _incomplete(body, "tasks=1; last_seq_sum=1", tmp_path / "logs.jsonl")


@pytest.mark.parametrize("expect", [None, "", "tasks=1", "garbage", "tasks=x; last_seq_sum=y"])
def test_without_a_readable_header_nothing_is_checked(expect: str | None, tmp_path: Path) -> None:
    # 旧控制面没有这个头；读不懂的头同样不核对（以前的行为）。
    body = _row("a", 1)
    target = tmp_path / "logs.jsonl"

    assert _download(body, expect, target) == 1


def test_an_empty_download_with_no_tasks_is_fine(tmp_path: Path) -> None:
    target = tmp_path / "logs.jsonl"

    assert _download(b"", "tasks=0; last_seq_sum=0", target) == 0


def test_the_parsing_does_not_break_rows_with_unusual_json(tmp_path: Path) -> None:
    unusual: dict[str, Any] = {"seq": 1, "task_id": "a", "text": '中文   {"k": [1, 2]}'}
    body = json.dumps(unusual, ensure_ascii=False).encode() + b"\n"

    assert _download(body, "tasks=1; last_seq_sum=1", tmp_path / "logs.jsonl") == 1
