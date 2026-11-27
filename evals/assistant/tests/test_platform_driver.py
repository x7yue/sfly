"""平台臂的会话驱动（container/platform_driver.py）：对着一个假的控制面跑（照真实控制面的 SSE 格式：
`event:`、持久事件带 `id:`、每隔一会儿一条 `time` 心跳）。每种情况再经宿主机的
`classify_platform` 归类：审查（#715）的探测各是一条用例。"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import platform_driver
import pytest
from aeval.platform import ENVIRONMENT, PLATFORM, UNCLASSIFIED, classify_platform
from platform_driver import ADMIN_PASSWORD_ENV, HEARTBEAT_EVENT, Client, run, sse_events

DRIVER = Path(platform_driver.__file__)
LOGIN_NAME = "aeval_admin"
PASSWORD = "pw-3f9a-this-must-never-reach-a-file-or-stdout"
COOKIE = "sfly_login=ck-8d21-neither-may-the-cookie"
TURN_END = {"type": "turn_end", "seq": 4, "turn": 1, "outcome": "completed", "reason": "完成了"}
STOPPED = {"type": "turn_end", "seq": 9, "turn": 1, "outcome": "stopped", "reason": "停"}
CONTRACT = Path(__file__).resolve().parents[3] / "packages/schema/src/http/contract.ts"


def straddle(prefix: str, secret: str, keep: int, limit: int, suffix: str = '"}}') -> str:
    """一段文字：`secret` 从第 `limit - keep` 个字符开始，截到 `limit` 个字符时只剩它的前
    `keep` 个字符（驱动先截断后打码时，前半截原样留下来；先打码后截断时整个被换掉）。"""
    assert len(prefix) < limit - keep
    return prefix + "A" * (limit - keep - len(prefix)) + secret + suffix


def fragments(secret: str, text: str, size: int = 8) -> list[str]:
    """`secret` 里长度为 `size` 的片段，在 `text` 里出现了的。"""
    return [
        secret[i : i + size] for i in range(len(secret) - size + 1) if secret[i : i + size] in text
    ]


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
    - `login-401`、`login-no-cookie`：登录被拒绝（回应体里回显了密码）、登录成功但没有 Cookie；
    - `precheck-echo`：开始前的检查回 500、回应体里回显了密码和 Cookie；
    - `*-straddle`：回显的凭据**跨过驱动截断的那一个字符**（登录 401 的回应体 500、建会话 503 的
      500、建会话回应不是 JSON 的 200、建会话回应没有 ID 的 200、就绪状态没过的 200、开始前的检查
      500）：先截断后打码时前半截会留下；
    - `readiness-missing-straddle`：就绪状态的回应里没有 `readiness`，回显跨过 200；
    - `assistant-not-configured`：建会话回 503 `assistant_not_configured`；
    - `snapshot-commit`：每次连上先发一条不带序号的 `snapshot`，第一次连接发到 seq 3 就断，
      重连之后补
      `platform`（`commit`，seq 4）和 `turn_end`（seq 5）；
    - `create-500-model-unavailable`：建会话回 500（不是 503）、错误码是 `model_unavailable`；
    - `model-unavailable`、`events-not-connected`、`assistant-start-failed`：建会话回 503，
      错误码和说明照真实控制面（回应体里回显了密码和 Cookie，看记录里有没有）。
    **和 dev 上的控制面一样要登录**：`POST /auth/login` 要 `sec-fetch-site: same-origin` 和对的
    登录名密码，回 `Set-Cookie: sfly_login=…`；别的请求没有这个 Cookie 一律 401（建会话在 dev 上就是
    这样）。
    `stop_code`、`end_code`：stop、end 回什么状态码；`slow`：开始前的检查和 end 各慢这么多秒。"""

    def __init__(
        self, mode: str, stop_code: int = 202, end_code: int = 202, slow: float = 0
    ) -> None:
        self.mode = mode
        self.stop_code = stop_code
        self.end_code = end_code
        self.slow = slow
        self.calls: list[tuple[str, str]] = []
        # 每个请求带的凭据：（方法、路径、cookie、sec-fetch-site）。
        self.seen: list[tuple[str, str, str | None, str | None]] = []
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

            def _unauthorized(self) -> bool:
                """没有登录 Cookie 的请求回 401（和 dev 上的控制面一样）；记下每个请求带了什么。"""
                cookie = self.headers.get("cookie")
                same = self.headers.get("sec-fetch-site")
                owner.seen.append((self.command, self.path, cookie, same))
                if cookie == COOKIE and same == "same-origin":
                    return False
                self._json(401, {"error": {"code": "unauthorized", "message": "要登录"}})
                return True

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length).decode() if length else None
                owner.calls.append(("POST", self.path))
                mode = owner.mode
                if self.path == "/auth/login":
                    owner.seen.append(("POST", self.path, None, self.headers.get("sec-fetch-site")))
                    sent = json.loads(body or "{}")
                    good = sent == {"login_name": LOGIN_NAME, "password": PASSWORD}
                    if self.headers.get("sec-fetch-site") != "same-origin" or not good:
                        # 回应体里回显了请求的密码：看驱动写记录之前有没有把它换掉。
                        text = f"登录名或密码不对：{sent.get('password')}"
                        return self._json(401, {"error": {"code": "unauthorized", "message": text}})
                    if mode == "login-401":
                        return self._json(401, {"error": {"message": f"拒绝了 {PASSWORD}"}})
                    if mode == "login-straddle":
                        body = straddle('{"error": {"code": "x", "message": "', PASSWORD, 31, 500)
                        return self._json(401, None, raw=body.encode())
                    data = b"{}"
                    self.send_response(200)
                    self.send_header("content-type", "application/json")
                    if mode != "login-no-cookie":
                        self.send_header(
                            "set-cookie", f"{COOKIE}; Path=/; HttpOnly; SameSite=Strict"
                        )
                    self.send_header("content-length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                if self._unauthorized():
                    return
                if self.path == "/projects/default/sessions":
                    assert json.loads(body or "{}") == {"text": "写一个节点"}
                    if mode == "create-503":
                        return self._json(503, {"code": "assistant_unavailable"})
                    if mode == "create-500-model-unavailable":
                        # 不是 503：就算错误码对，也不是「环境没准备好」的拒绝。
                        refusal = {"error": {"code": "model_unavailable", "message": "x"}}
                        return self._json(500, refusal)
                    if mode == "create-503-straddle":
                        value = COOKIE.removeprefix("sfly_login=")
                        body = straddle('{"error": {"code": "x", "message": "', value, 12, 500)
                        return self._json(503, None, raw=body.encode())
                    if mode == "create-503-not-ready-straddle":
                        # 回应体是合法的 JSON，错误码是环境没准备好；凭据跨过 500 个字符的截断点：
                        # 判「环境没准备好」看整个（打过码的）回应体，不看被截断的。
                        value = COOKIE.removeprefix("sfly_login=")
                        head = '{"error": {"code": "model_unavailable", "message": "'
                        # 凭据之后还有很长的话：打码之后整个回应体仍比 500 个字符长，截断确实发生。
                        body = straddle(head, value, 12, 500, "B" * 300 + '"}}')
                        return self._json(503, None, raw=body.encode())
                    if mode == "create-not-json-straddle":
                        body = straddle("<html>", PASSWORD, 20, 200, "</html>")
                        return self._json(201, None, raw=body.encode())
                    if mode == "create-no-id-straddle":
                        body = straddle('{"echo": "', PASSWORD, 20, 200, '"}')
                        return self._json(201, None, raw=body.encode())
                    if mode == "assistant-not-configured":
                        refusal = {
                            "error": {"code": "assistant_not_configured", "message": "助手没有开启"}
                        }
                        return self._json(503, refusal)
                    echo = f"（回显：{PASSWORD} {COOKIE}）"
                    for name, code, message in (
                        ("model-unavailable", "model_unavailable", "没有配置模型：缺 MODEL_KEY"),
                        (
                            "events-not-connected",
                            "assistant_unavailable",
                            "助手服务的事件流还没有连上（控制面刚启动或正在重新连接），过几秒再试",
                        ),
                        (
                            "assistant-start-failed",
                            "assistant_unavailable",
                            "助手服务起不了这一轮的进程",
                        ),
                    ):
                        if mode == name:
                            return self._json(
                                503, {"error": {"code": code, "message": message + echo}}
                            )
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
                if self._unauthorized():
                    return
                if self.path == "/projects/default/sessions":
                    time.sleep(owner.slow)
                    if owner.mode == "readiness-straddle":
                        head = '{"ready": false, "problems": [], "echo": "'
                        echo = straddle(head, PASSWORD, 20, 200, '"}')
                        return self._json(200, None, raw=('{"readiness": ' + echo + "}").encode())
                    if owner.mode == "readiness-missing-straddle":
                        echo = straddle('{"echo": "', PASSWORD, 20, 200, '"}')
                        return self._json(200, None, raw=echo.encode())
                    if owner.mode == "precheck-straddle":
                        body = straddle('{"error": {"message": "', PASSWORD, 31, 500)
                        return self._json(500, None, raw=body.encode())
                    if owner.mode == "precheck-echo":
                        # 开始前的检查出错、回应体里回显了凭据。
                        return self._json(500, {"error": {"message": f"炸了 {PASSWORD} {COOKIE}"}})
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
        if mode == "snapshot-commit":
            after = int(path.split("after=")[1])
            snap = {
                "type": "snapshot",
                "status": "running",
                "partial_text": "",
                "running_tool": None,
            }
            yield ev(snap, "snapshot")
            events: list[dict[str, Any]] = [
                {"type": "user_message", "seq": 1},
                {"type": "turn_started", "seq": 2},
                {"type": "assistant_message", "seq": 3},
                {"type": "platform", "kind": "commit", "seq": 4},
                TURN_END | {"seq": 5},
            ]
            for event in events:
                if event["seq"] <= after:
                    continue
                yield ev(event)
                if self.streams == 1 and event["seq"] == 3:
                    return  # 第一次连接在这里断
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


def drive(
    mode: str,
    tmp_path: Path,
    max_seconds: float = 10,
    client: Callable[[str], Client] | None = None,
    **codes: Any,
) -> dict[str, Any]:
    cp = FakeControlPlane(mode, **codes)
    said: list[dict[str, Any]] = []
    try:
        started = time.monotonic()
        record = run(
            client(cp.url) if client else Client(cp.url, "eval", LOGIN_NAME, PASSWORD),
            "default",
            "写一个节点",
            max_seconds,
            tmp_path,
            said.append,
        )
        record["took"] = time.monotonic() - started
    finally:
        cp.close()
    record["calls"] = cp.calls
    record["seen"] = cp.seen
    record["said"] = said
    # 不论怎么结束：都写了 platform.json、说了 done。
    assert json.loads((tmp_path / "platform.json").read_text())["problems"] == record["problems"]
    assert [s["event"] for s in said] == ["done"]
    return record


def kinds(record: dict[str, Any]) -> list[str]:
    """会话相关的请求（登录不算：它另有用例）。"""
    return [
        f"{method} {path.split('?')[0]}"
        for method, path in record["calls"]
        if path != "/auth/login"
    ]


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
        + ["--login-name", LOGIN_NAME]
        + ["--prompt-file", str(tmp_path / "prompt.md"), "--max-seconds", "60"]
        + ["--out", str(tmp_path / "run")],
        stdout=subprocess.PIPE,
        text=True,
        # 密码只经环境变量，不在命令行参数里。
        env={**os.environ, ADMIN_PASSWORD_ENV: PASSWORD},
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


def test_a_deadline_that_passes_while_connecting_still_cuts_the_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import http.client

    real_request = http.client.HTTPConnection.request

    def slow_request(self: Any, *args: Any, **kwargs: Any) -> None:
        time.sleep(0.5)  # 时限在发请求的时候就到了
        real_request(self, *args, **kwargs)

    monkeypatch.setattr(http.client.HTTPConnection, "request", slow_request)
    cp = FakeControlPlane("heartbeats")  # 心跳每 0.1 秒一条：读一直有字节，读的超时到不了
    try:
        started = time.monotonic()
        with (tmp_path / "events.jsonl").open("w") as sink:
            client = Client(cp.url, "eval", LOGIN_NAME, PASSWORD)
            client.login()
            why = client.stream_once("s1", 0, time.monotonic() + 0.3, sink, [])
        took = time.monotonic() - started
    finally:
        cp.close()
    assert why is not None and took < 1.5, (why, took)


def test_every_request_after_the_login_carries_the_cookie_and_the_same_origin_header(
    tmp_path: Path,
) -> None:
    record = drive("ok", tmp_path)
    assert record["problems"] == [] and classify_platform(record) is None
    # 登录先于一切，用对的登录名和密码、带 sec-fetch-site: same-origin；
    # 之后的每个请求（检查、建会话、事件流、结束）都带 Cookie。
    assert record["calls"][0] == ("POST", "/auth/login")
    assert record["seen"][0] == ("POST", "/auth/login", None, "same-origin")
    after = record["seen"][1:]
    assert [m for m, *_ in after] == ["GET", "POST", "GET", "POST"]
    assert all(cookie == COOKIE and same == "same-origin" for _, _, cookie, same in after)


def test_a_create_without_the_login_cookie_is_refused_like_on_dev() -> None:
    from platform_driver import ControlPlaneError

    # 假控制面和 dev 上的一样：没有 Cookie 的建会话回 401
    # （驱动没登录时就会这样，被记成控制面回错）。
    cp = FakeControlPlane("ok")
    try:
        with pytest.raises(ControlPlaneError, match="返回 401"):
            Client(cp.url, "eval").request(
                "POST", "/projects/default/sessions", {"text": "写一个节点"}
            )
        # 登录之后同一个请求成功。
        client = Client(cp.url, "eval", LOGIN_NAME, PASSWORD)
        client.login()
        assert (
            client.request("POST", "/projects/default/sessions", {"text": "写一个节点"})["id"]
            == "s1"
        )
    finally:
        cp.close()


def test_a_refused_login_is_an_environment_fault_and_nothing_else_is_sent(tmp_path: Path) -> None:
    record = drive("login-401", tmp_path)
    assert record["session"] is None and record["seconds"] is None
    assert record["precheck"].startswith("管理员登录失败：管理员登录返回 401")
    assert record["problem_kinds"] == ["login"]
    assert [c for c in record["calls"]] == [("POST", "/auth/login")]
    fault = classify_platform(record)
    assert fault is not None and fault[0] == ENVIRONMENT and "管理员登录失败" in fault[1]


def test_a_wrong_password_is_an_environment_fault_and_the_password_is_not_recorded(
    tmp_path: Path,
) -> None:
    record = drive(
        "ok", tmp_path, client=lambda url: Client(url, "eval", LOGIN_NAME, PASSWORD + "-wrong")
    )
    assert record["problem_kinds"] == ["login"]
    assert "-wrong" not in json.dumps(record["problems"]) + record["precheck"]
    assert "******" in record["precheck"]
    assert classify_platform(record)[0] == ENVIRONMENT  # type: ignore[index]


def test_login_that_gives_no_cookie_is_an_environment_fault(tmp_path: Path) -> None:
    record = drive("login-no-cookie", tmp_path)
    assert record["problem_kinds"] == ["login"]
    assert "没有拿到登录 Cookie" in record["precheck"]
    assert classify_platform(record)[0] == ENVIRONMENT  # type: ignore[index]


def test_login_that_cannot_reach_the_control_plane_is_an_environment_fault(
    tmp_path: Path,
) -> None:
    said: list[dict[str, Any]] = []
    record = run(
        Client("http://127.0.0.1:1", "eval", LOGIN_NAME, PASSWORD),
        "default",
        "写一个节点",
        5,
        tmp_path,
        said.append,
    )
    assert record["problem_kinds"] == ["login"] and record["session"] is None
    assert "连不上控制面" in record["precheck"]
    fault = classify_platform(record)
    assert fault is not None and fault[0] == ENVIRONMENT


def test_no_admin_password_is_an_environment_fault_and_says_which_variable(tmp_path: Path) -> None:
    record = drive("ok", tmp_path, client=lambda url: Client(url, "eval", LOGIN_NAME, None))
    assert record["problem_kinds"] == ["login"]
    assert ADMIN_PASSWORD_ENV in record["precheck"]
    assert record["calls"] == []


@pytest.mark.parametrize(
    "mode", ["model-unavailable", "events-not-connected", "assistant-not-configured"]
)
def test_a_create_rejected_because_the_environment_is_not_ready_is_an_environment_fault(
    mode: str, tmp_path: Path
) -> None:
    record = drive(mode, tmp_path)
    assert record["session"] is None and record["turn_end"] is None
    assert record["problem_kinds"] == ["not_ready"]
    assert "返回 503" in record["problems"][0]
    # 不发 stop、end（没有建成会话）。
    assert kinds(record) == ["GET /projects/default/sessions", "POST /projects/default/sessions"]
    fault = classify_platform(record)
    assert fault is not None and fault[0] == ENVIRONMENT
    assert "建会话时环境没有准备好" in fault[1]


def test_a_create_rejected_for_another_reason_stays_a_platform_fault(tmp_path: Path) -> None:
    # 助手服务起不了这一轮的进程：同样是 503 `assistant_unavailable`，但不是环境没准备好。
    record = drive("assistant-start-failed", tmp_path)
    assert record["problem_kinds"] == ["control_plane"]
    fault = classify_platform(record)
    assert fault is not None and fault[0] == PLATFORM


def test_only_a_503_can_be_an_environment_not_ready_rejection(tmp_path: Path) -> None:
    record = drive("create-500-model-unavailable", tmp_path)
    assert record["problem_kinds"] == ["control_plane"]
    fault = classify_platform(record)
    assert fault is not None and fault[0] == PLATFORM


@pytest.mark.parametrize(
    "mode",
    [
        "login-401",
        "precheck-echo",
        "model-unavailable",
        "events-not-connected",
        "assistant-start-failed",
    ],
)
def test_neither_the_password_nor_the_cookie_reaches_a_file_or_stdout(
    mode: str, tmp_path: Path
) -> None:
    # 假控制面在错误回应里回显密码和 Cookie：驱动写进记录、标准输出之前把它们换成 ******。
    record = drive(mode, tmp_path)
    written = "".join(p.read_text() for p in tmp_path.rglob("*") if p.is_file())
    stdout = json.dumps(record["said"], ensure_ascii=False)
    for text in (written, stdout, json.dumps(record["problems"], ensure_ascii=False)):
        assert PASSWORD not in text
        assert COOKIE not in text and COOKIE.removeprefix("sfly_login=") not in text
    if mode != "login-401":
        assert "******" in written


def test_the_driver_process_takes_the_password_from_the_environment_only(tmp_path: Path) -> None:
    cp = FakeControlPlane("ok")
    (tmp_path / "prompt.md").write_text("写一个节点")
    argv = [sys.executable, str(DRIVER), "--cp", cp.url, "--nickname", "eval"]
    argv += ["--login-name", LOGIN_NAME, "--prompt-file", str(tmp_path / "prompt.md")]
    argv += ["--max-seconds", "30", "--out", str(tmp_path / "run")]
    try:
        # 密码不在参数里，也不是参数的一部分：环境里有它，这次会话成功；
        done = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=60,
            env={**os.environ, ADMIN_PASSWORD_ENV: PASSWORD},
        )
        assert PASSWORD not in " ".join(argv)
        assert done.returncode == 0, done.stdout + done.stderr
        record = json.loads((tmp_path / "run" / "platform.json").read_text())
        assert record["problems"] == [] and record["turn_end"] is not None
        assert PASSWORD not in done.stdout and PASSWORD not in done.stderr
        # 没有这个环境变量：登录失败，记成环境故障，退出码不是 0，照样写记录、说 done。
        env = {k: v for k, v in os.environ.items() if k != ADMIN_PASSWORD_ENV}
        missing = subprocess.run(
            [*argv[:-1], str(tmp_path / "run2")],
            capture_output=True,
            text=True,
            timeout=60,
            env=env,
        )
    finally:
        cp.close()
    assert missing.returncode == 1
    lost = json.loads((tmp_path / "run2" / "platform.json").read_text())
    assert lost["problem_kinds"] == ["login"] and ADMIN_PASSWORD_ENV in lost["precheck"]
    assert json.loads(missing.stdout.strip().splitlines()[-1])["event"] == "done"


