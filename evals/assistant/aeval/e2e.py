"""端到端（#543）：经控制面的接口把一道题交给平台的助手，跟着事件流等到这一轮结束，再判分。

要先 `./aeval.sh up --assistant`（源码构建的控制面和助手镜像）。默认用假的模型端点：它照剧本执行
这道题的参考答案，所以通过时说明这条路走得通（控制面建会话 → 助手服务拉起 pi → 工具落到工作台 →
事件回到控制面），不说明模型的能力。

一次的记录在 `<结果目录>/<题目>-<时间>/`：`events.jsonl`（事件流里收到的每个事件，含不持久的）、
`e2e.json`（会话 ID、事件顺序的检查、判分、用时）。
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Iterable, Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

from aeval import docker as d
from aeval.env import Stack
from aeval.tasks import REFERENCE_DIR, Task, stage_reference, summarize

# 发话的人：控制面把会话和它的操作记在这个昵称下（竖切的命令不带凭据，只带昵称）。
NICKNAME = "e2e"
PROJECT = "default"


def sse_events(lines: Iterable[str]) -> Iterator[dict[str, Any]]:
    """把 SSE 的行流拆成一个个事件的 data（JSON）。注释行（`:` 开头，心跳）、`event:`、`id:` 不用：
    事件的 `type` 在 data 里。"""
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


def check_sequence(events: list[dict[str, Any]]) -> list[str]:
    """持久的事件（带 `seq`）按顺序应当是：`user_message`、`turn_started`，
    之后有工具调用和它们的结果、
    助手的话，最后是 `turn_end`（`completed`）。返回不符合的地方，空表示都对。"""
    persisted = [e for e in events if "seq" in e]
    types = [str(e.get("type")) for e in persisted]
    problems: list[str] = []
    if types[:2] != ["user_message", "turn_started"]:
        problems.append(f"开头应当是 user_message、turn_started，实际是 {types[:2]}")
    if not types or types[-1] != "turn_end":
        problems.append(f"最后应当是 turn_end，实际是 {types[-1:]}")
    elif persisted[-1].get("outcome") != "completed":
        end = persisted[-1]
        problems.append(
            f"这一轮的结局是 {end.get('outcome')}（{end.get('reason')}），不是 completed"
        )
    calls: set[str] = set()
    answered: set[str] = set()
    for event in persisted:
        if event.get("type") == "tool_call":
            calls.add(str(event.get("call_id")))
        elif event.get("type") == "tool_result":
            call = str(event.get("call_id"))
            if call not in calls:
                problems.append(f"工具结果 {call} 之前没有对应的工具调用")
            answered.add(call)
    if not calls:
        problems.append("没有工具调用")
    if calls - answered:
        problems.append(f"这些工具调用没有结果：{sorted(calls - answered)}")
    if "assistant_message" not in types:
        problems.append("没有助手的话（assistant_message）")
    seqs = [int(e["seq"]) for e in persisted]
    if seqs != sorted(seqs):
        problems.append(f"事件的序号不是递增的：{seqs}")
    return problems


def _request(stack: Stack, method: str, path: str, body: Any = None) -> Any:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    request = urllib.request.Request(stack.cp_url + path, data=data, method=method)
    request.add_header("x-sfly-nickname", NICKNAME)
    if data is not None:
        request.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        raise d.DockerError(
            f"{method} {path} 返回 {error.code}：{error.read().decode(errors='replace')[:500]}"
        ) from error


def follow(stack: Stack, session_id: str, deadline: float) -> list[dict[str, Any]]:
    """跟着 `GET /sessions/:id/events`（从头补发、再接实时）收事件，到这一轮的 `turn_end` 为止。"""
    request = urllib.request.Request(
        f"{stack.cp_url}/sessions/{session_id}/events?after=0",
        headers={"accept": "text/event-stream"},
    )
    events: list[dict[str, Any]] = []
    remaining = max(deadline - time.monotonic(), 1)
    with urllib.request.urlopen(request, timeout=remaining) as response:
        lines = (raw.decode() for raw in response)
        for event in sse_events(lines):
            events.append(event)
            if event.get("type") == "turn_end" and "seq" in event:
                return events
            if time.monotonic() > deadline:
                break
    raise TimeoutError(f"会话 {session_id} 在时限内没有等到 turn_end（收到 {len(events)} 个事件）")


def run(stack: Stack, task: Task, results: Path, max_seconds: float = 900) -> int:
    if not stack.assistant:
        print("这个槽位没有助手：先 ./aeval.sh up --assistant（见 README.md「平台的助手」）")
        return 2
    if stack.internal:
        print("断网的槽位（--isolated）没有映射控制面的端口，e2e 要从宿主机访问控制面")
        return 2
    out = results / f"{task.id}-{datetime.now().strftime('%H%M%S')}"
    out.mkdir(parents=True, exist_ok=True)
    print(f"重置环境、准备题目 {task.id}（助手的模型 {stack.assistant_model}）", flush=True)
    stack.reset()
    task.seed(stack)
    if stack.assistant_model == "fake" and f"{task.id}/reference" in task.files:
        # 假的模型端点照剧本执行参考答案：只有这时参考答案才进开发环境容器。
        # 会话的工作目录是工作区 /work，
        # 参考答案要在题目的节点包目录里执行（fake_model.WORKDIR_FILE）。
        stage_reference(stack, task)
        d.sh(stack.dev, f"printf '%s' {task.workspace} > {REFERENCE_DIR}/workdir")
    started = time.monotonic()
    session = _request(stack, "POST", f"/projects/{PROJECT}/sessions", {"text": task.prompt()})
    session_id = str(session["id"])
    print(f"会话 {session_id}：等这一轮结束", flush=True)
    error = None
    events: list[dict[str, Any]] = []
    try:
        events = follow(stack, session_id, started + max_seconds)
    except (TimeoutError, OSError) as e:
        error = str(e)
    seconds = round(time.monotonic() - started, 1)
    with (out / "events.jsonl").open("w") as f:
        for event in events:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    problems = [error] if error else check_sequence(events)
    graded = summarize(task.grade(stack))
    sequence = [str(e.get("type")) for e in events if "seq" in e]
    record = {
        "task": task.id,
        "session": session_id,
        "model": stack.assistant_model,
        "seconds": seconds,
        "sequence": sequence,
        "problems": problems,
        "grade": graded,
    }
    (out / "e2e.json").write_text(json.dumps(record, ensure_ascii=False, indent=2))
    print(f"事件（持久的）：{' → '.join(sequence)}")
    for problem in problems:
        print(f"  ✗ {problem}")
    for check in graded["checks"]:
        print(f"  [{check['kind']}] {'✓' if check['passed'] else '✗'} {check['name']}")
    ok = not problems and graded["passed"] and graded["score"] == 1.0
    print(
        f"{'通过' if ok else '不通过'}：事件顺序{'对' if not problems else '不对'}，"
        f"判分 {graded['score']}，{seconds} 秒；记录在 {out}",
        flush=True,
    )
    return 0 if ok else 1
