"""Agent 的统一目录 `SFLY_HOME`（默认 `~/.sfly`）与其中的配置文件 `agent.env`。

`agent.env` 的格式与 Agent 读取的规则一致（agent/src/home.rs）：每行一个 `KEY=VALUE`，
空行和 `#` 开头的行忽略，值两侧的空白去掉，整个值被一对 `"` 或 `'` 包住时去掉引号（不处理转义），
值为空视为没有设置。CLI 用到的键：
- `SFLY_CONTROL_PLANE_URL`：控制面 HTTP 地址（`sfly publish` 等）；
- `SFLY_DEV_SOCKET`：本机 Agent 的本地 socket（与 Agent 的同名配置相同）。
"""

from __future__ import annotations

import os
from pathlib import Path

ENV_FILE = "agent.env"
CONTROL_PLANE_KEY = "SFLY_CONTROL_PLANE_URL"
# Agent 的默认本地 socket：$SFLY_HOME/work/agent.sock（Agent 默认工作目录下）。
SOCKET_FILE = Path("work") / "agent.sock"


def sfly_home() -> Path:
    """`SFLY_HOME` 环境变量，否则 `~/.sfly`。"""
    return Path(os.environ.get("SFLY_HOME") or Path.home() / ".sfly")


def parse_env_file(text: str) -> dict[str, str]:
    entries: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and value:
            entries[key] = value
    return entries


def agent_env() -> dict[str, str]:
    """读取 `$SFLY_HOME/agent.env`；文件不存在或不可读时为空。"""
    try:
        text = (sfly_home() / ENV_FILE).read_text(encoding="utf-8")
    except OSError:
        return {}
    return parse_env_file(text)


def control_plane_url(server: str | None, default: str) -> str:
    """控制面 HTTP 地址：`--server` > `SFLY_SERVER` > `agent.env` 的 `SFLY_CONTROL_PLANE_URL`
    > `default`。"""
    return server or os.environ.get("SFLY_SERVER") or agent_env().get(CONTROL_PLANE_KEY) or default


def dev_socket(socket: str | None) -> Path:
    """本机 Agent 的本地 socket：`--socket` > `SFLY_DEV_SOCKET` > `agent.env` 的 `SFLY_DEV_SOCKET`
    > `$SFLY_HOME/work/agent.sock`。"""
    value = socket or os.environ.get("SFLY_DEV_SOCKET") or agent_env().get("SFLY_DEV_SOCKET")
    return Path(value) if value else sfly_home() / SOCKET_FILE
