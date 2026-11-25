"""`sfly run logs --all`：下载没下完时给出明确的提示、退出码不是 0，不留半个文件（#669）。

控制面发现日志文件在下载时被删除、截短了，响应已经开始，会断开连接。命令行这一侧：
分块的响应在两块之间断开时，直接按行迭代响应不报错、悄悄当作读完了（只有断在一块当中
才报 `IncompleteRead`），写出来的文件缺了一截而命令说成功了。所以按块读，断开了就抛错。
这里用真的套接字，按不同的方式把分块的响应切断。
"""

from __future__ import annotations

import argparse
import socket
import threading
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sfly.cli.errors import CliError
from sfly.cli.run_logs import (
    DEFAULT_TAIL,
    Selection,
    _complete_lines,
    _download_all,
    _write_download,
)

ROW = b'{"seq":1,"text":"a"}\n'
ROW2 = b'{"seq":2,"text":"b"}\n'
RUN = "11111111-1111-4111-8111-111111111111"


def _chunk(data: bytes) -> bytes:
    return b"%x\r\n%s\r\n" % (len(data), data)


def _serve(mode: str) -> Iterator[str]:
    """起一个只回一次的服务：分块的响应，按 `mode` 在不同的位置结束或切断。"""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)

    def run() -> None:
        conn, _ = server.accept()
        conn.recv(65536)
        if mode == "fixed-short":
            head = b"HTTP/1.1 200 OK\r\ncontent-type: application/x-ndjson\r\n"
            conn.sendall(head + b"content-length: %d\r\n\r\n" % (len(ROW) + len(ROW2)) + ROW)
        else:
            conn.sendall(
                b"HTTP/1.1 200 OK\r\ncontent-type: application/x-ndjson\r\n"
                b"transfer-encoding: chunked\r\n\r\n" + _chunk(ROW)
            )
            if mode == "complete":
                conn.sendall(_chunk(ROW2) + b"0\r\n\r\n")
            elif mode == "mid-chunk":
                conn.sendall(b"%x\r\n%s" % (len(ROW2), ROW2[:5]))
            # "between"：第一块发完就断开，没有结尾的 0 长度块
        conn.close()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.getsockname()[1]}/runs/{RUN}/logs/download"
    finally:
        thread.join(timeout=5)
        server.close()


def _args(target: Path, **over: Any) -> argparse.Namespace:
    """`sfly run logs` 的选项：下载没下完时的提示要带着原来的 `--failed`、`--node`。"""
    options: dict[str, Any] = {
        "run": RUN,
        "all": str(target),
        "failed": False,
        "node": None,
        "level": None,
        "tail": DEFAULT_TAIL,
    }
    return argparse.Namespace(**{**options, **over})


def _download(mode: str, target: Path) -> int:
    selection = Selection(nodes=None, task_ids=None)
    for url in _serve(mode):
        with urllib.request.urlopen(url) as response:
            return _write_download(_complete_lines(response, _args(target)), target, selection)
    raise AssertionError("没有起服务")


def test_a_complete_download_writes_every_row(tmp_path: Path) -> None:
    target = tmp_path / "logs.jsonl"

    assert _download("complete", target) == 2

    assert target.read_bytes() == ROW + ROW2


@pytest.mark.parametrize("mode", ["between", "mid-chunk", "fixed-short"])
def test_a_cut_download_is_an_error_and_leaves_no_file(mode: str, tmp_path: Path) -> None:
    target = tmp_path / "logs.jsonl"

    with pytest.raises(CliError) as caught:
        _download(mode, target)

    assert caught.value.code == "download_incomplete"
    assert "没有下载完" in caught.value.message
    assert "没有写出文件" in caught.value.message
    assert caught.value.next is not None
    assert f"sfly run logs {RUN} --all {target}" in caught.value.next
    # 不留下半个文件，也不留下临时文件。
    assert list(tmp_path.iterdir()) == []


def test_a_cut_download_does_not_replace_an_existing_file(tmp_path: Path) -> None:
    target = tmp_path / "logs.jsonl"
    target.write_bytes(b"before\n")

    with pytest.raises(CliError):
        _download("between", target)

    assert target.read_bytes() == b"before\n"
    assert [p.name for p in tmp_path.iterdir()] == ["logs.jsonl"]


class _Out:
    def __init__(self) -> None:
        self.emitted: list[tuple[Any, str]] = []

    def emit(self, value: Any, text: str, *, note: str | None = None) -> None:
        self.emitted.append((value, text))


def _session(url: str, out: _Out) -> Any:
    """`_download_all` 用到的：`client.open`（返回打开的响应）和 `out.emit`。"""
    return SimpleNamespace(
        client=SimpleNamespace(open=lambda *_args, **_kwargs: urllib.request.urlopen(url)),
        out=out,
    )


@pytest.mark.parametrize("mode", ["between", "mid-chunk", "fixed-short"])
def test_the_command_itself_fails_when_the_download_is_cut(mode: str, tmp_path: Path) -> None:
    """命令（`_download_all`）把响应交给 `_complete_lines`：直接迭代响应，断在两块之间读不出错。"""
    target = tmp_path / "logs.jsonl"
    out = _Out()

    for url in _serve(mode):
        with pytest.raises(CliError) as caught:
            _download_all(_session(url, out), _args(target), Selection(nodes=None, task_ids=None))

    assert caught.value.code == "download_incomplete"
    assert out.emitted == []  # 没有说「已下载 N 行」
    assert list(tmp_path.iterdir()) == []


def test_the_command_reports_a_complete_download(tmp_path: Path) -> None:
    target = tmp_path / "logs.jsonl"
    out = _Out()

    for url in _serve("complete"):
        _download_all(_session(url, out), _args(target), Selection(nodes=None, task_ids=None))

    assert out.emitted == [({"path": str(target), "lines": 2}, f"已下载 2 行日志到 {target}")]
    assert target.read_bytes() == ROW + ROW2


@pytest.mark.parametrize(
    ("options", "flags"),
    [
        ({}, ""),
        ({"failed": True}, " --failed"),
        ({"node": ["main:a"]}, " --node main:a"),
        (
            {"failed": True, "node": ["main:a", "回放:b c"]},
            " --failed --node main:a --node '回放:b c'",
        ),
        # `--level` 只对分页有意义（下载不带级别），不进提示。
        ({"level": "error"}, ""),
    ],
)
def test_the_retry_hint_keeps_the_scope_options_and_quotes_the_path(
    options: dict[str, Any], flags: str, tmp_path: Path
) -> None:
    """用 `--failed`、`--node` 下载的人照着提示重下，范围要和原来一样；只带 `--all` 重下，
    下到的是整个运行，还写进同一个文件（#716 的审查）。路径里有空格也要能直接用。"""
    target = tmp_path / "my logs.jsonl"

    for url in _serve("between"):
        with pytest.raises(CliError) as caught:
            _download_all(
                _session(url, _Out()),
                _args(target, **options),
                Selection(nodes=None, task_ids=None),
            )

    assert caught.value.next == f"重新下载：sfly run logs {RUN}{flags} --all '{target}'"