STRADDLES = [
    # （模式, 凭据, 驱动里这一处截到几个字符）
    ("login-straddle", PASSWORD, 500),
    ("precheck-straddle", PASSWORD, 500),
    ("readiness-straddle", PASSWORD, 200),
    ("readiness-missing-straddle", PASSWORD, 200),
    ("create-503-straddle", COOKIE.removeprefix("sfly_login="), 500),
    ("create-503-not-ready-straddle", COOKIE.removeprefix("sfly_login="), 500),
    ("create-not-json-straddle", PASSWORD, 200),
    ("create-no-id-straddle", PASSWORD, 200),
]


@pytest.mark.parametrize(("mode", "secret", "limit"), STRADDLES)
def test_a_credential_across_the_cut_is_masked_first_and_cut_after(
    mode: str, secret: str, limit: int, tmp_path: Path
) -> None:
    # 回显的凭据跨过驱动截断的那一个字符：先截断后打码时，凭据的前半截认不出来、
    # 原样进 platform.json 和标准输出
    # （审查 #715 第三轮：登录 401 留下 32 位密码的前 31 位）。先打码后截断时，整段凭据换成 ******，
    # 记录里没有它的任何一段（8 个字符的片段也没有）。
    record = drive(mode, tmp_path)
    written = "".join(p.read_text() for p in tmp_path.rglob("*") if p.is_file())
    stdout = json.dumps(record["said"], ensure_ascii=False)
    for text in (written, stdout):
        assert fragments(secret, text) == [], (mode, fragments(secret, text)[:3])
        assert fragments(PASSWORD, text) == [] and fragments(COOKIE, text) == []
    assert "******" in written
    # 问题照样记下来了（不是被吞掉）。
    assert record["problems"] or record["precheck"] != "ok", mode


