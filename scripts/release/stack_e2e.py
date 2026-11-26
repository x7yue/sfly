"""整套（控制面 + 助手 + 工作台）冒烟的客户端（scripts/release/offline-stack.sh，#549）。

在这套环境的容器网络里运行（断网的网络不映射端口，宿主机连不上控制面），只用标准库。
会话的那一半复用评测集（#543）的函数：`aeval.e2e` 的登录、事件流的跟随、持久事件的读取和
`check_sequence`（事件顺序的检查），评测集目录由 offline-stack.sh 以只读挂在 `/aeval`，
`PYTHONPATH` 指向它。不改评测集的任何东西。

用法（环境变量：CP_URL 控制面的地址，ADMIN_LOGIN、ADMIN_PASSWORD 初始管理员）：
  stack_e2e.py credential <Agent 名字>   登录，给这台 Agent 签发 Agent 凭据，原值只写到标准输出一行
  stack_e2e.py ready [秒数]              等控制面说助手可以用（助手服务连得上、工作台在线、
                                         能力端口有地址）
  stack_e2e.py session <剧本> [--results]  用假的模型端点的剧本（`AEVAL-SCRIPT:<名字>`）建一个会话，
                                         跟到这一轮结束，检查持久事件的顺序；通过时退出码 0；
                                         --results 把每个工具的结果也打印出来
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any

from aeval import e2e
from aeval.env import ADMIN_LOGIN, Stack

PROJECT = "default"


class RemoteStack(Stack):
    """`aeval.e2e` 的函数只用 `cp_url` 和初始管理员的密码：
    这里控制面在容器网络里，不在宿主机的端口上。"""

    @property
    def cp_url(self) -> str:
        return os.environ["CP_URL"]


def stack() -> RemoteStack:
    # 初始管理员的登录名在评测集里是固定的（aeval_admin），offline-stack.sh 照它建。
    assert os.environ["ADMIN_LOGIN"] == ADMIN_LOGIN, (
        "ADMIN_LOGIN 要和评测集里的初始管理员登录名一致"
    )
    return RemoteStack(admin_password=os.environ["ADMIN_PASSWORD"])


def issue_credential(name: str) -> int:
    """签发 Agent 凭据要登录（管理员）：和评测环境给 Agent 签发凭据是同一个接口。
    凭据只写到标准输出。"""
    s = stack()
    request = urllib.request.Request(
        f"{s.cp_url}/agents/{name}/credentials", data=b"{}", method="POST"
    )
    request.add_header("content-type", "application/json")
    request.add_header("cookie", e2e.login_cookie(s))
    request.add_header("sec-fetch-site", "same-origin")
    with urllib.request.urlopen(request, timeout=30) as response:
        issued = json.loads(response.read())
    sys.stdout.write(str(issued["token"]) + "\n")
    return 0


def wait_ready(seconds: float) -> int:
    s = stack()
    deadline = time.monotonic() + seconds
    problems = "读不到控制面的就绪状态"
    while time.monotonic() < deadline:
        try:
            page = e2e._request(s, "GET", f"/projects/{PROJECT}/sessions")
            readiness: dict[str, Any] = page.get("readiness") or {}
            if readiness.get("ready"):
                print("就绪：助手服务连得上、工作台在线、能力端口有地址")
                return 0
            problems = "；".join(str(p.get("message")) for p in readiness.get("problems") or [])
        except e2e.ControlPlaneError as error:
            problems = str(error)
        time.sleep(2)
    print(f"{seconds:.0f} 秒内助手没有就绪：{problems}", file=sys.stderr)
    return 1


def run_session(script: str, show_results: bool = False) -> int:
    """建会话 → 跟事件流到这一轮结束 → 读控制面存下的持久事件，检查顺序
    （和 `aeval e2e` 同一份检查）。"""
    s = stack()
    started = time.monotonic()
    problems: list[str] = []
    persisted: list[dict[str, Any]] = []
    try:
        text = f"AEVAL-SCRIPT:{script} 请照剧本做。"
        session = e2e._request(s, "POST", f"/projects/{PROJECT}/sessions", {"text": text})
        session_id = str(session["id"])
        print(f"会话 {session_id}：等这一轮结束", flush=True)
        events, waited = e2e.follow(s, session_id, started + 300)
        if waited:
            problems.append(waited)
            e2e.stop(s, session_id)
        else:
            persisted = e2e.persisted_events(s, session_id)
            problems += e2e.check_sequence(persisted)
    except e2e.ControlPlaneError as error:
        problems.append(str(error))
    sequence = " → ".join(str(e.get("type")) for e in persisted)
    print(f"事件（持久的）：{sequence}")
    # 工具的结果（已经打过码）：调用的一方按需检查里面的内容，
    # 每条一行 `结果 <序号>：…`，换行换成 `⏎`；剧本名后面加 `--results` 才打印。
    for event in persisted if show_results else []:
        if event.get("type") == "tool_result":
            text = str(event.get("text", "")).replace("\n", "⏎")
            print(f"结果 {event.get('seq')}：{text[:1500]}")
    for problem in problems:
        print(f"  ✗ {problem}")
    if problems:
        # 出了问题时把助手的话和用时也写出来（假的模型端点认不出剧本时说的话在这里）。
        for event in persisted:
            if event.get("type") == "assistant_message":
                text = str(event.get("text", "")).replace("\n", "⏎")
                print(f"  助手说（序号 {event.get('seq')}）：{text[:300]}")
    print(
        f"{'通过' if not problems else '不通过'}：事件顺序{'对' if not problems else '不对'}，"
        f"{time.monotonic() - started:.1f} 秒"
    )
    return 0 if not problems else 1


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else ""
    if command == "credential" and len(argv) == 3:
        return issue_credential(argv[2])
    if command == "ready":
        return wait_ready(float(argv[2]) if len(argv) > 2 else 180)
    if command == "session" and len(argv) in (3, 4):
        return run_session(argv[2], show_results=argv[3:] == ["--results"])
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
