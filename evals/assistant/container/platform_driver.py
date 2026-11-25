"""平台臂（#552）的一次会话：经控制面的接口交给平台内的助手，跟着事件流等到这一轮结束，再结束会话。

在评测网络里的镜像站容器（`mirror`）里运行：断网的槽位（`--isolated`）不映射控制面的端口，
宿主机直接连不上控制面。镜像站容器不是工作台，助手的命令够不着它，这个脚本和它的输出不会被助手看到。

1. **开始前的检查**：`GET /projects/<项目>/sessions` 的 `readiness`（控制面可达、助手服务连上了、
   工作台在线）。没过就不建会话：这是评测环境没准备好（环境故障），不是平台的问题。
2. `POST /projects/<项目>/sessions`，请求体是题目的那句话：建会话、开始第一轮。回应的 `status` 是
   `queued` 时记下来（每次会话前环境都重建，不该排队；排了就按时限处理，原因写明是排队）。
3. `GET /sessions/<ID>/events?after=<序号>`（SSE）：每个事件原样写一行到
   `platform-events.jsonl`（控制面每 15 秒的 `control-plane-time` 心跳不写），等到这一轮带序号的
   `turn_end`。**事件流断了**（连接出错、结束了、`READ_TIMEOUT_SECONDS` 里一个字节都没有）
   **就从最后一个序号之后重连**，到时限为止。
4. 过了时限（平台自己的上限再加 60 秒）还没等到：`POST /sessions/<ID>/stop`，再接着等
   `STOP_WAIT_SECONDS`。平台该在自己的上限上给出结局，要评测来停是平台的问题（`deadline_passed`）。
5. 不论结果如何，建了会话就 `POST /sessions/<ID>/end`：助手服务关掉这个会话的 pi 进程，
   不靠闲置回收。

读事件流有两道时限：每次读最多等 `READ_TIMEOUT_SECONDS`（心跳 15 秒一次，等不到就当断了、重连），
另有一个计时器在时限那一刻关掉连接（读不会超出时限）。意外（回应不是 JSON、SIGINT、SIGTERM……）
也走收尾：写 `platform.json`、发 `end`。

标准输出上一行 JSON（`done`：结果），结果也写进 `platform.json`。只用标准库，在工作台镜像自带的
python3 里运行。
"""

from __future__ import annotations

import argparse
import http.client
import json
import signal
import socket
import sys
import threading
import time
import urllib.parse
from collections.abc import Iterator
from pathlib import Path
from typing import IO, Any

# 停下之后等结局的时间：助手服务停一轮最长 23 秒（协议的 ASSISTANT_STOP_WAIT_MS），再留些余量。
STOP_WAIT_SECONDS = 40.0
# 读事件流时一次最多等多久没有字节就当连接断了：控制面每 15 秒写一次心跳，留三个间隔。
READ_TIMEOUT_SECONDS = 45.0
# 两次重连之间至少隔这么久（控制面重启之类的连不上时不空转）。
RECONNECT_PAUSE_SECONDS = 1.0
# 控制面的心跳事件名（`packages/schema` 的 `CONTROL_PLANE_TIME_EVENT`，
# apps/server/src/sse/sse.ts 每 15 秒发一次）：不是会话的事件，不写进记录。
HEARTBEAT_EVENT = "time"
# 记下的每个问题是哪一种（`problem_kinds`，和 `problems` 一一对应），宿主机据此归类
# （aeval/platform.py 的 `classify_platform`）：
# - `control_plane`：控制面的接口回了错误、回应不对、连不上（建会话、停止、结束）；
# - `deadline`：时限内没有等到结局；`no_outcome_after_stop`：停止之后也没有等到；
# - `evaluator`：评测自己的问题（驱动出错、写不进自己的事件记录）；`signal`：驱动被结束了。
CONTROL_PLANE = "control_plane"
DEADLINE = "deadline"
NO_OUTCOME_AFTER_STOP = "no_outcome_after_stop"
EVALUATOR = "evaluator"
SIGNAL = "signal"


def shut(sock: socket.socket | None) -> None:
    """关掉连接的两个方向：另一个线程里卡在读上的马上返回。"""
    if sock is not None:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


class ControlPlaneError(RuntimeError):
    """控制面的接口回了错误（状态码和返回的内容在消息里），回应不对，或者连不上。"""


class RecordError(Exception):
    """写不进自己的事件记录（`platform-events.jsonl`，例如磁盘满了）：评测自己的问题，不当成事件流断了。"""


class Interrupted(BaseException):
    """收到 SIGTERM（或 SIGINT）：照常收尾（写记录、发 `end`）再退出。"""


def sse_events(lines: Iterator[str]) -> Iterator[tuple[str, dict[str, Any]]]:
    """把 SSE 的行流拆成一个个事件：（事件名，data 的 JSON）。没有 `event:` 的事件名是 `message`；
    注释行、`id:`、`retry:` 不用（序号在 data 里）。"""
    data: list[str] = []
    name = "message"
    for raw in lines:
        line = raw.rstrip("\r\n")
        if line == "":
            if data:
                yield name, json.loads("\n".join(data))
            data, name = [], "message"
            continue
        if line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
        elif line.startswith("event:"):
            name = line[6:].strip()
    if data:
        yield name, json.loads("\n".join(data))


