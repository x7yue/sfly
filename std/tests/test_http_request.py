"""`http_request`：在真实的执行器进程里请求本地 HTTP 桩（`sfly.testing.run_node`），不访问外网。"""

from __future__ import annotations

import json
import shutil
import ssl
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from sfly.testing import Execution, run_node
from sfly_std.http_request import http_request


@dataclass
class Received:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes


@dataclass
class Reply:
    status: int = 200
    body: bytes = b""
    headers: dict[str, str] = field(default_factory=dict)
    delay: float = 0.0


def json_reply(value: Any, status: int = 200) -> Reply:
    return Reply(
        status, json.dumps(value).encode(), {"Content-Type": "application/json; charset=utf-8"}
    )


class Stub:
    """本地 HTTP 桩：`routes` 把路径映射到回复（或按收到的请求生成回复的函数），记下收到的请求。"""

    def __init__(self, port: int = 0) -> None:
        self.routes: dict[str, Reply | Callable[[Received], Reply]] = {}
        self.received: list[Received] = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                request = Received(
                    self.command,
                    self.path,
                    {k.lower(): v for k, v in self.headers.items()},
                    self.rfile.read(length),
                )
                stub.received.append(request)
                route = stub.routes.get(self.path, Reply(404, b"not found"))
                reply = route(request) if callable(route) else route
                if reply.delay:
                    threading.Event().wait(reply.delay)
                self.send_response(reply.status)
                for key, value in reply.headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(reply.body)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(reply.body)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _handle

            def log_message(self, format: str, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def use_tls(self, cert: Path, key: Path) -> None:
        """改为 HTTPS（用给定的证书）。"""
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.url = self.url.replace("http://", "https://")

    def serve(self) -> None:
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def stub() -> Iterator[Stub]:
    server = Stub()
    server.serve()
    yield server
    server.close()


@pytest.fixture(autouse=True)
def _no_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    # 执行器子进程继承环境变量：别让本机的代理设置把请求转到别处。
    for name in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        monkeypatch.delenv(name, raising=False)


def run(tmp_path: Path, **inputs: Any) -> Execution:
    return run_node(http_request, inputs, work_dir=tmp_path)


def test_get_outputs_status_headers_json_and_elapsed_ms(tmp_path: Path, stub: Stub) -> None:
    stub.routes["/health"] = Reply(
        200, b'{"status": "ok"}', {"Content-Type": "application/json", "X-Version": "1.2.3"}
    )

    result = run(tmp_path, url=f"{stub.url}/health")

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["status"] == 200
    assert result.outputs["json"] == {"status": "ok"}
    assert "text" not in result.outputs
    assert result.outputs["headers"]["x-version"] == "1.2.3"
    assert result.outputs["elapsed_ms"] >= 0
    assert [(m.name, m.value) for m in result.metrics] == [
        ("elapsed_ms", result.outputs["elapsed_ms"])
    ]
    assert [(r.method, r.path) for r in stub.received] == [("GET", "/health")]


def test_headers_output_keeps_the_first_64_kib_and_logs_what_was_dropped(
    tmp_path: Path, stub: Stub
) -> None:
    # 节点输出不能超过 1 MB：响应头多到超过 64 KiB 时只保留前面的，日志写明。
    big = {f"X-Big-{i:02d}": "v" * 1000 for i in range(80)}
    stub.routes["/big"] = Reply(200, b"ok", big)

    result = run(tmp_path, url=f"{stub.url}/big")

    assert result.status == "success", result.error
    assert result.outputs is not None
    headers = result.outputs["headers"]
    assert "x-big-00" in headers
    assert "x-big-79" not in headers
    assert sum(len(k) + len(v) for k, v in headers.items()) <= 64 * 1024
    warnings = [line.message for line in result.logs if line.source == "sdk"]
    assert any(
        m.startswith("响应头共 ") and f"输出 headers 只保留前 {len(headers)} 个（64 KiB）" in m
        for m in warnings
    ), warnings


@pytest.mark.parametrize("method", ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
def test_sends_each_method(tmp_path: Path, stub: Stub, method: str) -> None:
    stub.routes["/items/1"] = Reply(204)

    result = run(tmp_path, method=method, url=f"{stub.url}/items/1")

    assert result.status == "success", result.error
    assert result.outputs is not None and result.outputs["status"] == 204
    assert [(r.method, r.path) for r in stub.received] == [(method, "/items/1")]


def test_json_is_sent_as_a_json_body_with_headers(tmp_path: Path, stub: Stub) -> None:
    stub.routes["/items"] = json_reply({"id": 7}, status=201)

    result = run(
        tmp_path,
        method="POST",
        url=f"{stub.url}/items",
        headers={"Authorization": "Bearer t0ken", "X-Trace": "abc"},
        json={"name": "压测", "tags": ["a", "b"], "count": 3},
    )

    assert result.status == "success", result.error
    assert result.outputs is not None and result.outputs["json"] == {"id": 7}
    [request] = stub.received
    assert json.loads(request.body) == {"name": "压测", "tags": ["a", "b"], "count": 3}
    assert request.headers["content-type"] == "application/json"
    assert request.headers["authorization"] == "Bearer t0ken"
    assert request.headers["x-trace"] == "abc"


def test_body_is_sent_as_utf8_text(tmp_path: Path, stub: Stub) -> None:
    stub.routes["/upload"] = Reply(200)

    result = run(
        tmp_path,
        method="PUT",
        url=f"{stub.url}/upload",
        headers={"Content-Type": "text/plain; charset=utf-8"},
        body="第一行\n第二行",
    )

    assert result.status == "success", result.error
    [request] = stub.received
    assert request.body == "第一行\n第二行".encode()
    assert request.headers["content-type"] == "text/plain; charset=utf-8"


def test_json_and_body_together_is_a_mistake(tmp_path: Path, stub: Stub) -> None:
    result = run(tmp_path, method="POST", url=f"{stub.url}/x", json={"a": 1}, body="a=1")

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message == "ValueError: json 和 body 只能填一个"
    assert stub.received == []


def failure(result: Execution) -> str:
    assert result.status == "failed", result.outputs
    assert result.error is not None
    return result.error.message


def test_fails_with_status_and_response_head_when_status_is_not_2xx(
    tmp_path: Path, stub: Stub
) -> None:
    stub.routes["/orders"] = Reply(503, "数据库连接池已满\n".encode() + b"x" * 5000)

    message = failure(run(tmp_path, method="POST", url=f"{stub.url}/orders", json={}))

    assert message.startswith(
        f"sfly_std.http_request.ExpectationFailed: POST {stub.url}/orders 状态码 503，"
        '不在 expect_status ["2xx"] 中\n\n响应开头：\n数据库连接池已满\nxxx'
    ), message
    assert "x" * 1100 not in message  # 只附开头


@pytest.mark.parametrize(
    ("expect_status", "status"),
    [(404, 404), ([200, 404], 404), ("4xx", 418), (["2xx", 301], 301)],
)
def test_expect_status_lists_codes_or_classes_that_pass(
    tmp_path: Path, stub: Stub, expect_status: Any, status: int
) -> None:
    stub.routes["/x"] = Reply(status)

    result = run(tmp_path, url=f"{stub.url}/x", expect_status=expect_status)

    assert result.status == "success", result.error
    assert result.outputs is not None and result.outputs["status"] == status


def test_expect_status_failure_lists_what_was_expected(tmp_path: Path, stub: Stub) -> None:
    stub.routes["/x"] = Reply(200)

    message = failure(run(tmp_path, url=f"{stub.url}/x", expect_status=[404, "5xx"]))

    assert message == (
        f"sfly_std.http_request.ExpectationFailed: GET {stub.url}/x 状态码 200，"
        '不在 expect_status [404, "5xx"] 中'
    )


@pytest.mark.parametrize("expect_status", ["2XX", "200", "6xx", 99, [200, "ok"], []])
def test_rejects_malformed_expect_status_before_sending(
    tmp_path: Path, stub: Stub, expect_status: Any
) -> None:
    message = failure(run(tmp_path, url=f"{stub.url}/x", expect_status=expect_status))

    assert message.startswith("ValueError: expect_status "), message
    assert stub.received == []


def test_expect_json_passes_when_every_assertion_holds(tmp_path: Path, stub: Stub) -> None:
    stub.routes["/health"] = json_reply({"status": "ok", "checks": [{"up": True}, {"up": True}]})

    result = run(
        tmp_path,
        url=f"{stub.url}/health",
        expect_json=[
            {"path": "$.status", "op": "eq", "value": "ok"},
            {"path": "$.checks[*].up", "op": "eq", "value": True},
        ],
    )

    assert result.status == "success", result.error


def test_fails_with_status_and_failed_assertions_when_json_does_not_match(
    tmp_path: Path, stub: Stub
) -> None:
    stub.routes["/health"] = json_reply({"status": "degraded", "version": "1.2.3", "queue": 120})

    message = failure(
        run(
            tmp_path,
            url=f"{stub.url}/health",
            expect_json=[
                {"path": "$.status", "op": "eq", "value": "ok"},
                {"path": "$.version", "op": "exists"},
                {"path": "$.queue", "op": "lt", "value": 100},
            ],
        )
    )

    assert message == (
        f"sfly_std.http_request.ExpectationFailed: GET {stub.url}/health 状态码 200，"
        "3 条断言中 2 条不通过：\n"
        '- 第 1 条：$.status 应 eq "ok"，实际是 "degraded"\n'
        "- 第 3 条：$.queue 应 lt 100，实际是 120"
    )


def test_status_is_checked_before_json(tmp_path: Path, stub: Stub) -> None:
    stub.routes["/health"] = json_reply({"status": "down"}, status=500)

    message = failure(
        run(
            tmp_path,
            url=f"{stub.url}/health",
            expect_json=[{"path": "$.status", "op": "eq", "value": "ok"}],
        )
    )

    assert "状态码 500，不在 expect_status" in message, message


def test_non_json_response_is_output_as_text(tmp_path: Path, stub: Stub) -> None:
    stub.routes["/metrics"] = Reply(
        200,
        "requests_total 42\n# 中文注释\n".encode(),
        {"Content-Type": "text/plain; charset=utf-8"},
    )

    result = run(tmp_path, url=f"{stub.url}/metrics")

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["text"] == "requests_total 42\n# 中文注释\n"
    assert "json" not in result.outputs


def test_expect_json_fails_when_the_response_is_not_json(tmp_path: Path, stub: Stub) -> None:
    stub.routes["/health"] = Reply(200, b"<html>OK</html>", {"Content-Type": "text/html"})

    message = failure(
        run(tmp_path, url=f"{stub.url}/health", expect_json=[{"path": "$.status", "op": "exists"}])
    )

    assert message == (
        f"sfly_std.http_request.ExpectationFailed: GET {stub.url}/health 状态码 200，"
        "响应不是 JSON，无法检查 expect_json\n\n响应开头：\n<html>OK</html>"
    )


def test_rejects_malformed_expect_json_before_sending(tmp_path: Path, stub: Stub) -> None:
    message = failure(
        run(tmp_path, url=f"{stub.url}/x", expect_json=[{"path": "status", "op": "exists"}])
    )

    assert message == "ValueError: 第 1 条断言：path 必须以 $ 开头：status"
    assert stub.received == []


KIB = 1024


def test_text_keeps_the_first_256_kib_and_warns(tmp_path: Path, stub: Stub) -> None:
    # 截断处落在多字节字符中间：去掉残缺的字节。
    body = b"a" + "汉".encode() * (100 * KIB)
    stub.routes["/big"] = Reply(200, body, {"Content-Type": "text/plain; charset=utf-8"})

    result = run(tmp_path, url=f"{stub.url}/big")

    assert result.status == "success", result.error
    assert result.outputs is not None
    text = result.outputs["text"]
    assert text == "a" + "汉" * ((256 * KIB - 1) // 3)
    assert warn_logs(result) == [
        f"响应共 {len(body)} 字节，输出 text 只保留开头 {len(text)} 个字符（JSON 序列化后 256 KiB）"
    ]


def warn_logs(result: Execution) -> list[str]:
    return [line.message for line in result.logs if line.level == "warn"]


def serialized_size(text: str) -> int:
    """text 写进输出 JSON 后占的字节数（不含两边的引号）。"""
    return len(json.dumps(text, ensure_ascii=False).encode()) - 2


def test_text_is_limited_by_its_serialized_size_so_control_characters_fit(
    tmp_path: Path, stub: Stub
) -> None:
    # 控制字符在 JSON 里转义成 \u00XX（6 字节）：按原始字节截到 256 KiB 会让输出超过 1 MB。
    body = b"\x01" * (300 * KIB)
    stub.routes["/bin"] = Reply(200, body, {"Content-Type": "application/octet-stream"})

    result = run(tmp_path, url=f"{stub.url}/bin")

    assert result.status == "success", result.error
    assert result.outputs is not None
    kept = 256 * KIB // 6
    assert result.outputs["text"] == "\x01" * kept
    assert warn_logs(result) == [
        f"响应共 {len(body)} 字节，输出 text 只保留开头 {kept} 个字符（JSON 序列化后 256 KiB）"
    ]


def test_json_over_256_kib_is_output_as_truncated_text_but_still_checked(
    tmp_path: Path, stub: Stub
) -> None:
    items = [{"id": i, "status": "ok"} for i in range(20000)]
    stub.routes["/items"] = json_reply({"items": items})

    result = run(
        tmp_path,
        url=f"{stub.url}/items",
        expect_json=[
            {"path": "$.items", "op": "len_eq", "value": 20000},
            {"path": "$.items[-1].status", "op": "eq", "value": "ok"},
        ],
    )

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert "json" not in result.outputs
    text = result.outputs["text"]
    assert text.startswith('{"items": [{"id": 0, "status": "ok"}')
    # 引号转义成 \"：最多差一个转义（2 字节）就到 256 KiB。
    assert 256 * KIB - 2 < serialized_size(text) <= 256 * KIB


def test_json_that_serializes_over_256_kib_is_output_as_text(tmp_path: Path, stub: Stub) -> None:
    # 1e15 重新序列化成 1000000000000000.0：原文 100 KiB 出头，序列化后 400 KiB 以上。
    body = ("[" + ",".join(["1e15"] * (20 * KIB)) + "]").encode()
    stub.routes["/floats"] = Reply(200, body, {"Content-Type": "application/json"})

    result = run(
        tmp_path,
        url=f"{stub.url}/floats",
        expect_json=[{"path": "$", "op": "len_eq", "value": 20 * KIB}],
    )

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert "json" not in result.outputs
    assert result.outputs["text"] == body.decode()
    assert warn_logs(result) == ["响应是 JSON，但序列化后超过 256 KiB，改为输出 text"]


def test_fails_when_the_response_takes_longer_than_request_timeout(
    tmp_path: Path, stub: Stub
) -> None:
    stub.routes["/slow"] = Reply(200, delay=5)

    message = failure(run(tmp_path, url=f"{stub.url}/slow", request_timeout=0.5))

    assert message == (
        f"sfly_std.http_request.RequestFailed: GET {stub.url}/slow 请求超时"
        "（request_timeout 0.5 秒）"
    )


def closed_port_url() -> str:
    server = Stub()  # 绑定后不服务、立即关闭：这个端口上没有人监听
    url = server.url
    server.server.server_close()
    return url


def test_fails_when_the_connection_is_refused(tmp_path: Path) -> None:
    url = closed_port_url()

    message = failure(run(tmp_path, url=f"{url}/health"))

    assert message.startswith(
        f"sfly_std.http_request.RequestFailed: GET {url}/health 请求失败："
    ), message
    assert "Connection refused" in message, message


@pytest.fixture
def tls_stub(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Stub]:
    """用本地自签证书的 HTTPS 桩。"""
    if shutil.which("openssl") is None:
        pytest.skip("需要 openssl 生成自签证书")
    directory = tmp_path_factory.mktemp("tls")
    cert, key = directory / "cert.pem", directory / "key.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=127.0.0.1",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
            "-keyout",
            str(key),
            "-out",
            str(cert),
        ],
        check=True,
        capture_output=True,
    )
    server = Stub()
    server.use_tls(cert, key)
    server.serve()
    yield server
    server.close()


def test_verifies_tls_certificates_by_default(tmp_path: Path, tls_stub: Stub) -> None:
    tls_stub.routes["/health"] = Reply(200)

    message = failure(run(tmp_path, url=f"{tls_stub.url}/health"))

    assert message.startswith(
        f"sfly_std.http_request.RequestFailed: GET {tls_stub.url}/health 请求失败："
    ), message
    assert "CERTIFICATE_VERIFY_FAILED" in message, message


def test_verify_tls_false_accepts_a_self_signed_certificate(tmp_path: Path, tls_stub: Stub) -> None:
    tls_stub.routes["/health"] = json_reply({"status": "ok"})

    result = run(tmp_path, url=f"{tls_stub.url}/health", verify_tls=False)

    assert result.status == "success", result.error
    assert result.outputs is not None and result.outputs["json"] == {"status": "ok"}


def test_until_ok_retries_until_status_and_json_pass(tmp_path: Path, stub: Stub) -> None:
    replies = iter(
        [
            Reply(503, b"starting"),
            json_reply({"status": "starting"}),
            json_reply({"status": "ok", "version": "1.2.3"}),
        ]
    )
    stub.routes["/health"] = lambda request: next(replies)

    result = run(
        tmp_path,
        url=f"{stub.url}/health",
        expect_json=[{"path": "$.status", "op": "eq", "value": "ok"}],
        until_ok=True,
        poll=0.1,
    )

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["json"] == {"status": "ok", "version": "1.2.3"}
    assert len(stub.received) == 3
    assert len(result.metrics) == 3  # 每次请求的耗时
    assert [line.message for line in result.logs if line.source == "sdk"] == [
        f"第 1 次不满足，0.1 秒后重试：GET {stub.url}/health 状态码 503，"
        '不在 expect_status ["2xx"] 中\n\n响应开头：\nstarting',
        f"第 2 次不满足，0.1 秒后重试：GET {stub.url}/health 状态码 200，"
        '1 条断言中 1 条不通过：\n- 第 1 条：$.status 应 eq "ok"，实际是 "starting"',
    ]


def test_until_ok_waits_for_the_service_to_start_listening(tmp_path: Path) -> None:
    url = closed_port_url()
    port = int(url.rsplit(":", 1)[1])
    started: list[Stub] = []

    def start_later() -> None:
        threading.Event().wait(1.0)
        server = Stub(port)
        server.routes["/health"] = json_reply({"status": "ok"})
        server.serve()
        started.append(server)

    threading.Thread(target=start_later, daemon=True).start()
    try:
        result = run(tmp_path, url=f"{url}/health", until_ok=True, poll=0.2)
    finally:
        for server in started:
            server.close()

    assert result.status == "success", result.error
    assert result.outputs is not None and result.outputs["json"] == {"status": "ok"}


def test_until_ok_fails_after_wait_with_the_last_status_and_failed_assertions(
    tmp_path: Path, stub: Stub
) -> None:
    stub.routes["/health"] = json_reply({"status": "starting"})

    started = time.monotonic()
    message = failure(
        run(
            tmp_path,
            url=f"{stub.url}/health",
            expect_json=[{"path": "$.status", "op": "eq", "value": "ok"}],
            until_ok=True,
            wait=1,
            poll=0.2,
        )
    )

    assert time.monotonic() - started < 10
    attempts = len(stub.received)
    assert attempts >= 3
    assert message == (
        f"sfly_std.http_request.ExpectationFailed: 1 秒内 {attempts} 次请求都不满足，"
        f"最后一次：GET {stub.url}/health 状态码 200，1 条断言中 1 条不通过：\n"
        '- 第 1 条：$.status 应 eq "ok"，实际是 "starting"'
    )


def test_until_ok_fails_after_wait_when_the_service_never_listens(tmp_path: Path) -> None:
    url = closed_port_url()

    message = failure(run(tmp_path, url=f"{url}/health", until_ok=True, wait=0.5, poll=0.1))

    assert message.startswith("sfly_std.http_request.RequestFailed: 0.5 秒内 "), message
    assert f"次请求都不满足，最后一次：GET {url}/health 请求失败：" in message, message


def test_until_ok_stops_retrying_when_cancelled(tmp_path: Path, stub: Stub) -> None:
    stub.routes["/health"] = Reply(503)

    result = run_node(
        http_request,
        {"url": f"{stub.url}/health", "until_ok": True, "poll": 0.2},
        cancel_when=lambda partial: len(stub.received) >= 2,
        work_dir=tmp_path,
    )

    assert result.status == "cancelled"


@pytest.mark.parametrize(
    ("inputs", "message"),
    [
        ({"request_timeout": 0}, "ValueError: request_timeout 必须大于 0"),
        # wait、poll 的校验与等待类节点相同。
        ({"poll": 0}, "ValueError: poll 必须大于 0，实际为 0"),
        ({"wait": -1}, "ValueError: wait 不能为负数，实际为 -1"),
    ],
)
def test_rejects_non_positive_durations(
    tmp_path: Path, stub: Stub, inputs: dict[str, Any], message: str
) -> None:
    assert failure(run(tmp_path, url=f"{stub.url}/x", **inputs)) == message
    assert stub.received == []
