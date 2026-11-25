"""平台臂的会话驱动（container/platform_driver.py）：对着一个假的控制面跑（照真实控制面的 SSE 格式：
`event:`、持久事件带 `id:`、每隔一会儿一条 `time` 心跳）。每种情况再经宿主机的
`classify_platform` 归类：审查（#715）的探测各是一条用例。"""

from __future__ import annotations

import json
import re
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import platform_driver
import pytest
from aeval.platform import ENVIRONMENT, PLATFORM, UNCLASSIFIED, classify_platform
from platform_driver import HEARTBEAT_EVENT, Client, run, sse_events

DRIVER = Path(platform_driver.__file__)
TURN_END = {"type": "turn_end", "seq": 4, "turn": 1, "outcome": "completed", "reason": "完成了"}
STOPPED = {"type": "turn_end", "seq": 9, "turn": 1, "outcome": "stopped", "reason": "停"}
CONTRACT = Path(__file__).resolve().parents[3] / "packages/schema/src/http/contract.ts"


def ev(body: dict[str, Any], name: str | None = None) -> str:
    head = f"event: {name or body.get('type')}\n"
    if "seq" in body:
        head += f"id: {body['seq']}\n"
    return head + f"data: {json.dumps(body, ensure_ascii=False)}\n\n"


def heartbeat() -> str:
    return ev({"time": "2026-11-25T00:00:00Z"}, "time")


class FakeControlPlane:
    """假的控制面。`mode`：
    - `ok`：补发三个事件、一个心跳和 turn_end；
    - `not-ready`：`readiness.ready` 是 false；
    - `create-503`、`create-no-id`、`create-not-json`：建会话出错的三种；
    - `break-once`：第一次连事件流发两个事件就断开，重连之后从断开处接着发到 turn_end；
    - `heartbeats`：事件流只发心跳；收到 stop 之后的下一次连接发 `stopped` 的 turn_end；
    - `silent`：事件流发了响应头之后一个字节都不来（直到 stop）；
    - `queued`：建会话回 `status: queued`，之后只有心跳，stop 之后也没有结局；
    - `ephemeral-end`：先一个不带序号的 turn_end，再一个带序号的；
    - `self-stopped`：没有收到 stop，平台自己给了 `stopped` 的 turn_end；
    - `odd-outcome`：turn_end 的结局不是契约里的值；
    - `empty`：事件流只发一个心跳就结束（每次重连都这样），stop 之后发 `stopped` 的 turn_end。
    `stop_code`、`end_code`：stop、end 回什么状态码；`slow`：开始前的检查和 end 各慢这么多秒。"""

    def __init__(
        self, mode: str, stop_code: int = 202, end_code: int = 202, slow: float = 0
    ) -> None:
        self.mode = mode
        self.stop_code = stop_code
        self.end_code = end_code
        self.slow = slow
        self.calls: list[tuple[str, str]] = []
        self.stopped = threading.Event()
        self.closing = threading.Event()
        self.streams = 0
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:
                pass

            def _json(self, status: int, body: Any, raw: bytes | None = None) -> None:
                data = raw if raw is not None else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length).decode() if length else None
                owner.calls.append(("POST", self.path))
                mode = owner.mode
                if self.path == "/projects/default/sessions":
                    assert json.loads(body or "{}") == {"text": "写一个节点"}
                    if mode == "create-503":
                        return self._json(503, {"code": "assistant_unavailable"})
                    if mode == "create-no-id":
                        return self._json(201, {"status": "running"})
                    if mode == "create-not-json":
                        return self._json(201, None, raw=b"<html>oops</html>")
                    status = "queued" if mode == "queued" else "running"
                    return self._json(201, {"id": "s1", "status": status})
                if self.path.endswith("/stop"):
                    owner.stopped.set()
                    return self._json(owner.stop_code, {"code": "x"})
                if self.path.endswith("/end"):
                    time.sleep(owner.slow)
                    return self._json(owner.end_code, {"code": "x"})
                self._json(404, {})

            def do_GET(self) -> None:  # noqa: N802
                owner.calls.append(("GET", self.path))
                if self.path == "/projects/default/sessions":
                    time.sleep(owner.slow)
                    ready = owner.mode != "not-ready"
                    problems = [] if ready else [{"message": "工作台不在线"}]
                    return self._json(200, {"readiness": {"ready": ready, "problems": problems}})
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()
                try:
                    for chunk in owner.stream(self.path):
                        self.wfile.write(chunk.encode())
                        self.wfile.flush()
                except OSError:
                    return
                self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stream(self, path: str) -> Iterator[str]:
        self.streams += 1
        yield "retry: 3000\n\n"
        yield heartbeat()
        if self.stopped.is_set():
            if self.mode != "queued":
                yield ev(STOPPED)
            return
        mode = self.mode
        if mode == "ok":
            yield ev({"type": "user_message", "seq": 1})
            yield ev({"type": "turn_started", "seq": 2})
            yield ev({"type": "assistant_delta", "text": "不持久的"})
            yield ev({"type": "assistant_message", "seq": 3})
            yield ev(TURN_END)
            return
        if mode == "self-stopped":
            yield ev({"type": "user_message", "seq": 1})
            yield ev(STOPPED)
            return
        if mode == "odd-outcome":
            yield ev({**TURN_END, "outcome": "paused"})
            return
        if mode == "empty":
            return
        if mode == "ephemeral-end":
            yield ev({"type": "turn_end", "turn": 1, "outcome": "completed"})
            yield ev({"type": "user_message", "seq": 1})
            yield ev(TURN_END)
            return
        if mode == "break-once":
            if self.streams == 1:
                yield ev({"type": "user_message", "seq": 1})
                yield ev({"type": "turn_started", "seq": 2})
                return
            assert path.endswith("after=2"), path
            yield ev({"type": "assistant_message", "seq": 3})
            yield ev(TURN_END)
            return
        if mode == "silent":
            until = time.monotonic() + 8
            while not (self.stopped.is_set() or self.closing.is_set()) and time.monotonic() < until:
                time.sleep(0.05)
            return
        yield ev({"type": "user_message", "seq": 1})
        # 最多 8 秒（驱动该在时限那一刻自己断开；没断开的话，用例按用时判出来，不一直挂着）。
        until = time.monotonic() + 8
        while not (self.stopped.is_set() or self.closing.is_set()) and time.monotonic() < until:
            yield heartbeat()
            time.sleep(0.1)

    def close(self) -> None:
        self.closing.set()
        self.server.shutdown()


