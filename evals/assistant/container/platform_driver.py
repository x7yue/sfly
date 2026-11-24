"""平台臂（#552）的一次会话：经控制面的接口交给平台内的助手，跟着事件流等到这一轮结束，再结束会话。

在评测网络里的镜像站容器（`mirror`）里运行：断网的槽位（`--isolated`）不映射控制面的端口，
宿主机直接连不上控制面。
镜像站容器不是工作台，助手的命令够不着它，这个脚本和它的输出不会被助手看到。

1. `POST /projects/<项目>/sessions`，请求体是题目的那句话：建会话、开始第一轮；
2. `GET /sessions/<ID>/events?after=0`（SSE）：每个事件原样写一行到 `platform-events.jsonl`，
   等到这一轮带序号的 `turn_end`；
3. 过了时限还没等到：`POST /sessions/<ID>/stop`，再接着等一会儿结局；
4. 最后 `POST /sessions/<ID>/end`：结束会话，助手服务关掉这个会话的 pi 进程，不靠闲置回收。

标准输出上每一步一行 JSON（`created`：会话 ID，宿主机据此去助手容器里给这个会话的 pi 进程量内存；
`done`：结果）。结果也写进 `platform.json`。

只用标准库，在工作台镜像自带的 python3 里运行。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import IO, Any

# 停下之后等结局的时间：助手服务停一轮最长 23 秒（协议的 ASSISTANT_STOP_WAIT_MS），再留些余量。
STOP_WAIT_SECONDS = 40.0


class ControlPlaneError(RuntimeError):
    """控制面的接口回了错误（状态码和返回的内容在消息里），或者连不上。"""


class DeadlinePassed(Exception):
    """过了时限：在收到的每一行（含心跳）上检查，只有心跳、没有事件时也停得下来。"""


def sse_events(lines: Iterable[str]) -> Iterator[dict[str, Any]]:
    """把 SSE 的行流拆成一个个事件的 data（JSON）。注释行（心跳）、`event:`、`id:` 不用：
    类型在 data 里。"""
    data: list[str] = []
    for raw in lines:
        line = raw.rstrip("\r\n")
        if line == "":
            if data:
                yield json.loads("\n".join(data))
                data = []
            continue
        if line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
    if data:
        yield json.loads("\n".join(data))


def is_turn_end(event: dict[str, Any]) -> bool:
    """这一轮的结局：带序号的（持久的）`turn_end`。"""
    return event.get("type") == "turn_end" and "seq" in event


class Client:
    def __init__(self, base: str, nickname: str) -> None:
        self.base = base.rstrip("/")
        self.nickname = nickname

    def request(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method)
        # 鉴权（#547、#494）：现在建会话、停止、结束只要昵称（控制面不带凭据也放行）；
        # 强制鉴权之后改成用初始管理员登录、签个人令牌，带上它。
        request.add_header("x-sfly-nickname", self.nickname)
        if data is not None:
            request.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read() or b"null")
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")[:500]
            raise ControlPlaneError(f"{method} {path} 返回 {error.code}：{detail}") from error
        except OSError as error:
            raise ControlPlaneError(f"{method} {path} 连不上控制面：{error}") from error

    def follow(
        self, session_id: str, after: int, deadline: float, sink: IO[str], received: list[Any]
    ) -> str | None:
        """从序号 `after` 之后收事件（先补发、再接实时），写进 `sink`、追加到 `received`，
        到 `turn_end`
        为止。返回 None 表示等到了，否则是没等到的原因。时限在收到的每一行（含心跳的注释行）上检查，
        粒度是控制面的心跳（15 秒一次）；什么都没收到时读的超时就是剩下的时间。"""
        request = urllib.request.Request(
            f"{self.base}/sessions/{session_id}/events?after={after}",
            headers={"accept": "text/event-stream", "x-sfly-nickname": self.nickname},
        )
        try:
            remaining = max(deadline - time.monotonic(), 1)
            with urllib.request.urlopen(request, timeout=remaining) as response:

                def lines() -> Iterator[str]:
                    for raw in response:
                        if time.monotonic() > deadline:
                            raise DeadlinePassed
                        yield raw.decode()

                for event in sse_events(lines()):
                    received.append(event)
                    sink.write(json.dumps(event, ensure_ascii=False) + "\n")
                    sink.flush()
                    if is_turn_end(event):
                        return None
        except (TimeoutError, DeadlinePassed):
            return "在时限内没有等到 turn_end"
        except (OSError, ValueError) as error:
            return f"事件流断了：{error}"
        return "事件流在 turn_end 之前就结束了"


def last_seq(events: list[dict[str, Any]]) -> int:
    seqs = [int(e["seq"]) for e in events if isinstance(e.get("seq"), int)]
    return max(seqs, default=0)


def run(
    client: Client, project: str, prompt: str, max_seconds: float, out: Path, say: Any
) -> dict[str, Any]:
    started = time.monotonic()
    record: dict[str, Any] = {"session": None, "turn_end": None, "problems": [], "stopped": False}
    events: list[dict[str, Any]] = []
    out.mkdir(parents=True, exist_ok=True)
    with (out / "platform-events.jsonl").open("w") as sink:
        try:
            session = client.request("POST", f"/projects/{project}/sessions", {"text": prompt})
            created = session.get("id") if isinstance(session, dict) else None
            if not isinstance(created, str) or not created:
                raise ControlPlaneError(f"建会话的回应里没有会话 ID：{json.dumps(session)[:200]}")
            record["session"] = session_id = created
            say({"event": "created", "session": session_id})
            waited = client.follow(session_id, 0, started + max_seconds, sink, events)
            if waited is not None:
                record["problems"].append(waited)
                client.request("POST", f"/sessions/{session_id}/stop")
                record["stopped"] = True
                waited = client.follow(
                    session_id,
                    last_seq(events),
                    time.monotonic() + STOP_WAIT_SECONDS,
                    sink,
                    events,
                )
                if waited is not None:
                    record["problems"].append(f"停止之后：{waited}")
        except ControlPlaneError as error:
            record["problems"].append(str(error))
        finally:
            if record["session"]:
                try:
                    client.request("POST", f"/sessions/{record['session']}/end")
                except ControlPlaneError as error:
                    record["problems"].append(f"结束会话：{error}")
    ends = [e for e in events if is_turn_end(e)]
    record["turn_end"] = ends[-1] if ends else None
    record["seconds"] = round(time.monotonic() - started, 1)
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
