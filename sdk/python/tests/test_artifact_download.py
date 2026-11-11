"""`ctx.artifacts.download`：把产物引用指向的产物下载到本地文件。

节点在真实的执行器进程里运行（`sfly.testing.run_node`），产物由本进程里的 HTTP 服务提供：
它扮演控制面的产物下载地址 `GET /tasks/<任务 ID>/artifacts/<名称>`（成功 200、已过保留期 410、
不存在 404），并且可以按测试的需要中途断开连接、返回 5xx 或者发完响应头就不再发数据。
"""

from __future__ import annotations

import http.server
import socket
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from sfly.testing import run_node

NODES = '''
import threading
import tracemalloc

from sfly import Cancelled, Context, node


@node
def fetch(ctx: Context, ref: str, dest: str = "got/data.bin", retries: int = 3) -> dict:
    """下载到 dest（相对任务工作目录），输出写入的路径。"""
    try:
        path = ctx.artifacts.download(ref, dest, retries=retries)
    except Cancelled:
        ctx.log.info("下载被取消")
        raise
    return {"path": str(path)}


@node
def fetch_measuring_memory(ctx: Context, ref: str) -> dict:
    """下载并输出下载期间 Python 分配的内存峰值（字节）。"""
    tracemalloc.start()
    path = ctx.artifacts.download(ref, "big.bin")
    _, peak = tracemalloc.get_traced_memory()
    return {"size": path.stat().st_size, "peak": peak}


@node
def fetch_in_thread(ctx: Context, ref: str) -> dict:
    """在后台线程里下载；线程里的下载结束（或被取消）后写一行日志。"""

    def work() -> None:
        try:
            ctx.artifacts.download(ref, "got/data.bin")
        except Cancelled:
            ctx.log.info("线程里的下载被取消")

    thread = threading.Thread(target=work)
    thread.start()
    try:
        thread.join()
    finally:
        thread.join()
    return {}


@node
def save_then_fetch(ctx: Context, text: str) -> dict:
    """保存一个产物，再用它的产物引用下载回来。"""
    ref = ctx.artifacts.save("report.txt", text)
    path = ctx.artifacts.download(ref, "copy.txt")
    return {"text": path.read_text(encoding="utf-8")}
'''


@pytest.fixture(autouse=True)
def nodes_on_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    code = tmp_path / "code"
    code.mkdir()
    (code / "download_nodes.py").write_text(NODES, encoding="utf-8")
    monkeypatch.syspath_prepend(str(code))


#: 一次请求的处理方式：拿到处理器，自己写响应。
Responder = Callable[[http.server.BaseHTTPRequestHandler], None]


