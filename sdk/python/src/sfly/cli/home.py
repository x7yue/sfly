"""Agent 的统一目录 `SFLY_HOME`（默认 `~/.sfly`）与其中的配置文件 `agent.env`。

`agent.env` 的格式与 Agent 读取的规则一致（agent/src/home.rs）：每行一个 `KEY=VALUE`，
空行和 `#` 开头的行忽略，值两侧的空白去掉，整个值被一对 `"` 或 `'` 包住时去掉引号（不处理转义），
值为空视为没有设置。CLI 用到的键：
- `SFLY_CONTROL_PLANE_URL`：控制面 HTTP 地址（`sfly publish` 等）；
- `SFLY_DEV_SOCKET`、`SFLY_WORK_DIR`：本机 Agent 的本地 socket 和工作目录（与 Agent 的同名配置相同，
  `sfly dev` 按 Agent 的规则找到它的 socket）；
- `SFLY_INDEX_URL`、`SFLY_GITHUB_RELEASE_MIRROR`、`SFLY_PYTHON_INSTALL_MIRROR`：
  本机对控制面镜像的覆盖（与 Agent 相同，`sfly init` 生成的项目用它们）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
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


def _setting(key: str, env: dict[str, str]) -> str | None:
    """与 Agent 相同：环境变量（非空）优先于 `agent.env`。"""
    return os.environ.get(key, "").strip() or env.get(key) or None


@dataclass(frozen=True)
class LocalMirrors:
    """本机对控制面镜像的覆盖（与 Agent 的 `--index-url`、`--github-release-mirror`、
    `--python-install-mirror` 同名的环境变量和 `agent.env` 键）；没有覆盖的为 None。"""

    pypi: str | None
    github_release: str | None
    python_install: str | None


def local_mirrors() -> LocalMirrors:
    """本机的镜像覆盖：环境变量 > `agent.env`。"""
    env = agent_env()
    return LocalMirrors(
        pypi=_setting("SFLY_INDEX_URL", env),
        github_release=_setting("SFLY_GITHUB_RELEASE_MIRROR", env),
        python_install=_setting("SFLY_PYTHON_INSTALL_MIRROR", env),
    )


def dev_socket(socket: str | None) -> Path:
    """本机 Agent 的本地 socket，与 Agent 的规则相同（环境变量优先于 `agent.env`）：
    `--socket` > `SFLY_DEV_SOCKET` > 工作目录 `SFLY_WORK_DIR` 下的 `agent.sock`
    > `$SFLY_HOME/work/agent.sock`。"""
    env = agent_env()

    def setting(key: str) -> str | None:
        return os.environ.get(key) or env.get(key)

    if value := socket or setting("SFLY_DEV_SOCKET"):
        return Path(value)
    if work_dir := setting("SFLY_WORK_DIR"):
        return Path(work_dir) / SOCKET_FILE.name
    return sfly_home() / SOCKET_FILE
