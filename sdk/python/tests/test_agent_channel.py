"""SDK → 自己所在的 Agent 的调用通道（`sfly.capabilities.channel`，协议见 agent/src/calls/mod.rs）。

用一个假的 Agent 本地 socket（本文件里的 `FakeAgent`）代替 Agent：检查 SDK 发出的请求、
对各种回复抛出的异常、超时和取消。真实 Agent 一侧的行为见 agent/tests/calls.rs，整条链路见全栈测试。
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

import sfly
from sfly import Context, TaskInfo

SDK_SRC = Path(__file__).resolve().parents[1] / "src"
PACKAGE_SRC = Path(__file__).resolve().parents[3] / "testdata" / "agent-files-package" / "src"


def wait_for(check: Callable[[], bool], timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)


class FakeAgent:
    """假的 Agent 本地 socket：记下每个请求，按 `reply(request)` 给出的若干帧回复后关闭连接；
    `hang` 时回复之后不关闭，等调用方断开（`closed`）。"""

    def __init__(
        self,
        path: Path,
        reply: Callable[[dict[str, Any]], list[bytes]],
        *,
        hang: bool = False,
    ) -> None:
        self.path = path
        self.requests: list[dict[str, Any]] = []
        self.closed = threading.Event()
        self._reply = reply
        self._hang = hang
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(str(path))
        self._server.listen()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self._server.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn: socket.socket) -> None:
        with conn, conn.makefile("rb") as reader:
            request = json.loads(reader.readline())
            self.requests.append(request)
            for frame in self._reply(request):
                conn.sendall(frame)
            if self._hang:
                reader.read()
                self.closed.set()

    def close(self) -> None:
        self._server.close()


def frame(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False).encode("utf-8") + b"\n"


@pytest.fixture
def short_dir() -> Iterator[Path]:
    """socket 路径不能太长（AF_UNIX 108 字节），放在 TMPDIR 下的短目录里。"""
    import tempfile

    with tempfile.TemporaryDirectory(prefix="sfly-") as tmp:
        yield Path(tmp)


def context(short_dir: Path, monkeypatch: pytest.MonkeyPatch, **task: Any) -> Context:
    monkeypatch.setenv("SFLY_AGENT_SOCKET", str(short_dir / "agent.sock"))
    monkeypatch.delenv("SFLY_LOCAL_AGENTS", raising=False)
    return Context(
        events_path=None,
        cancel_path=short_dir / "cancel",
        artifacts_dir=None,
        artifacts_url=None,
        task=TaskInfo(task_id="t-1", attempt=2, **task),
    )


INFO = {
    "path": "/var/log/app.log",
    "size": 12,
    "mtime_ns": 1_700_000_000_123_456_789,
    "device": 2049,
    "inode": 77,
}


def test_calls_go_to_the_own_agent_with_the_task_target_method_and_timeout(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def reply(request: dict[str, Any]) -> list[bytes]:
        if request["method"] == "files.list":
            return [
                frame({"item": INFO}),
                frame({"item": {**INFO, "path": "/b"}}),
                frame({"result": None}),
            ]
        return [frame({"result": INFO})]

    agent = FakeAgent(short_dir / "agent.sock", reply)
    ctx = context(short_dir, monkeypatch)

    info = ctx.agent("fs-source").files.stat("/var/log/app.log", timeout=2.5)
    listed = list(ctx.agent().files.list("/var/log", "*.log", recursive=True))

    assert info == sfly.FileInfo(
        "/var/log/app.log", 12, 1_700_000_000_123_456_789, sfly.FileId(2049, 77)
    )
    assert info.mtime == pytest.approx(1_700_000_000.123456789)
    assert [f.path for f in listed] == ["/var/log/app.log", "/b"]
    assert agent.requests == [
        {
            "command": "call",
            "task_id": "t-1",
            "attempt": 2,
            "agent": "fs-source",
            "method": "files.stat",
            "args": {"path": "/var/log/app.log"},
            "timeout_ms": 2500,
        },
        {
            "command": "call",
            "task_id": "t-1",
            "attempt": 2,
            "agent": "",
            "method": "files.list",
            "args": {"directory": "/var/log", "pattern": "*.log", "recursive": True},
            "timeout_ms": 30000,
        },
    ]
    agent.close()


@pytest.mark.parametrize(
    ("kind", "error"),
    [
        ("unreachable", sfly.AgentUnreachable),
        ("unsupported", sfly.AgentUnsupported),
        ("not_found", sfly.AgentFileNotFound),
        ("permission_denied", sfly.AgentPermissionDenied),
        ("timeout", sfly.AgentTimeout),
        ("not_referenced", sfly.AgentNotReferenced),
        ("invalid", sfly.AgentError),
        ("something_new", sfly.AgentError),
    ],
)
def test_each_kind_of_failure_raises_its_own_exception(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch, kind: str, error: type[sfly.AgentError]
) -> None:
    message = f"Agent fs-source：{kind}"
    agent = FakeAgent(
        short_dir / "agent.sock",
        lambda _: [frame({"error": {"kind": kind, "message": message, "agent": "fs-source"}})],
    )
    ctx = context(short_dir, monkeypatch)

    with pytest.raises(error) as raised:
        ctx.agent("fs-source").files.stat("/x")

    assert type(raised.value) is error
    assert str(raised.value) == message
    assert raised.value.kind == kind
    assert raised.value.agent == "fs-source"
    agent.close()


def test_failures_are_also_the_matching_builtin_exceptions() -> None:
    assert issubclass(sfly.AgentFileNotFound, FileNotFoundError)
    assert issubclass(sfly.AgentPermissionDenied, PermissionError)
    assert issubclass(sfly.AgentTimeout, TimeoutError)
    assert issubclass(sfly.AgentUnreachable, ConnectionError)


def test_a_cancelled_reply_raises_cancelled(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = FakeAgent(
        short_dir / "agent.sock",
        lambda _: [frame({"error": {"kind": "cancelled", "message": "任务已取消，调用已放弃"}})],
    )
    ctx = context(short_dir, monkeypatch)

    with pytest.raises(sfly.Cancelled):
        ctx.agent("fs-source").files.stat("/x")
    # 已经取消的任务不再发起调用。
    (short_dir / "cancel").touch()
    with pytest.raises(sfly.Cancelled):
        ctx.agent("fs-source").files.stat("/x")
    assert len(agent.requests) == 1
    agent.close()


def test_a_sigterm_after_a_cancelled_reply_does_not_interrupt_the_cleanup(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """取消时 Agent 既回复 cancelled 又发 SIGTERM。回复先到时节点已经在 `except Cancelled`
    里清理，随后送达的 SIGTERM 不再抛第二次。"""
    from sfly.context import on_sigterm

    agent = FakeAgent(
        short_dir / "agent.sock",
        lambda _: [frame({"error": {"kind": "cancelled", "message": "任务已取消，调用已放弃"}})],
    )
    ctx = context(short_dir, monkeypatch)
    cleaned = False

    with pytest.raises(sfly.Cancelled, match="调用已放弃"):
        try:
            ctx.agent("fs-source").files.stat("/x")
        except sfly.Cancelled:
            on_sigterm(signal.SIGTERM, None)
            cleaned = True
            raise
    assert cleaned
    agent.close()


def test_a_sigterm_after_the_cancel_marker_stopped_a_call_does_not_interrupt_the_cleanup(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Agent 先写取消标记再发 SIGTERM：两者之间发起的调用因为标记抛出 `Cancelled`，
    SIGTERM 不再抛第二次。"""
    from sfly.context import on_sigterm

    ctx = context(short_dir, monkeypatch)
    (short_dir / "cancel").touch()
    cleaned = False

    with pytest.raises(sfly.Cancelled, match="任务已取消"):
        try:
            ctx.agent("fs-source").files.stat("/x")
        except sfly.Cancelled:
            on_sigterm(signal.SIGTERM, None)
            cleaned = True
            raise
    assert cleaned


