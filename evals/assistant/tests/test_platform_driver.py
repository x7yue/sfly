"""平台臂的会话驱动（container/platform_driver.py）：对着一个假的控制面跑，看它建会话、跟事件流、
过了时限先停再等结局、最后总是结束会话。"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from platform_driver import Client, run, sse_events

TURN_END = {"type": "turn_end", "seq": 4, "turn": 1, "outcome": "completed", "reason": "完成了"}


class FakeControlPlane:
    """假的控制面。`mode`：
    - `ok`：事件流补发三个事件和 turn_end；
    - `silent`：事件流只发心跳，收到 stop 之后下一条事件流发 `stopped` 的 turn_end；
    - `down`：建会话回 503；
    - `no-id`：建会话回 201，但回应里没有 `id`；
    - `ephemeral-end`：先来一个不带序号（不持久）的 turn_end，再来带序号的；
    - `broken`：事件流发了一个事件就断开，之后不再有结局。"""

    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.calls: list[tuple[str, str, str | None]] = []
        self.stopped = threading.Event()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:
                pass

            def _json(self, status: int, body: Any) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length).decode() if length else None
                owner.calls.append(("POST", self.path, self.headers.get("x-sfly-nickname")))
                if self.path == "/projects/default/sessions":
                    if owner.mode == "down":
                        return self._json(503, {"code": "assistant_unavailable"})
                    assert json.loads(body or "{}") == {"text": "写一个节点"}
                    return self._json(201, {} if owner.mode == "no-id" else {"id": "s1"})
                if self.path.endswith("/stop"):
                    owner.stopped.set()
                self._json(202, None)

            def do_GET(self) -> None:  # noqa: N802
                owner.calls.append(("GET", self.path, self.headers.get("x-sfly-nickname")))
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()
                for chunk in owner.stream(self.path):
                    try:
                        self.wfile.write(chunk.encode())
                        self.wfile.flush()
                    except OSError:
                        return
                self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stream(self, path: str) -> Iterator[str]:
        def event(body: dict[str, Any]) -> str:
            return f"data: {json.dumps(body, ensure_ascii=False)}\n\n"

        if self.mode == "ephemeral-end":
            yield event({"type": "turn_end", "turn": 1, "outcome": "completed", "reason": "不持久"})
            yield event({"type": "user_message", "seq": 1})
            yield event({**TURN_END, "seq": 2})
            return
        if self.mode == "broken":
            yield event({"type": "user_message", "seq": 1})
            return
        if self.mode == "ok":
            yield event({"type": "user_message", "seq": 1})
            yield event({"type": "turn_started", "seq": 2})
            yield event({"type": "assistant_delta", "text": "不持久的"})
            yield event({"type": "assistant_message", "seq": 3})
            yield event(TURN_END)
            return
        if self.stopped.is_set():
            assert path.endswith("after=1"), path
            end = {"type": "turn_end", "seq": 2, "turn": 1, "outcome": "stopped", "reason": "停"}
            yield event(end)
            return
        yield event({"type": "user_message", "seq": 1})
        for _ in range(100):
            yield ": heartbeat\n\n"
            time.sleep(0.1)


@pytest.fixture
def said() -> list[dict[str, Any]]:
    return []


def test_sse_events_skip_comments_and_join_data_lines() -> None:
    lines = [": hb\n", "\n", "id: 3\n", 'data: {"a":\n', "data: 1}\n", "\n", 'data: {"b": 2}']
    assert list(sse_events(lines)) == [{"a": 1}, {"b": 2}]


def test_waits_for_turn_end_then_ends_the_session(tmp_path: Path, said: list[Any]) -> None:
    cp = FakeControlPlane("ok")
    record = run(Client(cp.url, "eval"), "default", "写一个节点", 30, tmp_path, said.append)
    assert record["session"] == "s1"
    assert record["turn_end"] == TURN_END
    assert record["problems"] == [] and record["stopped"] is False
    assert [c[:2] for c in cp.calls] == [
        ("POST", "/projects/default/sessions"),
        ("GET", "/sessions/s1/events?after=0"),
        ("POST", "/sessions/s1/end"),
    ]
    # 每个请求都带着发话人的昵称（#547 之前只要它）。
    assert {c[2] for c in cp.calls} == {"eval"}
    assert [s["event"] for s in said] == ["created", "done"]
    assert said[0]["session"] == "s1"
    # 事件流里收到的每个事件（含不持久的）原样写下；结果也写进 platform.json。
    lines = (tmp_path / "platform-events.jsonl").read_text().splitlines()
    assert [json.loads(line)["type"] for line in lines] == [
        "user_message",
        "turn_started",
        "assistant_delta",
        "assistant_message",
        "turn_end",
    ]
    assert json.loads((tmp_path / "platform.json").read_text())["turn_end"] == TURN_END


def test_past_the_deadline_with_only_heartbeats_it_stops_waits_for_the_outcome_and_ends(
    tmp_path: Path, said: list[Any]
) -> None:
    cp = FakeControlPlane("silent")
    started = time.monotonic()
    record = run(Client(cp.url, "eval"), "default", "写一个节点", 1.0, tmp_path, said.append)
    # 只有心跳也停得下来：时限在每一行上检查，不等事件。
    assert time.monotonic() - started < 8
    assert record["stopped"] is True
    assert record["turn_end"]["outcome"] == "stopped"
    assert record["problems"] == ["在时限内没有等到 turn_end"]
    assert [c[:2] for c in cp.calls] == [
        ("POST", "/projects/default/sessions"),
        ("GET", "/sessions/s1/events?after=0"),
        ("POST", "/sessions/s1/stop"),
        ("GET", "/sessions/s1/events?after=1"),
        ("POST", "/sessions/s1/end"),
    ]


def test_when_the_session_cannot_be_created_nothing_is_stopped_or_ended(
    tmp_path: Path, said: list[Any]
) -> None:
    cp = FakeControlPlane("down")
    record = run(Client(cp.url, "eval"), "default", "写一个节点", 30, tmp_path, said.append)
    assert record["session"] is None and record["turn_end"] is None
    assert "返回 503" in record["problems"][0]
    assert [c[:2] for c in cp.calls] == [("POST", "/projects/default/sessions")]
    assert [s["event"] for s in said] == ["done"]


def test_a_session_response_without_an_id_is_a_problem_not_a_crash(
    tmp_path: Path, said: list[Any]
) -> None:
    cp = FakeControlPlane("no-id")
    record = run(Client(cp.url, "eval"), "default", "写一个节点", 30, tmp_path, said.append)
    assert record["session"] is None
    assert record["problems"][0].startswith("建会话的回应里没有会话 ID")
    assert [c[:2] for c in cp.calls] == [("POST", "/projects/default/sessions")]
    assert [s["event"] for s in said] == ["done"]


def test_only_a_persistent_turn_end_ends_the_wait(tmp_path: Path, said: list[Any]) -> None:
    cp = FakeControlPlane("ephemeral-end")
    record = run(Client(cp.url, "eval"), "default", "写一个节点", 30, tmp_path, said.append)
    assert record["turn_end"] == {**TURN_END, "seq": 2}
    assert record["problems"] == []


def test_a_stream_that_breaks_before_turn_end_stops_and_still_ends_the_session(
    tmp_path: Path, said: list[Any]
) -> None:
    cp = FakeControlPlane("broken")
    record = run(Client(cp.url, "eval"), "default", "写一个节点", 30, tmp_path, said.append)
    assert record["turn_end"] is None
    assert record["problems"][0] == "事件流在 turn_end 之前就结束了"
    assert [c[:2] for c in cp.calls][-1] == ("POST", "/sessions/s1/end")