def test_the_not_ready_verdict_reads_the_whole_body_not_the_cut_one(tmp_path: Path) -> None:
    record = drive("create-503-not-ready-straddle", tmp_path)
    assert record["problem_kinds"] == ["not_ready"]
    fault = classify_platform(record)
    assert fault is not None and fault[0] == ENVIRONMENT


def test_scrub_masks_every_way_the_credentials_are_written() -> None:
    client = Client("http://127.0.0.1:1", "eval", LOGIN_NAME, PASSWORD)
    client._cookie = COOKIE
    value = COOKIE.removeprefix("sfly_login=")
    for text in (
        f"密码 {PASSWORD} 结束",
        f"Cookie {COOKIE} 结束",
        # 只有值、没有前缀（`Set-Cookie` 之外的地方回显的写法）：
        # 去掉 `sfly_login=` 前缀的那一次替换。
        f"值 {value} 结束",
        json.dumps({"echo": PASSWORD}),
        json.dumps({"echo": value}),
    ):
        scrubbed = client.scrub(text)
        assert fragments(PASSWORD, scrubbed) == [] and fragments(value, scrubbed) == [], text
        assert "******" in scrubbed
    # 不认的写法不动：没有凭据的文字原样返回；`sfly_login=` 这几个字本身不是秘密。
    assert client.scrub("没有凭据 sfly_login= 的文字") == "没有凭据 sfly_login= 的文字"
    # 只认完整的出现：前半截不换（按它们能一位一位试出值），所以要截断的文字先打码后截断。
    assert client.scrub(PASSWORD[:20]) == PASSWORD[:20]
    assert client.clip(f"{'A' * 490}{PASSWORD}", 500) == "A" * 490 + "******"


