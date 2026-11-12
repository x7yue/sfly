"""等待一次运行结束：订阅运行的事件流（SSE），断线后重连，节点状态每变化一次写一行进度。

事件流连上时先推送一份完整的运行视图（`run` 事件），运行或任何节点的状态变化时再推送，所以重连之后
以重连后收到的第一份视图为准：断线期间发生的变化（包括运行结束）不会丢。读事件流在后台线程里，
主线程只处理视图、检查超时，Ctrl-C 随时能打断。
"""

from __future__ import annotations

import json
import queue
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from http.client import HTTPException
from typing import IO, Any

from sfly.cli.client import ApiError, Client, segment
from sfly.cli.errors import CliError
from sfly.cli.run_summary import format_duration, last_attempt, node_label, seconds_between

# 控制面每 15 秒发一次心跳；这么久没有任何数据就认为连接已经断了。
IDLE_TIMEOUT_SECONDS = 45.0
# 重连的间隔：从第一次起逐次加倍，最长这么多秒。
RECONNECT_FIRST_SECONDS = 0.5
RECONNECT_MAX_SECONDS = 5.0
# 主线程每隔多久检查一次超时。
_POLL_SECONDS = 0.5

NODE_STATUS_TEXT = {
    "pending": "待执行",
    "queued": "排队中",
    "dispatched": "派发中",
    "running": "运行中",
    "waiting": "等待中",
    "success": "成功",
    "failed": "失败",
    "skipped": "已跳过",
    "cancelled": "已取消",
    "stopped": "已停止",
}
# 节点完成后进度行里带上耗时。
_ENDED = {"success", "failed", "cancelled", "stopped"}
# 入口节点只是链的起点，不写进度。
_PSEUDO_NODES = {"entry", "subflow_entry"}


class WaitTimeout(Exception):
    """等待超过了 `--timeout`；运行仍在继续。"""


@dataclass(frozen=True)
class SseEvent:
    name: str
    data: str


def read_events(lines: IO[bytes] | Iterator[bytes]) -> Iterator[SseEvent]:
    """解析 `text/event-stream`：空行结束一条事件；`:` 开头的是注释；多行 `data:` 用换行连接。"""
    name = "message"
    data: list[str] = []
    for raw in lines:
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        if line == "":
            if data:
                yield SseEvent(name, "\n".join(data))
            name, data = "message", []
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if field == "event":
            name = value
        elif field == "data":
            data.append(value)


class _Feed(threading.Thread):
    """订阅一次运行的事件流，把收到的视图放进队列；连接断开（读不到数据、对方关闭、控制面暂时连不上）
    时按退避的间隔重连。收到控制面明确拒绝（运行不存在……）时放入错误并结束。"""

    def __init__(self, client: Client, run_id: str, out: queue.Queue[tuple[str, Any]]) -> None:
        super().__init__(name=f"events-{run_id}", daemon=True)
        self._client = client
        self._path = f"/runs/{segment(run_id)}/events"
        self._out = out
        self._stop_requested = threading.Event()

    def stop(self) -> None:
        self._stop_requested.set()

    def run(self) -> None:
        delay = RECONNECT_FIRST_SECONDS
        disconnected = False
        while not self._stop_requested.is_set():
            reason: str
            try:
                response = self._client.open(
                    "GET",
                    self._path,
                    headers={"Accept": "text/event-stream"},
                    timeout=IDLE_TIMEOUT_SECONDS,
                )
            except ApiError as error:
                if error.status < 500:
                    self._out.put(("fatal", error))
                    return
                reason = error.message
            except CliError as error:
                reason = error.message.splitlines()[0]
            else:
                if disconnected:
                    self._out.put(("reconnected", None))
                disconnected = False
                delay = RECONNECT_FIRST_SECONDS
                reason = self._read(response)
            if self._stop_requested.is_set():
                return
            disconnected = True
            self._out.put(("disconnected", reason))
            self._stop_requested.wait(delay)
            delay = min(delay * 2, RECONNECT_MAX_SECONDS)

    def _read(self, response: Any) -> str:
        """读到连接结束，返回结束的原因。"""
        try:
            with response:
                for event in read_events(response):
                    if event.name == "run":
                        self._out.put(("run", json.loads(event.data)))
        except (OSError, HTTPException, ValueError) as error:
            return str(error) or type(error).__name__
        return "控制面关闭了连接"


class _Progress:
    """节点状态每变化一次写一行：`链:节点[#尝试] 状态 [耗时]`，例如 `main:deploy 成功 12s`。"""

    def __init__(self, write: Callable[[str], None]) -> None:
        self._write = write
        self._seen: dict[tuple[str, str], tuple[str, int]] = {}

    def update(self, run: Mapping[str, Any]) -> None:
        for chain in run["chains"]:
            for node in chain["nodes"]:
                if node["kind"] in _PSEUDO_NODES:
                    continue
                key = (chain["id"], node["node_id"])
                state = (node["status"], len(node["attempts"]))
                if state == self._seen.get(key, ("pending", 0)):
                    continue
                self._seen[key] = state
                attempt = last_attempt(node)
                line = f"{node_label(chain, node, attempt['attempt'] if attempt else None)} "
                line += NODE_STATUS_TEXT.get(node["status"], node["status"])
                if node["status"] in _ENDED and attempt:
                    seconds = seconds_between(attempt["started_at"], attempt["ended_at"])
                    if seconds is not None:
                        line += f" {format_duration(seconds)}"
                self._write(line)


def wait_for_run(
    client: Client,
    run_id: str,
    *,
    timeout: float | None,
    log: Callable[[str], None],
) -> dict[str, Any]:
    """等到运行结束，返回结束时的运行视图。节点状态每变化一次、连接断开和重连都用 `log` 写一行。
    超过 `timeout` 秒（None 是一直等）抛 `WaitTimeout`；运行不存在等控制面明确拒绝时抛 `ApiError`。
    只停止等待，不会取消运行。"""
    deadline = None if timeout is None else time.monotonic() + timeout
    events: queue.Queue[tuple[str, Any]] = queue.Queue()
    feed = _Feed(client, run_id, events)
    progress = _Progress(log)
    feed.start()
    try:
        while True:
            wait = _POLL_SECONDS
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise WaitTimeout
                wait = min(wait, remaining)
            try:
                kind, value = events.get(timeout=wait)
            except queue.Empty:
                continue
            if kind == "run":
                progress.update(value)
                if value["status"] != "running":
                    return dict(value)
            elif kind == "fatal":
                raise value
            elif kind == "disconnected":
                log(f"与控制面的连接断开（{value}），正在重连")
            elif kind == "reconnected":
                log("已重新连接")
    finally:
        feed.stop()