@pytest.fixture(autouse=True)
def quick(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(platform_driver, "READ_TIMEOUT_SECONDS", 0.5)
    monkeypatch.setattr(platform_driver, "STOP_WAIT_SECONDS", 1.5)
    monkeypatch.setattr(platform_driver, "RECONNECT_PAUSE_SECONDS", 0.05)


def drive(mode: str, tmp_path: Path, max_seconds: float = 10, **codes: Any) -> dict[str, Any]:
    cp = FakeControlPlane(mode, **codes)
    said: list[dict[str, Any]] = []
    try:
        started = time.monotonic()
        record = run(
            Client(cp.url, "eval"), "default", "写一个节点", max_seconds, tmp_path, said.append
        )
        record["took"] = time.monotonic() - started
    finally:
        cp.close()
    record["calls"] = cp.calls
    # 不论怎么结束：都写了 platform.json、说了 done。
    assert json.loads((tmp_path / "platform.json").read_text())["problems"] == record["problems"]
    assert [s["event"] for s in said] == ["done"]
    return record


def kinds(record: dict[str, Any]) -> list[str]:
    return [f"{method} {path.split('?')[0]}" for method, path in record["calls"]]


def gets(record: dict[str, Any]) -> int:
    return len([p for m, p in record["calls"] if m == "GET" and p.startswith("/sessions/")])


def test_the_heartbeat_name_is_the_one_in_the_contract() -> None:
    found = re.search(r'CONTROL_PLANE_TIME_EVENT = "([^"]+)"', CONTRACT.read_text())
    assert found is not None and HEARTBEAT_EVENT == found.group(1)


def test_sse_events_keep_the_event_name_and_skip_comments() -> None:
    lines = iter([": hb\n", "\n", "event: x\n", "id: 3\n", 'data: {"a":\n', "data: 1}\n", "\n"])
    assert list(sse_events(lines)) == [("x", {"a": 1})]
    assert list(sse_events(iter(['data: {"b": 2}']))) == [("message", {"b": 2})]


def test_ok_checks_first_waits_for_turn_end_and_ends_the_session(tmp_path: Path) -> None:
    record = drive("ok", tmp_path)
    assert record["precheck"] == "ok"
    assert record["turn_end"] == TURN_END
    assert record["problems"] == [] and record["stream_breaks"] == []
    assert record["problem_kinds"] == []
    assert record["deadline_passed"] is False and record["stopped"] is False
    assert kinds(record) == [
        "GET /projects/default/sessions",
        "POST /projects/default/sessions",
        "GET /sessions/s1/events",
        "POST /sessions/s1/end",
    ]
    # 心跳不写进记录；不持久的事件照写。
    lines = (tmp_path / "platform-events.jsonl").read_text().splitlines()
    assert [json.loads(line)["type"] for line in lines] == [
        "user_message",
        "turn_started",
        "assistant_delta",
        "assistant_message",
        "turn_end",
    ]
    assert classify_platform(record) is None


def test_precheck_failure_is_an_environment_fault_and_creates_nothing(tmp_path: Path) -> None:
    record = drive("not-ready", tmp_path)
    assert record["precheck"] == "助手此刻不能用：工作台不在线"
    assert kinds(record) == ["GET /projects/default/sessions"]
    assert classify_platform(record) == (
        ENVIRONMENT,
        "开始前的检查没过：助手此刻不能用：工作台不在线",
    )


@pytest.mark.parametrize(
    ("mode", "problem"),
    [
        ("create-503", "返回 503"),
        ("create-no-id", "建会话的回应里没有会话 ID"),
        ("create-not-json", "的回应不是 JSON"),
    ],
)
def test_a_rejected_or_bad_create_is_a_platform_fault(
    mode: str, problem: str, tmp_path: Path
) -> None:
    record = drive(mode, tmp_path)
    assert record["session"] is None
    assert problem in record["problems"][0]
    assert kinds(record) == ["GET /projects/default/sessions", "POST /projects/default/sessions"]
    assert record["problem_kinds"] == ["control_plane"]
    assert record["seconds"] is not None
    fault = classify_platform(record)
    assert fault is not None and fault[0] == PLATFORM and problem in fault[1]


def test_a_broken_stream_reconnects_from_the_last_seq_and_is_not_a_fault(tmp_path: Path) -> None:
    record = drive("break-once", tmp_path)
    assert record["turn_end"] == TURN_END
    assert record["stream_breaks"] == ["事件流结束了"]
    assert record["deadline_passed"] is False and record["problems"] == []
    assert [p for m, p in record["calls"] if m == "GET"][1:] == [
        "/sessions/s1/events?after=0",
        "/sessions/s1/events?after=2",
    ]
    assert classify_platform(record) is None


def test_only_heartbeats_until_the_deadline_stop_then_the_outcome_is_a_platform_fault(
    tmp_path: Path,
) -> None:
    record = drive("heartbeats", tmp_path, max_seconds=1.0)
    # 只有心跳也停得下来：计时器在时限那一刻关掉连接。
    assert record["took"] < 1.0 + 1.5 + 1.0
    assert record["deadline_passed"] is True and record["stopped"] is True
    assert record["turn_end"] == STOPPED
    assert record["problems"] == ["在时限内没有等到 turn_end"]
    assert record["problem_kinds"] == ["deadline"]
    # 到了时限是计时器关的连接，不算一次断开；停止之后的那次连接等到了结局。
    assert record["stream_breaks"] == []
    assert kinds(record)[-3:] == [
        "POST /sessions/s1/stop",
        "GET /sessions/s1/events",
        "POST /sessions/s1/end",
    ]
    fault = classify_platform(record)
    assert fault is not None and fault[0] == PLATFORM and "评测停下了它" in fault[1]


def test_a_connection_that_sends_nothing_times_out_reconnects_and_stays_within_the_deadline(
    tmp_path: Path,
) -> None:
    record = drive("silent", tmp_path, max_seconds=1.6)
    assert record["took"] < 1.6 + 1.5 + 1.0
    assert record["stream_breaks"][0] == "事件流 0.5 秒没有任何字节"
    assert gets(record) >= 3
    assert record["deadline_passed"] is True


def test_reconnects_pause_between_attempts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(platform_driver, "RECONNECT_PAUSE_SECONDS", 0.25)
    record = drive("empty", tmp_path, max_seconds=1.0)
    # 时限 1 秒、每次隔 0.25 秒：时限内最多 5 次，加上停止之后的 1 次；不停顿会是几百次。
    assert 3 <= gets(record) <= 7, gets(record)
    assert record["stream_breaks"][0] == "事件流结束了"
    assert record["turn_end"] == STOPPED


def test_seconds_run_from_asking_to_the_outcome_without_the_precheck_or_end(
    tmp_path: Path,
) -> None:
    record = drive("ok", tmp_path, slow=0.6)
    assert record["took"] > 1.2
    assert record["seconds"] is not None and record["seconds"] < 0.5
    assert json.loads((tmp_path / "platform.json").read_text())["seconds"] == record["seconds"]


def test_the_seconds_after_a_stop_run_to_the_outcome_after_stop(tmp_path: Path) -> None:
    record = drive("heartbeats", tmp_path, max_seconds=0.6, slow=0.6)
    assert 0.6 <= record["seconds"] < 0.6 + 1.5 + 0.2


def test_a_stopped_outcome_nobody_asked_for_is_a_platform_fault(tmp_path: Path) -> None:
    record = drive("self-stopped", tmp_path)
    assert record["turn_end"] == STOPPED and record["stopped"] is False
    assert record["problems"] == []
    assert classify_platform(record) == (
        PLATFORM,
        "评测没有让它停，平台自己停下了这一轮：停",
    )


def test_an_outcome_outside_the_contract_is_unclassified(tmp_path: Path) -> None:
    record = drive("odd-outcome", tmp_path)
    assert classify_platform(record) == (UNCLASSIFIED, "结局不是契约里的值：'paused'")


class FullDisk:
    """写不进去的事件记录（磁盘满了）。"""

    def __init__(self, inner: Any) -> None:
        self.inner = inner

    def __enter__(self) -> FullDisk:
        return self

    def __exit__(self, *args: Any) -> None:
        self.inner.close()

    def write(self, text: str) -> int:
        raise OSError(28, "No space left on device")

    def flush(self) -> None:
        pass


def test_a_record_that_cannot_be_written_is_the_evaluators_problem_not_a_broken_stream(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_open = Path.open

    def open_(self: Path, *args: Any, **kwargs: Any) -> Any:
        opened = real_open(self, *args, **kwargs)
        return FullDisk(opened) if self.name == "platform-events.jsonl" else opened

    monkeypatch.setattr(Path, "open", open_)
    record = drive("ok", tmp_path)
    # 不当成事件流断了：不重连，马上收尾。
    assert gets(record) == 1 and record["stream_breaks"] == []
    assert record["deadline_passed"] is False
    assert record["problems"] == ["写不进事件记录：[Errno 28] No space left on device"]
    assert record["problem_kinds"] == ["evaluator"]
    assert kinds(record)[-1] == "POST /sessions/s1/end"
    assert classify_platform(record) == (
        ENVIRONMENT,
        "评测自己的问题：写不进事件记录：[Errno 28] No space left on device",
    )


@pytest.mark.parametrize("code", [404, 409, 500])
def test_a_failed_stop_is_recorded_and_the_session_is_still_ended(
    code: int, tmp_path: Path
) -> None:
    record = drive("heartbeats", tmp_path, max_seconds=0.6, stop_code=code)
    assert any(f"stop 返回 {code}" in p for p in record["problems"])
    assert kinds(record)[-1] == "POST /sessions/s1/end"
    fault = classify_platform(record)
    assert fault is not None and fault[0] == PLATFORM


def test_a_failed_end_is_a_platform_fault_even_after_a_good_outcome(tmp_path: Path) -> None:
    record = drive("ok", tmp_path, end_code=500)
    assert record["turn_end"] == TURN_END
    assert record["problem_kinds"] == ["control_plane"]
    assert record["problems"][0].startswith("结束会话：POST /sessions/s1/end 返回 500")
    fault = classify_platform(record)
    assert fault is not None and fault[0] == PLATFORM and "end 返回 500" in fault[1]


def test_a_queued_turn_says_so_and_no_outcome_after_stop_is_a_platform_fault(
    tmp_path: Path,
) -> None:
    record = drive("queued", tmp_path, max_seconds=0.6)
    assert record["queued"] is True and record["turn_end"] is None
    assert record["problems"] == [
        "在时限内没有等到 turn_end（这一轮在排队）",
        "停止之后没有等到结局",
    ]
    assert record["problem_kinds"] == ["deadline", "no_outcome_after_stop"]
    fault = classify_platform(record)
    assert fault is not None and fault[0] == PLATFORM and "排队" in fault[1]


def test_only_a_persistent_turn_end_ends_the_wait(tmp_path: Path) -> None:
    record = drive("ephemeral-end", tmp_path)
    assert record["turn_end"] == TURN_END and record["problems"] == []


def test_an_unexpected_error_is_the_evaluators_problem_and_still_ends_the_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*args: Any) -> Any:
        raise RuntimeError("意外")

    monkeypatch.setattr(Client, "follow", boom)
    record = drive("ok", tmp_path)
    assert record["problems"] == ["会话驱动出错：RuntimeError: 意外"]
    assert record["problem_kinds"] == ["evaluator"]
    assert kinds(record)[-1] == "POST /sessions/s1/end"
    # 会话已经建了、没有等到结局，也不记成平台的问题。
    assert classify_platform(record) == (
        ENVIRONMENT,
        "评测自己的问题：会话驱动出错：RuntimeError: 意外",
    )


@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT])
def test_a_signal_ends_the_session_writes_the_record_and_is_an_environment_fault(
    sig: signal.Signals, tmp_path: Path
) -> None:
    cp = FakeControlPlane("heartbeats")
    (tmp_path / "prompt.md").write_text("写一个节点")
    proc = subprocess.Popen(
        [sys.executable, str(DRIVER), "--cp", cp.url, "--nickname", "eval"]
        + ["--prompt-file", str(tmp_path / "prompt.md"), "--max-seconds", "60"]
        + ["--out", str(tmp_path / "run")],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + 10
        while not any(p.startswith("/sessions/s1/events") for _, p in cp.calls):
            assert time.monotonic() < deadline
            time.sleep(0.05)
        proc.send_signal(sig)
        output, _ = proc.communicate(timeout=20)
    finally:
        cp.close()
    record = json.loads((tmp_path / "run" / "platform.json").read_text())
    assert ("POST", "/sessions/s1/end") in cp.calls
    assert json.loads(output.strip().splitlines()[-1])["event"] == "done"
    assert record["problems"] == ["会话驱动被结束了（SIGTERM、SIGINT）"]
    assert record["problem_kinds"] == ["signal"]
    fault = classify_platform(record)
    assert fault is not None and fault[0] == ENVIRONMENT


def test_a_deadline_that_passes_before_the_connection_is_up_still_cuts_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(platform_driver, "READ_TIMEOUT_SECONDS", 5.0)
    cp = FakeControlPlane("silent")
    try:
        started = time.monotonic()
        with (tmp_path / "events.jsonl").open("w") as sink:
            why = Client(cp.url, "eval").stream_once("s1", 0, time.monotonic(), sink, [])
        took = time.monotonic() - started
    finally:
        cp.close()
    assert why is not None and took < 1.0, (why, took)