def test_scrub_masks_the_json_escaped_writing_of_a_credential() -> None:
    # 回应体是 JSON：值里有引号、反斜杠时，回显出来的是转义之后的写法，和原文不一样。
    password = 'pa"ss\\word-0123456789'
    client = Client("http://127.0.0.1:1", "eval", LOGIN_NAME, password)
    escaped = json.dumps({"echo": password})
    assert password not in escaped
    scrubbed = client.scrub(escaped)
    assert fragments(password, scrubbed, 6) == []
    assert "******" in scrubbed


def test_stream_break_reasons_are_scrubbed_before_they_are_recorded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 事件流断开的原因里有异常的文字（可能带着凭据）：记进 stream_breaks 和标准输出之前先打码。
    real = Client.stream_once
    calls: list[int] = []

    def breaking(self: Client, *args: Any) -> str | None:
        calls.append(1)
        if len(calls) <= 2:
            return f"事件流断了：回显 {PASSWORD} 和 {COOKIE}"
        return real(self, *args)

    monkeypatch.setattr(Client, "stream_once", breaking)
    record = drive("ok", tmp_path)
    assert record["stream_breaks"] and all("******" in b for b in record["stream_breaks"])
    written = "".join(p.read_text() for p in tmp_path.rglob("*") if p.is_file())
    stdout = json.dumps(record["said"], ensure_ascii=False)
    for text in (written, stdout, json.dumps(record["stream_breaks"], ensure_ascii=False)):
        assert fragments(PASSWORD, text) == [] and fragments(COOKIE, text) == []


