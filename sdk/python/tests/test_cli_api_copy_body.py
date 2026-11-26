"""`sfly api` 原样输出响应：带长度的响应读到一半断了，报错、退出码非 0，不当作成功（#716 的审查）。

以前 `_copy_body` 照常结束、标准输出是半截而退出码是 0：带长度的响应读短了，
`read` 不报错、只是返回空。
这里用真的套接字：声明了 100 个字节、只发 20 个字节就断开。
"""

from __future__ import annotations

import io
import socket
import threading
import urllib.request
from types import SimpleNamespace
from typing import Any

import pytest

from sfly.cli.api import _copy_body
from sfly.cli.errors import CliError


def _serve(body: bytes, declared: int) -> str:
    """起一个只回一次的服务：声明 `declared` 个字节的长度，只发 `body`，然后断开。"""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)

    def run() -> None:
        conn, _ = server.accept()
        conn.recv(65536)
        head = b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n"
        conn.sendall(head + b"content-length: %d\r\n\r\n" % declared + body)
        conn.close()
        server.close()

    threading.Thread(target=run, daemon=True).start()
    return f"http://127.0.0.1:{server.getsockname()[1]}/"


def _session() -> tuple[Any, io.BytesIO]:
    raw = io.BytesIO()
    stdout = io.TextIOWrapper(raw, write_through=True)
    return SimpleNamespace(out=SimpleNamespace(stdout=stdout)), raw


def test_a_response_cut_short_is_an_error_not_a_success() -> None:
    session, raw = _session()

    with urllib.request.urlopen(_serve(b"x" * 20, 100)) as response:
        with pytest.raises(CliError) as caught:
            _copy_body(session, response)

    assert caught.value.code == "read_failed"
    assert "不完整" in caught.value.message
    # 已经写出去的收不回来（管道里的），说明里写明。
    assert raw.getvalue() == b"x" * 20


def test_a_complete_response_is_copied_and_succeeds() -> None:
    session, raw = _session()

    with urllib.request.urlopen(_serve(b"x" * 20, 20)) as response:
        assert _copy_body(session, response) == 0

    assert raw.getvalue() == b"x" * 20
