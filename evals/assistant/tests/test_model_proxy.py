"""模型转发口：加上 pi 配置里的凭据、丢掉客户端带来的凭据、按提供方名转发、流式返回。"""

import json
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest
from aeval.model_proxy import Upstream, load_upstreams, make_server


@pytest.fixture
def upstream() -> Iterator[tuple[str, list[dict[str, Any]]]]:
    seen: list[dict[str, Any]] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            pass

        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers["content-length"]))
            headers = {k.lower(): v for k, v in self.headers.items()}
            seen.append({"path": self.path, "headers": headers, "body": body})
            data = b"data: one\n\ndata: two\n\n"
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}/v1", seen
    server.shutdown()


@pytest.fixture
def proxy(upstream: tuple[str, list[dict[str, Any]]]) -> Iterator[str]:
    base, _ = upstream
    upstreams = {
        "openai-ish": Upstream("openai-ish", base, "openai-completions", "sk-real"),
        "anthropic-ish": Upstream("anthropic-ish", base, "anthropic-messages", "ak-real"),
    }
    server = make_server(upstreams)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def post(url: str, headers: dict[str, str]) -> bytes:
    request = urllib.request.Request(url, data=b'{"x": 1}', headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=5) as resp:
        return bytes(resp.read())


def test_replaces_bearer_and_forwards_path(
    proxy: str, upstream: tuple[str, list[dict[str, Any]]]
) -> None:
    body = post(f"{proxy}/openai-ish/chat/completions", {"authorization": "Bearer placeholder"})
    _, seen = upstream
    assert body == b"data: one\n\ndata: two\n\n"
    assert seen[0]["path"] == "/v1/chat/completions"
    assert seen[0]["headers"]["authorization"] == "Bearer sk-real"
    assert seen[0]["body"] == b'{"x": 1}'


def test_anthropic_uses_x_api_key_and_drops_client_credentials(
    proxy: str, upstream: tuple[str, list[dict[str, Any]]]
) -> None:
    post(f"{proxy}/anthropic-ish/messages", {"x-api-key": "placeholder", "authorization": "x"})
    headers = upstream[1][0]["headers"]
    assert headers["x-api-key"] == "ak-real"
    assert "authorization" not in headers


def test_unknown_provider_is_404(proxy: str) -> None:
    with pytest.raises(urllib.error.HTTPError) as error:
        post(f"{proxy}/nope/x", {})
    assert error.value.code == 404


def test_loads_keys_from_models_and_auth(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AEVAL_TEST_KEY", "from-env")
    (tmp_path / "models.json").write_text(
        json.dumps(
            {
                "providers": {
                    "lit": {
                        "baseUrl": "https://a/v1/",
                        "api": "openai-completions",
                        "apiKey": "k1",
                    },
                    "env": {"baseUrl": "https://b", "api": "x", "apiKey": "$AEVAL_TEST_KEY"},
                    "cmd": {"baseUrl": "https://c", "api": "x", "apiKey": "!echo secret"},
                    "saved": {"baseUrl": "https://d", "api": "openai-responses"},
                    "none": {"baseUrl": "https://e", "api": "x"},
                }
            }
        )
    )
    (tmp_path / "auth.json").write_text(json.dumps({"saved": {"type": "api_key", "key": "k4"}}))
    upstreams = load_upstreams(tmp_path)
    assert {k: v.key for k, v in upstreams.items()} == {
        "lit": "k1",
        "env": "from-env",
        "saved": "k4",
    }
    assert upstreams["lit"].base_url == "https://a/v1"
    assert "k1" not in repr(upstreams["lit"])


def test_only_model_endpoints_are_forwarded(proxy: str) -> None:
    with pytest.raises(urllib.error.HTTPError) as error:
        post(f"{proxy}/openai-ish/files", {})
    assert error.value.code == 403


def test_allowed_paths() -> None:
    from aeval.model_proxy import allowed

    assert allowed("POST", "chat/completions")
    assert allowed("POST", "v1/messages")
    assert allowed("GET", "models")
    assert not allowed("POST", "files")
    assert not allowed("GET", "chat/completions")


def test_unreachable_upstream_leaks_no_credential(capfd: pytest.CaptureFixture[str]) -> None:
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        closed_port = sock.getsockname()[1]
    server = make_server(
        {
            "down": Upstream(
                "down",
                f"http://127.0.0.1:{closed_port}/v1",
                "openai-completions",
                "sk-secret-value",
            )
        }
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with pytest.raises(urllib.error.HTTPError) as error:
            post(f"http://127.0.0.1:{server.server_address[1]}/down/chat/completions", {})
        body = error.value.read().decode()
    finally:
        server.shutdown()
    assert error.value.code == 502
    captured = capfd.readouterr()
    for text in (body, captured.out, captured.err):
        assert "sk-secret-value" not in text