def test_stream_break_reasons_after_a_stop_are_scrubbed_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = Client.follow

    def following(self: Client, session_id: str, deadline: float, sink: Any, received: Any) -> Any:
        got, breaks = real(self, session_id, deadline, sink, received)
        return got, [*breaks, f"停止之后断了 {PASSWORD}"]

    monkeypatch.setattr(Client, "follow", following)
    record = drive("heartbeats", tmp_path, max_seconds=0.6)
    assert any(b.startswith("停止之后：") and "******" in b for b in record["stream_breaks"])
    written = "".join(p.read_text() for p in tmp_path.rglob("*") if p.is_file())
    assert fragments(PASSWORD, written) == []


def test_snapshot_on_every_connect_and_the_commit_event_before_turn_end(tmp_path: Path) -> None:
    # 真实控制面（#761、#546）：每次连上先发一条不带序号的 snapshot；一轮结束时平台提交工作区，
    # platform（commit）在 turn_end 之前。驱动原样记下，不把它们当结局，断开之后按最后一个序号
    # （seq 3）之后重连、补回 platform 和 turn_end。
    record = drive("snapshot-commit", tmp_path)
    lines = [json.loads(x) for x in (tmp_path / "platform-events.jsonl").read_text().splitlines()]
    assert [x["type"] for x in lines] == [
        "snapshot",
        "user_message",
        "turn_started",
        "assistant_message",
        "snapshot",
        "platform",
        "turn_end",
    ]
    assert "seq" not in lines[0] and "seq" not in lines[4]
    assert lines[5]["kind"] == "commit" and lines[6]["seq"] == 5
    assert [p for m, p in record["calls"] if m == "GET"][-2:] == [
        "/sessions/s1/events?after=0",
        "/sessions/s1/events?after=3",
    ]
    assert record["turn_end"]["seq"] == 5 and record["problems"] == []
    assert record["stream_breaks"] == ["事件流结束了"]
    assert classify_platform(record) is None


def test_the_text_that_marks_events_not_connected_is_in_the_control_planes_message() -> None:
    # 驱动认「事件流还没连上」的子串（`EVENTS_NOT_CONNECTED_TEXT`）：从控制面的原文里读，
    # 不在这里抄一份——
    # 控制面改了措辞，这条就红，不会悄悄把这种 503 变回平台故障。
    from platform_driver import EVENTS_NOT_CONNECTED_TEXT

    source = (
        Path(__file__).resolve().parents[3] / "apps/server/src/sessions/session-service.ts"
    ).read_text()
    found = re.search(r'EVENTS_NOT_CONNECTED_MESSAGE =\s*"([^"]+)"', source)
    assert found is not None, "session-service.ts 里找不到 EVENTS_NOT_CONNECTED_MESSAGE"
    assert EVENTS_NOT_CONNECTED_TEXT in found.group(1)
