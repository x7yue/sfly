"""骨架验收（#553）准备环境用的客户端，在这套环境的容器网络里运行，只用标准库。

登录、请求的写法复用 `scripts/release/stack_e2e.py`（它又复用评测集的 `aeval.e2e`）；
签发凭据、登记工作台、等就绪直接用那里的子命令。这里只多两件：

  accept_client.py user <登录名> <显示名>    平台管理员建一个用户，密码取环境变量 EDITOR_PASSWORD
  accept_client.py agent <Agent 名字> [秒数]  等这台 Agent 在线、环境准备好
"""

from __future__ import annotations

import os
import sys
import time

import stack_e2e
from aeval import e2e


def create_user(login: str, display: str) -> int:
    s = stack_e2e.stack()
    body = {"login_name": login, "display_name": display, "password": os.environ["EDITOR_PASSWORD"]}
    created = e2e._request(s, "POST", "/users", body)
    sys.stdout.write(str(created["id"]) + "\n")
    return 0


def wait_agent(name: str, seconds: float) -> int:
    s = stack_e2e.stack()
    deadline = time.monotonic() + seconds
    seen = "还没有连上来"
    while time.monotonic() < deadline:
        for agent in e2e._request(s, "GET", f"/projects/{stack_e2e.PROJECT}/agents")["agents"]:
            if agent.get("name") == name:
                seen = f"状态 {agent.get('status')}，准备环境 {agent.get('preparing_since')}"
                if agent.get("status") == "online" and not agent.get("preparing_since"):
                    print(f"Agent {name} 在线")
                    return 0
        time.sleep(2)
    print(f"{seconds:.0f} 秒内 Agent {name} 没有准备好：{seen}", file=sys.stderr)
    return 1


def main(argv: list[str]) -> int:
    if len(argv) == 4 and argv[1] == "user":
        return create_user(argv[2], argv[3])
    if len(argv) in (3, 4) and argv[1] == "agent":
        return wait_agent(argv[2], float(argv[3]) if len(argv) > 3 else 600)
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