def ok(body: bytes) -> Responder:
    def respond(handler: http.server.BaseHTTPRequestHandler) -> None:
        handler.send_response(200)
        handler.send_header("content-type", "application/octet-stream")
        handler.send_header("content-length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    return respond


def status(code: int, body: bytes = b'{"error":{"code":"x","message":"y"}}') -> Responder:
    def respond(handler: http.server.BaseHTTPRequestHandler) -> None:
        handler.send_response(code)
        handler.send_header("content-type", "application/json")
        handler.send_header("content-length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    return respond


def cut_off(body: bytes, after: int) -> Responder:
    """声明完整长度，只发前 after 字节就断开连接。"""

    def respond(handler: http.server.BaseHTTPRequestHandler) -> None:
        handler.send_response(200)
        handler.send_header("content-length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body[:after])
        handler.wfile.flush()
        handler.connection.shutdown(socket.SHUT_RDWR)

    return respond


class ArtifactServer:
    """扮演控制面的产物下载地址。每个路径有一串响应，按请求次序取用，最后一个一直重复。"""

    def __init__(self) -> None:
        self._routes: dict[str, list[Responder]] = {}
        self.requests: list[str] = []
        self._release = threading.Event()
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                owner.requests.append(self.path)
                responders = owner._routes.get(self.path)
                if responders is None:
                    status(404)(self)
                    return
                responder = responders.pop(0) if len(responders) > 1 else responders[0]
                try:
                    responder(self)
                except OSError:
                    pass  # 客户端先断开了

            def log_message(self, format: str, *args: object) -> None:
                pass

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._httpd.daemon_threads = True
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self._httpd.server_address[1]}"

    def serve(self, name: str, *responders: Responder) -> str:
        """登记一个产物的响应序列，返回它的产物引用。"""
        path = f"/tasks/7b0c6c0e-6f0f-4d7e-9a35-1f5a7c1d2e3f/artifacts/{name}"
        self._routes[path] = list(responders)
        return self.base + path

    def stall(self, body: bytes, *, trickle: bool = False) -> Responder:
        """发完响应头和第一个字节后不再发完（trickle 时每 50 毫秒发一个字节），直到服务关闭。"""

        def respond(handler: http.server.BaseHTTPRequestHandler) -> None:
            handler.send_response(200)
            handler.send_header("content-length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body[:1])
            handler.wfile.flush()
            sent = 1
            while not self._release.wait(0.05):
                if trickle and sent < len(body) - 1:
                    handler.wfile.write(body[sent : sent + 1])
                    handler.wfile.flush()
                    sent += 1

        return respond

    def close(self) -> None:
        self._release.set()
        self._httpd.shutdown()
        self._httpd.server_close()


@pytest.fixture
def server() -> Iterator[ArtifactServer]:
    srv = ArtifactServer()
    yield srv
    srv.close()


def wait_for(condition: Callable[[], bool], timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "等待条件超时"
        time.sleep(0.02)


BODY = bytes(range(256)) * 1024  # 256 KiB，含全部字节值


def test_downloads_the_artifact_to_the_given_path_and_returns_it(
    server: ArtifactServer, tmp_path: Path
) -> None:
    ref = server.serve("logs/%E5%AE%8C%E6%95%B4.bin", ok(BODY))

    result = run_node(
        "download_nodes:fetch", {"ref": ref, "dest": "got/sub/data.bin"}, work_dir=tmp_path / "w"
    )

    assert result.status == "success", result.error
    assert result.outputs == {"path": "got/sub/data.bin"}
    assert (tmp_path / "w" / "got" / "sub" / "data.bin").read_bytes() == BODY


def test_download_is_streamed_without_holding_the_artifact_in_memory(
    server: ArtifactServer, tmp_path: Path
) -> None:
    size = 32 * 1024 * 1024
    ref = server.serve("big.bin", ok(bytes(size)))

    result = run_node(
        "download_nodes:fetch_measuring_memory", {"ref": ref}, work_dir=tmp_path / "w"
    )

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["size"] == size
    assert result.outputs["peak"] < 4 * 1024 * 1024


def test_network_errors_are_retried_until_the_download_succeeds(
    server: ArtifactServer, tmp_path: Path
) -> None:
    # 第一次传到一半断开，第二次控制面返回 503，第三次成功。
    ref = server.serve("data.bin", cut_off(BODY, after=1000), status(503), ok(BODY))

    result = run_node("download_nodes:fetch", {"ref": ref}, work_dir=tmp_path / "w")

    assert result.status == "success", result.error
    assert (tmp_path / "w" / "got" / "data.bin").read_bytes() == BODY
    assert len(server.requests) == 3


def test_download_fails_once_retries_are_used_up(server: ArtifactServer, tmp_path: Path) -> None:
    ref = server.serve("data.bin", cut_off(BODY, after=1000))

    result = run_node("download_nodes:fetch", {"ref": ref, "retries": 1}, work_dir=tmp_path / "w")

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.type == "ArtifactDownloadError"
    assert "连接中断" in result.error.message
    assert "已重试 1 次" in result.error.message
    assert ref in result.error.message
    assert len(server.requests) == 2
    # 失败时不留下半个文件。
    assert list((tmp_path / "w" / "got").iterdir()) == []


def unused_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
    return port


def test_each_kind_of_failure_has_its_own_message(server: ArtifactServer, tmp_path: Path) -> None:
    def failure(ref: str, name: str) -> str:
        result = run_node(
            "download_nodes:fetch", {"ref": ref, "retries": 0}, work_dir=tmp_path / name
        )
        assert result.status == "failed", result.outputs
        assert result.error is not None
        assert result.error.type == "ArtifactDownloadError"
        return result.error.message

    gone = server.serve("old.bin", status(410))
    down = f"http://127.0.0.1:{unused_port()}/tasks/t/artifacts/a.bin"

    assert "产物引用无效" in failure("ftp://example.com/a.bin", "scheme")
    assert "产物引用无效" in failure(str(tmp_path / "no-such-file"), "path")
    assert "产物引用无效" in failure("", "empty")
    assert "产物不存在" in failure(server.base + "/tasks/t/artifacts/missing.bin", "missing")
    assert "已过保留期" in failure(gone, "gone")
    assert "连不上控制面" in failure(down, "down")
    # 引用无效、不存在、已清理都不重试。
    assert server.requests == ["/tasks/t/artifacts/missing.bin", gone.removeprefix(server.base)]


def test_cancelling_the_task_stops_a_stalled_download_at_once(
    server: ArtifactServer, tmp_path: Path
) -> None:
    ref = server.serve("data.bin", server.stall(BODY))

    result = run_node(
        "download_nodes:fetch",
        {"ref": ref},
        cancel_when=lambda partial: bool(server.requests),
        work_dir=tmp_path / "w",
    )

    assert result.status == "cancelled"
    # 节点在宽限期内自己停下（被强制杀掉的话没有这行日志）。
    assert "下载被取消" in [line.message for line in result.logs]
    assert list((tmp_path / "w" / "got").iterdir()) == []


def test_cancelling_the_task_stops_a_download_running_in_a_thread(
    server: ArtifactServer, tmp_path: Path
) -> None:
    ref = server.serve("data.bin", server.stall(BODY, trickle=True))

    result = run_node(
        "download_nodes:fetch_in_thread",
        {"ref": ref},
        cancel_when=lambda partial: bool(server.requests),
        work_dir=tmp_path / "w",
    )

    assert result.status == "cancelled"
    assert "线程里的下载被取消" in [line.message for line in result.logs]


# ---- 本地调试：产物引用是本地文件路径；也可以给某个引用指定本地内容 ----


def test_a_local_artifact_ref_is_copied(tmp_path: Path) -> None:
    result = run_node(
        "download_nodes:save_then_fetch", {"text": "完整输出"}, work_dir=tmp_path / "w"
    )

    assert result.status == "success", result.error
    assert result.outputs == {"text": "完整输出"}


def test_run_node_serves_given_local_content_for_a_ref(tmp_path: Path) -> None:
    source = tmp_path / "fixture.bin"
    source.write_bytes(BODY)
    refs = {
        "bytes": "http://cp.invalid/tasks/t-1/artifacts/a.bin",
        "text": "http://cp.invalid/tasks/t-1/artifacts/b.txt",
        "file": "http://cp.invalid/tasks/t-1/artifacts/c.bin",
    }
    downloads: dict[str, bytes | str | Path] = {
        refs["bytes"]: b"\x00\x01",
        refs["text"]: "文本",
        refs["file"]: source,
    }

    got = {}
    for kind, ref in refs.items():
        work = tmp_path / kind
        result = run_node("download_nodes:fetch", {"ref": ref}, downloads=downloads, work_dir=work)
        assert result.status == "success", result.error
        got[kind] = (work / "got" / "data.bin").read_bytes()

    assert got == {"bytes": b"\x00\x01", "text": "文本".encode(), "file": BODY}
    # 指定的内容不算这次执行保存的产物。
    assert result.artifacts == {}