def test_a_cancelled_reply_in_a_background_thread_leaves_sigterm_to_the_main_thread(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """后台线程里的调用收到 cancelled 回复，主线程还没有被告知取消：
    SIGTERM 照常在主线程里抛出 `Cancelled`。"""
    from sfly.context import on_sigterm

    agent = FakeAgent(
        short_dir / "agent.sock",
        lambda _: [frame({"error": {"kind": "cancelled", "message": "任务已取消，调用已放弃"}})],
    )
    ctx = context(short_dir, monkeypatch)
    raised: list[BaseException] = []

    def call() -> None:
        try:
            ctx.agent("fs-source").files.stat("/x")
        except sfly.Cancelled as error:
            raised.append(error)

    thread = threading.Thread(target=call)
    thread.start()
    thread.join(10)
    assert len(raised) == 1

    with pytest.raises(sfly.Cancelled, match="SIGTERM"):
        on_sigterm(signal.SIGTERM, None)
    # 主线程已经收到过：再来一次 SIGTERM 不再抛。
    on_sigterm(signal.SIGTERM, None)
    agent.close()


def test_an_agent_that_is_gone_is_unreachable(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx = context(short_dir, monkeypatch)

    with pytest.raises(sfly.AgentUnreachable, match="连不上本机 Agent 的本地 socket"):
        ctx.agent().files.stat("/x")

    # 回复到一半 Agent 断开。
    agent = FakeAgent(short_dir / "agent.sock", lambda _: [frame({"item": INFO})])
    with pytest.raises(sfly.AgentUnreachable, match="本机 Agent 中断了 files.list 调用"):
        list(ctx.agent().files.list("/var/log"))
    agent.close()


def test_stopping_a_listing_early_abandons_the_call(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = FakeAgent(short_dir / "agent.sock", lambda _: [frame({"item": INFO})], hang=True)
    ctx = context(short_dir, monkeypatch)

    files = ctx.agent().files.list("/var/log")
    assert next(files).path == "/var/log/app.log"
    files.close()

    assert agent.closed.wait(10)
    agent.close()


def test_an_agent_that_stops_answering_times_out(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Agent 自己负责超时；它卡住时 SDK 在 timeout 之外再多等一会儿就放弃。"""
    monkeypatch.setattr("sfly.capabilities.channel.REPLY_MARGIN", 0.2)
    agent = FakeAgent(short_dir / "agent.sock", lambda _: [], hang=True)
    ctx = context(short_dir, monkeypatch)

    with pytest.raises(sfly.AgentTimeout, match="没有回应 files.stat"):
        ctx.agent().files.stat("/x", timeout=0.1)
    assert agent.closed.wait(10)
    agent.close()


def test_data_frames_carry_raw_bytes_after_the_line(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """留给传输文件内容的方法：`{"data": N}` 一行之后紧跟 N 个原始字节（任意字节，含换行）。"""
    payload = b"line 1\n\x00\xff line 2"
    agent = FakeAgent(
        short_dir / "agent.sock",
        lambda _: [
            frame({"data": len(payload)}) + payload,
            frame({"data": 0}),
            frame({"result": 7}),
        ],
    )
    ctx = context(short_dir, monkeypatch)

    with ctx.agent()._call("files.read", {"path": "/x"}, 5.0) as call:
        frames = list(call.frames())

    assert [f.get("bytes") for f in frames] == [payload, b"", None]
    assert frames[-1]["result"] == 7
    agent.close()


def test_arguments_are_checked_before_calling(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx = context(short_dir, monkeypatch)

    with pytest.raises(ValueError, match="绝对路径"):
        ctx.agent().files.stat("relative")
    with pytest.raises(ValueError, match="timeout 必须大于 0"):
        ctx.agent().files.stat("/x", timeout=0)
    with pytest.raises(ValueError, match="Agent 名称必须是非空字符串"):
        ctx.agent("")


def test_cancelling_the_task_interrupts_a_call_that_is_waiting(short_dir: Path) -> None:
    """主线程卡在调用里时，SIGTERM（Agent 取消任务）立即让调用抛出 Cancelled。"""
    agent = FakeAgent(short_dir / "agent.sock", lambda _: [], hang=True)
    work = short_dir / "work"
    work.mkdir()
    (work / "task.json").write_text(
        json.dumps(
            {
                "task_id": "t-1",
                "attempt": 1,
                "entry": "sfly_agent_files:wait_stat",
                "inputs": {"path": "/x", "source": "fs-source"},
            }
        ),
        encoding="utf-8",
    )
    env = {k: v for k, v in os.environ.items() if not k.startswith("SFLY_")}
    env.update(
        PYTHONPATH=os.pathsep.join([str(SDK_SRC), str(PACKAGE_SRC)]),
        SFLY_TASK=str(work / "task.json"),
        SFLY_OUTPUT=str(work / "output.json"),
        SFLY_EVENTS=str(work / "events.jsonl"),
        SFLY_CANCEL=str(work / "cancel"),
        SFLY_AGENT_SOCKET=str(agent.path),
    )
    proc = subprocess.Popen([sys.executable, "-m", "sfly.runner"], cwd=work, env=env)
    try:
        wait_for(lambda: len(agent.requests) == 1)
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=10) == 1
    finally:
        proc.kill()
    output = json.loads((work / "output.json").read_text(encoding="utf-8"))
    assert output["error"]["type"] == "Cancelled"
    events = (work / "events.jsonl").read_text(encoding="utf-8")
    assert "调用被取消" in events
    # 节点进程退出时连接关闭，Agent 一侧随之放弃调用。
    assert agent.closed.wait(10)
    agent.close()


def test_a_watch_assembles_snapshots_from_batches_and_skips_keepalives(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    other = {**INFO, "path": "/var/log/app.log.1", "inode": 78}

    def reply(request: dict[str, Any]) -> list[bytes]:
        def batch(files: list[Any], *, first: bool, last: bool, missed: bool = False) -> bytes:
            snapshot = {"files": files, "first": first, "last": last, "missed": missed}
            return frame({"item": {"snapshot": snapshot}})

        return [
            batch([INFO], first=True, last=False),
            frame({"item": {"alive": True}}),
            batch([other], first=False, last=True),
            frame({"item": {"event": {"kind": "moved", "file": other, "old_path": INFO["path"]}}}),
            # 连接中断时没收完的快照：重连后的快照从 first 重新开始。
            batch([INFO], first=True, last=False, missed=True),
            batch([other], first=True, last=True, missed=True),
            frame({"item": {"event": {"kind": "deleted", "file": other, "old_path": None}}}),
            frame({"error": {"kind": "not_found", "message": "Agent a-01：被监听的目录已被删除"}}),
        ]

    agent = FakeAgent(short_dir / "agent.sock", reply)
    ctx = context(short_dir, monkeypatch)

    seen: list[Any] = []
    with pytest.raises(sfly.AgentFileNotFound):
        for item in ctx.agent("a-01").files.watch("/var/log", "app.log*", recursive=True):
            seen.append(item)
    agent.close()

    first, second = sfly.FileInfo.from_json(INFO), sfly.FileInfo.from_json(other)
    assert seen == [
        sfly.WatchSnapshot((first, second), missed=False),
        sfly.FileEvent("moved", second, old_path="/var/log/app.log"),
        sfly.WatchSnapshot((second,), missed=True),
        sfly.FileEvent("deleted", second),
    ]
    assert seen[1].path == "/var/log/app.log.1"
    assert seen[1].id == sfly.FileId(2049, 78)
    assert agent.requests[0]["method"] == "files.watch"
    assert agent.requests[0]["args"] == {
        "directory": "/var/log",
        "pattern": "app.log*",
        "recursive": True,
    }
    assert agent.requests[0]["timeout_ms"] == 30000
