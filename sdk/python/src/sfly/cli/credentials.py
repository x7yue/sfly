"""命令行的凭据文件：`sfly login` 换来的个人令牌存在 `$SFLY_HOME/credentials.json`，权限 0600。

令牌的来源，优先级从高到低：
1. 环境变量 `SFLY_API_TOKEN`（脚本、CI、自动化）。不用 `SFLY_TOKEN`：它已经是安装脚本和 `agent.env`
   里 Agent 的共享注册令牌，在同一台机器上会混；
2. 凭据文件里这台控制面的那一条（`sfly login` 写的）。

文件是 JSON：`{"version": 1, "servers": {"<控制面地址>": {...}}}`，每台控制面一条：
`token`、`token_id`、`login_name`、`name`、`saved_at`。一台机器可以同时登录几个控制面，
各存各的：`sfly login --server B` 不会覆盖 A 的令牌。`token_id` 是令牌在控制面上的 ID：
`sfly logout` 靠它让令牌吊销它自己。

令牌的原值只在这个文件和 `SFLY_API_TOKEN` 里：不写进命令行参数（进程列表和 shell 历史里看得见）、
不打印、不写进日志。文件用 0600 创建（先写临时文件再换名，任何时刻都不是别人可读的），
所在目录不存在时建出来（0700）。
"""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sfly.cli.home import sfly_home

CREDENTIALS_FILE = "credentials.json"
TOKEN_ENV = "SFLY_API_TOKEN"
_VERSION = 1


@dataclass(frozen=True)
class StoredCredential:
    """`sfly login` 存下的一条凭据。"""

    token: str
    token_id: str
    login_name: str
    name: str
    saved_at: str


@dataclass(frozen=True)
class ResolvedToken:
    """这次命令用的令牌，和它是从哪里来的。"""

    token: str
    source: str  # "env" 或 "file"
    stored: StoredCredential | None = None


def credentials_path() -> Path:
    return sfly_home() / CREDENTIALS_FILE


def _normalize(server: str) -> str:
    return server.rstrip("/")


def _read_all(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def load(server: str, path: Path | None = None) -> StoredCredential | None:
    """凭据文件里这台控制面的凭据；没有文件、文件坏了、没有这一条时为 None。"""
    servers = _read_all(path or credentials_path()).get("servers")
    entry = servers.get(_normalize(server)) if isinstance(servers, dict) else None
    if not isinstance(entry, dict):
        return None
    token, token_id = entry.get("token"), entry.get("token_id")
    if not isinstance(token, str) or not token or not isinstance(token_id, str):
        return None
    return StoredCredential(
        token=token,
        token_id=token_id,
        login_name=str(entry.get("login_name", "")),
        name=str(entry.get("name", "")),
        saved_at=str(entry.get("saved_at", "")),
    )


def save(
    server: str,
    credential: StoredCredential,
    path: Path | None = None,
) -> Path:
    """把这台控制面的凭据写进文件（别的控制面的保留）：0600，先写临时文件再换名。返回文件路径。"""
    target = path or credentials_path()
    data = _read_all(target)
    servers = data.get("servers")
    if not isinstance(servers, dict):
        servers = {}
    servers[_normalize(server)] = {
        "token": credential.token,
        "token_id": credential.token_id,
        "login_name": credential.login_name,
        "name": credential.name,
        "saved_at": credential.saved_at,
    }
    _write(target, {"version": _VERSION, "servers": servers})
    return target


def delete(server: str, path: Path | None = None) -> bool:
    """删掉这台控制面的凭据（别的保留，没有别的了就删文件）；原来有这一条返回 True。"""
    target = path or credentials_path()
    data = _read_all(target)
    servers = data.get("servers")
    if not isinstance(servers, dict) or _normalize(server) not in servers:
        return False
    del servers[_normalize(server)]
    if servers:
        _write(target, {"version": _VERSION, "servers": servers})
    else:
        target.unlink(missing_ok=True)
    return True


def _write(target: Path, data: Mapping[str, Any]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # 临时文件在同一个目录里，mkstemp 用 0600 创建；写完再换名：任何时刻文件都不是别人可读的。
    fd, tmp = tempfile.mkstemp(prefix=".credentials-", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def resolve_token(
    server: str, environ: Mapping[str, str] = os.environ, path: Path | None = None
) -> ResolvedToken | None:
    """这次命令用哪个令牌：`SFLY_API_TOKEN` 优先，其次凭据文件里这台控制面的；都没有时为 None。"""
    if token := environ.get(TOKEN_ENV, "").strip():
        return ResolvedToken(token=token, source="env")
    if stored := load(server, path):
        return ResolvedToken(token=stored.token, source="file", stored=stored)
    return None