def is_turn_end(event: dict[str, Any]) -> bool:
    """这一轮的结局：带序号的（持久的）`turn_end`。控制面只发持久的 `turn_end`；看序号是为了和重连时
    「从最后一个序号之后补发」用同一个认法。"""
    return event.get("type") == "turn_end" and isinstance(event.get("seq"), int)


class Client:
    def __init__(self, base: str, nickname: str) -> None:
        parsed = urllib.parse.urlsplit(base)
        self.host = parsed.hostname or "localhost"
        self.port = parsed.port or 80
        self.nickname = nickname

    def _connection(self, timeout: float) -> http.client.HTTPConnection:
        return http.client.HTTPConnection(self.host, self.port, timeout=timeout)

    def request(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        # 鉴权（#547、#494）：现在建会话、停止、结束只要昵称（控制面不带凭据也放行）；
        # 强制鉴权之后改成用初始管理员登录、签个人令牌，带上它。
        headers = {"x-sfly-nickname": self.nickname}
        if data is not None:
            headers["content-type"] = "application/json"
        conn = self._connection(30)
        try:
            conn.request(method, path, body=data, headers=headers)
            response = conn.getresponse()
            raw = response.read()
        except (OSError, http.client.HTTPException) as error:
            raise ControlPlaneError(f"{method} {path} 连不上控制面：{error}") from error
        finally:
            conn.close()
        if response.status >= 300:
            detail = raw.decode(errors="replace")[:500]
            raise ControlPlaneError(f"{method} {path} 返回 {response.status}：{detail}")
        try:
            return json.loads(raw or b"null")
        except ValueError as error:
            text = raw.decode(errors="replace")[:200]
            raise ControlPlaneError(f"{method} {path} 的回应不是 JSON：{text}") from error

    def stream_once(
        self, session_id: str, after: int, deadline: float, sink: IO[str], received: list[Any]
    ) -> str | None:
        """连一次事件流，从序号 `after` 之后收（先补发、再接实时），到 `turn_end` 为止。
        返回 None 表示等到了，
        否则是这次断开的原因。到了 `deadline` 计时器关掉连接，读不会超出时限。"""
        # 建立连接也不超出时限：连接的超时取读的超时和剩下的时间里小的那个。
        conn = self._connection(max(min(READ_TIMEOUT_SECONDS, deadline - time.monotonic()), 0.05))

        # 计时器在建立连接之前就开始：时限那一刻关掉连接，读不会超出时限。连接要在发出请求之后
        # 记下来（事件流的响应没有长度，`getresponse` 之后 `conn.sock` 就是 None 了）；
        # 计时器先到了、连接还没建好的，建好之后马上关。
        lock = threading.Lock()
        held: list[socket.socket | None] = [None]
        expired = threading.Event()

        def cut() -> None:
            with lock:
                expired.set()
                shut(held[0])

        timer = threading.Timer(max(deadline - time.monotonic(), 0), cut)
        timer.daemon = True
        timer.start()
        try:
            conn.request(
                "GET",
                f"/sessions/{session_id}/events?after={after}",
                headers={"accept": "text/event-stream", "x-sfly-nickname": self.nickname},
            )
            with lock:
                held[0] = conn.sock
                if expired.is_set():
                    shut(held[0])
            response = conn.getresponse()
            if response.status != 200:
                return f"事件流返回 {response.status}"

            def lines() -> Iterator[str]:
                while True:
                    raw = response.readline()
                    if not raw:
                        return
                    yield raw.decode()

            for name, event in sse_events(lines()):
                if name == HEARTBEAT_EVENT:
                    continue
                received.append(event)
                try:
                    sink.write(json.dumps(event, ensure_ascii=False) + "\n")
                    sink.flush()
                except OSError as error:
                    raise RecordError(f"写不进事件记录：{error}") from error
                if is_turn_end(event):
                    return None
            return "事件流结束了"
        except TimeoutError:
            return f"事件流 {READ_TIMEOUT_SECONDS:g} 秒没有任何字节"
        except (OSError, ValueError, http.client.HTTPException) as error:
            return f"事件流断了：{error}"
        finally:
            timer.cancel()
            conn.close()

    def follow(
        self, session_id: str, deadline: float, sink: IO[str], received: list[Any]
    ) -> tuple[bool, list[str]]:
        """收事件到这一轮的 `turn_end`，断了就从最后的序号之后重连，到 `deadline` 为止。
        返回（等到了没有，每次断开的原因）。"""
        breaks: list[str] = []
        while time.monotonic() < deadline:
            why = self.stream_once(session_id, last_seq(received), deadline, sink, received)
            if why is None:
                return True, breaks
            # 到了时限是计时器关的连接，不算一次断开。
            if time.monotonic() < deadline:
                breaks.append(why)
            pause = min(RECONNECT_PAUSE_SECONDS, deadline - time.monotonic())
            if pause > 0:
                time.sleep(pause)
        return False, breaks


def last_seq(events: list[dict[str, Any]]) -> int:
    seqs = [int(e["seq"]) for e in events if isinstance(e.get("seq"), int)]
    return max(seqs, default=0)


def precheck(client: Client, project: str) -> str | None:
    """开始前的检查：控制面说助手此刻能用（助手服务连上了、工作台在线）。
    返回没过的原因，过了是 None。"""
    try:
        listing = client.request("GET", f"/projects/{project}/sessions")
    except ControlPlaneError as error:
        return str(error)
    readiness = listing.get("readiness") if isinstance(listing, dict) else None
    if not isinstance(readiness, dict):
        return f"控制面的回应里没有 readiness：{json.dumps(listing, ensure_ascii=False)[:200]}"
    if readiness.get("ready") is True:
        return None
    problems = "；".join(str(p.get("message")) for p in readiness.get("problems") or [])
    return f"助手此刻不能用：{problems or json.dumps(readiness, ensure_ascii=False)[:200]}"


def run(
    client: Client, project: str, prompt: str, max_seconds: float, out: Path, say: Any
) -> dict[str, Any]:
    """一次会话，见文件开头。`seconds` 是评测这一侧量的用时：
    从发出题目（建会话）到看到这一轮的结局，不含开始前的检查和结束会话；没等到结局时量到不再等为止。"""
    record: dict[str, Any] = {
        "precheck": None,
        "session": None,
        "queued": False,
        "turn_end": None,
        "deadline_passed": False,
        "stopped": False,
        "stream_breaks": [],
        "problems": [],
        "problem_kinds": [],
        "seconds": None,
    }

    def problem(kind: str, text: str) -> None:
        record["problems"].append(text)
        record["problem_kinds"].append(kind)

    events: list[dict[str, Any]] = []
    asked: float | None = None
    waited: float | None = None
    out.mkdir(parents=True, exist_ok=True)
    with (out / "platform-events.jsonl").open("w") as sink:
        try:
            failed = precheck(client, project)
            record["precheck"] = "ok" if failed is None else failed
            if failed is None:
                asked = time.monotonic()
                session = client.request("POST", f"/projects/{project}/sessions", {"text": prompt})
                created = session.get("id") if isinstance(session, dict) else None
                if not isinstance(created, str) or not created:
                    text = json.dumps(session, ensure_ascii=False)[:200]
                    raise ControlPlaneError(f"建会话的回应里没有会话 ID：{text}")
                record["session"] = session_id = created
                record["queued"] = session.get("status") == "queued"
                got, breaks = client.follow(session_id, asked + max_seconds, sink, events)
                waited = time.monotonic()
                record["stream_breaks"] += breaks
                if not got:
                    record["deadline_passed"] = True
                    why = "（这一轮在排队）" if record["queued"] else ""
                    problem(DEADLINE, f"在时限内没有等到 turn_end{why}")
                    record["stopped"] = True
                    client.request("POST", f"/sessions/{session_id}/stop")
                    got, breaks = client.follow(
                        session_id, time.monotonic() + STOP_WAIT_SECONDS, sink, events
                    )
                    waited = time.monotonic()
                    record["stream_breaks"] += [f"停止之后：{b}" for b in breaks]
                    if not got:
                        problem(NO_OUTCOME_AFTER_STOP, "停止之后没有等到结局")
        except ControlPlaneError as error:
            problem(CONTROL_PLANE, str(error))
        except RecordError as error:
            problem(EVALUATOR, str(error))
        except Interrupted:
            problem(SIGNAL, "会话驱动被结束了（SIGTERM、SIGINT）")
        except Exception as error:  # 意外也收尾：写记录、发 end
            problem(EVALUATOR, f"会话驱动出错：{type(error).__name__}: {error}")
        finally:
            if asked is not None:
                record["seconds"] = round((waited or time.monotonic()) - asked, 1)
            if record["session"]:
                try:
                    client.request("POST", f"/sessions/{record['session']}/end")
                except ControlPlaneError as error:
                    problem(CONTROL_PLANE, f"结束会话：{error}")
                except Interrupted:
                    problem(SIGNAL, "结束会话时会话驱动被结束了")
    ends = [e for e in events if is_turn_end(e)]
    record["turn_end"] = ends[-1] if ends else None
    (out / "platform.json").write_text(json.dumps(record, ensure_ascii=False, indent=2))
    say({"event": "done", **record})
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="平台臂的一次会话")
    parser.add_argument("--cp", default="http://sfly.internal:8080")
    parser.add_argument("--project", default="default")
    parser.add_argument("--nickname", required=True)
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--max-seconds", type=float, required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)

    def interrupt(signum: int, frame: Any) -> None:
        raise Interrupted

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)

    def say(line: dict[str, Any]) -> None:
        print(json.dumps(line, ensure_ascii=False), flush=True)

    record = run(
        Client(args.cp, args.nickname),
        args.project,
        Path(args.prompt_file).read_text(),
        args.max_seconds,
        Path(args.out),
        say,
    )
    return 0 if record["session"] else 1


if __name__ == "__main__":
    sys.exit(main())
