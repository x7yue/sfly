"""端到端（#543）：经控制面的接口把一道题交给平台的助手，跟着事件流等到这一轮结束，再判分。

要先 `./aeval.sh up --assistant`（源码构建的控制面和助手镜像）。默认用假的模型端点：它照剧本执行
这道题的参考答案，所以通过时说明这条路走得通（控制面建会话 → 助手服务拉起 pi → 工具落到工作台 →
事件回到控制面），不说明模型的能力。

一次的记录在 `<结果目录>/<题目>-<时间>/`：`events.jsonl`（事件流里收到的每个事件，含不持久的；
超时、断开时是到那时为止收到的）、`persisted.json`（这一轮结束后从控制面读回的持久事件）、
`e2e.json`（会话 ID、事件顺序的检查、判分、用时）。
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from collections.abc import Iterable, Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

from aeval import docker as d
from aeval.env import ADMIN_LOGIN, Stack
from aeval.tasks import REFERENCE_DIR, Task, stage_reference, summarize

# 发话的人：控制面把会话和它的操作记在这个昵称下（别的会话接口在 #494 之前不带凭据、只带昵称）。
# 建会话只认用户的凭据（#547）：用初始管理员登录，见 `login_cookie`。
NICKNAME = "e2e"
PROJECT = "default"


class ControlPlaneError(RuntimeError):
    """控制面的接口回了错误（状态码和错误码在消息里），或者连不上。"""


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


def check_sequence(persisted: list[dict[str, Any]]) -> list[str]:
    """一轮的持久事件按顺序应当是：`user_message`、`turn_started`，之后是工具调用和各自的结果，
    再是助手的话，最后是 `turn_end`（`completed`），之后没有别的；序号从 1 起、不跳号。
    返回不符合的地方，空表示都对。"""
    types = [str(e.get("type")) for e in persisted]
    problems: list[str] = []
    seqs = [e.get("seq") for e in persisted]
    if seqs != list(range(1, len(persisted) + 1)):
        problems.append(f"持久事件的序号应当从 1 起、不跳号，实际是 {seqs}")
    if types[:2] != ["user_message", "turn_started"]:
        problems.append(f"开头应当是 user_message、turn_started，实际是 {types[:2]}")
    for kind in ("user_message", "turn_started", "turn_end"):
        if types.count(kind) > 1:
            problems.append(f"{kind} 出现了 {types.count(kind)} 次，一轮只该有一次")
    if "turn_end" not in types:
        problems.append("没有 turn_end")
    else:
        end_at = types.index("turn_end")
        end = persisted[end_at]
        if end.get("outcome") != "completed":
            problems.append(
                f"这一轮的结局是 {end.get('outcome')}（{end.get('reason')}），不是 completed"
            )
        if end_at != len(types) - 1:
            problems.append(f"turn_end 之后还有事件：{types[end_at + 1 :]}")
    calls: list[str] = []
    answered: list[str] = []
    for event in persisted:
        if event.get("type") == "tool_call":
            calls.append(str(event.get("call_id")))
        elif event.get("type") == "tool_result":
            call = str(event.get("call_id"))
            if call not in calls:
                problems.append(f"工具结果 {call} 之前没有对应的工具调用")
            elif call in answered:
                problems.append(f"工具调用 {call} 有 {answered.count(call) + 1} 个结果，只该有一个")
            answered.append(call)
    if not calls:
        problems.append("没有工具调用")
    if set(calls) - set(answered):
        problems.append(f"这些工具调用没有结果：{sorted(set(calls) - set(answered))}")
    last_tool = max(
        (i for i, t in enumerate(types) if t in ("tool_call", "tool_result")), default=-1
    )
    if "assistant_message" not in types[last_tool + 1 :]:
        problems.append("工具调用和结果之后没有助手的话（assistant_message）")
    return problems


def login_cookie(stack: Stack) -> str:
    """初始管理员登录（建会话只认用户的凭据，#547），返回 `sfly_login=…`（Cookie 的内容）。
    密码是控制面这一次建库时随机生成的（`stack.admin_password`，reset 之后就有）；
    会话记在这个用户名下，会话令牌代他干活。"""
    if not stack.admin_password:
        raise ControlPlaneError(
            "不知道初始管理员的密码：控制面不是这一次进程起的（先 stack.reset()）"
        )
    data = json.dumps({"login_name": ADMIN_LOGIN, "password": stack.admin_password}).encode()
    request = urllib.request.Request(stack.cp_url + "/auth/login", data=data, method="POST")
    request.add_header("content-type", "application/json")
    # 登录 Cookie 只对同源的请求有效（和控制台页面自己发的请求一样）。
    request.add_header("sec-fetch-site", "same-origin")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            cookies = response.headers.get_all("set-cookie") or []
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:500]
        raise ControlPlaneError(f"管理员登录返回 {error.code}：{detail}") from error
    except OSError as error:
        raise ControlPlaneError(f"管理员登录连不上控制面：{error}") from error
    for cookie in cookies:
        match = re.match(r"(sfly_login=[^;\s]+)", cookie)
        if match:
            return match.group(1)
    raise ControlPlaneError("管理员登录没有拿到登录 Cookie")


def _request(stack: Stack, method: str, path: str, body: Any = None) -> Any:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    request = urllib.request.Request(stack.cp_url + path, data=data, method=method)
    request.add_header("x-sfly-nickname", NICKNAME)
    request.add_header("cookie", login_cookie(stack))
    request.add_header("sec-fetch-site", "same-origin")
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
    stack: Stack, session_id: str, deadline: float
) -> tuple[list[dict[str, Any]], str | None]:
    """跟着 `GET /sessions/:id/events`（从头补发、再接实时）收事件，到这一轮的 `turn_end` 为止。
    返回收到的事件，和没等到时的原因（过了时限、事件流提前结束、断开）：没等到时已经收到的事件也带回来。

    时限的粒度是控制面的心跳（15 秒一次）：没有事件时最多晚这么久才发现过了时限。"""
    request = urllib.request.Request(
        f"{stack.cp_url}/sessions/{session_id}/events?after=0",
        headers={"accept": "text/event-stream"},
    )
    events: list[dict[str, Any]] = []
    try:
        remaining = max(deadline - time.monotonic(), 1)
        with urllib.request.urlopen(request, timeout=remaining) as response:
            lines = (raw.decode() for raw in response)
            for event in sse_events(lines):
                events.append(event)
                if event.get("type") == "turn_end" and "seq" in event:
                    return events, None
                if time.monotonic() > deadline:
                    return events, f"在时限内没有等到 turn_end（收到 {len(events)} 个事件）"
    except TimeoutError:
        # 读的时候等满了剩下的时间：没有事件，也没有心跳。
        return events, f"在时限内没有等到 turn_end（收到 {len(events)} 个事件）"
    except (OSError, ValueError) as error:
        return events, f"事件流断了（收到 {len(events)} 个事件）：{error}"
    return events, f"事件流在 turn_end 之前就结束了（收到 {len(events)} 个事件）"


def persisted_events(stack: Stack, session_id: str) -> list[dict[str, Any]]:
    """控制面存下的这个会话的全部持久事件（`GET /sessions/:id`，往前翻页），按序号升序。"""
    events: list[dict[str, Any]] = []
    before = ""
    while True:
        page = _request(stack, "GET", f"/sessions/{session_id}{before}")
        events = list(page.get("events") or []) + events
        if not page.get("has_more") or not events:
            return events
        before = f"?before={events[0]['seq']}"


def stop(stack: Stack, session_id: str) -> None:
    """没等到结局时停掉这个会话正在做的一轮：不让它一直跑到下一次 reset。"""
    try:
        _request(stack, "POST", f"/sessions/{session_id}/stop")
    except ControlPlaneError as error:
        print(f"停不掉会话 {session_id}：{error}", flush=True)


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
    record: dict[str, Any] = {"task": task.id, "model": stack.assistant_model, "session": None}
    started = time.monotonic()
    events: list[dict[str, Any]] = []
    persisted: list[dict[str, Any]] = []
    problems: list[str] = []
    try:
        session = _request(stack, "POST", f"/projects/{PROJECT}/sessions", {"text": task.prompt()})
        record["session"] = session_id = str(session["id"])
        print(f"会话 {session_id}：等这一轮结束", flush=True)
        events, waited = follow(stack, session_id, started + max_seconds)
        if waited:
            problems.append(waited)
            stop(stack, session_id)
        else:
            # 对控制面存下的持久事件做检查：事件流在 turn_end 就停了，之后再来的事件、跳号都看得到。
            persisted = persisted_events(stack, session_id)
            problems += check_sequence(persisted)
    except ControlPlaneError as error:
        problems.append(str(error))
    record["seconds"] = round(time.monotonic() - started, 1)
    with (out / "events.jsonl").open("w") as f:
        for event in events:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    (out / "persisted.json").write_text(json.dumps(persisted, ensure_ascii=False, indent=2))
    graded = summarize(task.grade(stack))
    shown = persisted or [e for e in events if "seq" in e]
    record.update(
        {"sequence": [str(e.get("type")) for e in shown], "problems": problems, "grade": graded}
    )
    (out / "e2e.json").write_text(json.dumps(record, ensure_ascii=False, indent=2))
    return report(record, out)


def report(record: dict[str, Any], out: Path) -> int:
    """打印这一次的结果；事件顺序对、判分满分才是 0。"""
    graded = record["grade"]
    print(f"事件（持久的）：{' → '.join(record['sequence'])}")
    for problem in record["problems"]:
        print(f"  ✗ {problem}")
    for check in graded["checks"]:
        print(f"  [{check['kind']}] {'✓' if check['passed'] else '✗'} {check['name']}")
    ok = not record["problems"] and graded["passed"] and graded["score"] == 1.0
    print(
        f"{'通过' if ok else '不通过'}：事件顺序{'对' if not record['problems'] else '不对'}，"
        f"判分 {graded['score']}，{record['seconds']} 秒；记录在 {out}",
        flush=True,
    )
    return 0 if ok else 1
