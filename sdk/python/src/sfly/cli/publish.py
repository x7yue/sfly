"""`sfly publish`：把节点包归档上传到控制面（`POST /projects/<项目>/packages`，请求体是归档）。

和别的平台命令一样经 `Client` 发请求：有令牌（`SFLY_API_TOKEN` 或 `sfly login` 存下的）
就带 `Authorization: Bearer`（发布要「发布」范围，平台管理员往公共项目发布也要它），
401 的提示写明 `sfly login`，重定向到别的主机时不带令牌。
"""

from __future__ import annotations

import re
import tempfile
from pathlib import Path
from typing import Any

from sfly.cli.build import build, load_project
from sfly.cli.client import ApiError, Client
from sfly.cli.errors import CliError

#: 登记会话构建时序号冲突（并发登记了同一个序号）最多再试几次。
_SESSION_BUILD_ATTEMPTS = 3


class PublishError(Exception):
    pass


def publish(archive: Path, client: Client, project: str | None = None) -> dict[str, Any]:
    """上传归档，返回控制面记录的节点包版本信息（包含 sha256）。

    `project` 是发布到哪个项目（`public` 是公共项目，只有平台管理员能发布，要带他的令牌）；
    不写时是 `client.project`（默认项目，`SFLY_PROJECT` 可以改）。
    """
    try:
        body: dict[str, Any] = client.request(
            "POST",
            client.in_project("/packages", project),
            raw=archive.read_bytes(),
            headers={"Content-Type": "application/octet-stream"},
            timeout=300,
        )
    except ApiError as error:
        raise PublishError(
            f"控制面拒绝发布（HTTP {error.status} {error.code}）：{error.message}"
        ) from None
    except CliError as error:
        raise PublishError(error.message) from None
    return body


def session_build_tag(session_id: str) -> str:
    """会话构建版本号的本地标签（不含序号）：`s` 加会话 ID 去掉连字符。

    和控制面的 `sessionBuildTag` 同一个规则。
    """
    return "s" + session_id.replace("-", "").lower()


def register_session_build(root: Path, client: Client) -> dict[str, Any]:
    """构建并登记会话构建（`POST /sessions/<会话>/builds`，#795），返回控制面记下的会话构建。

    版本号是 `pyproject.toml` 的版本加 `+s<会话 ID 去掉连字符>.<序号>`，
    序号是这个会话里这个包已登记的最大序号加一；构建时覆盖版本号，不改源码。
    会话取自 `SFLY_SESSION_ID`（工作台上控制面设好）。
    """
    session = client.session_id
    if session is None:
        raise PublishError(
            "没有会话：--session-build 登记到当前会话下，"
            "会话取自 SFLY_SESSION_ID（工作台上已经设好）"
        )
    project = load_project(root)
    if "+" in project.version:
        raise PublishError(
            f"pyproject.toml 的版本号 {project.version} 已经带了本地标签："
            "会话构建的标签由命令加上，版本号写成不带 + 的基础版本"
        )
    tag = session_build_tag(session)
    pattern = re.compile(rf"^{re.escape(project.version)}\+{tag}\.(0|[1-9][0-9]*)$")
    try:
        listed = client.get(f"/sessions/{session}/builds")["builds"]
    except ApiError as error:
        raise PublishError(
            f"读不到会话的会话构建（HTTP {error.status} {error.code}）：{error.message}"
        ) from None
    seqs = [
        int(match.group(1))
        for b in listed
        if b["name"] == project.name and (match := pattern.match(b["version"]))
    ]
    seq = max(seqs, default=0) + 1
    with tempfile.TemporaryDirectory() as tmp:
        for _ in range(_SESSION_BUILD_ATTEMPTS):
            archive = build(root, Path(tmp) / str(seq), version=f"{project.version}+{tag}.{seq}")
            try:
                body: dict[str, Any] = client.request(
                    "POST",
                    f"/sessions/{session}/builds",
                    raw=archive.read_bytes(),
                    headers={"Content-Type": "application/octet-stream"},
                    timeout=300,
                )
                return body
            except ApiError as error:
                if error.code != "conflict":
                    raise PublishError(
                        f"控制面拒绝登记会话构建（HTTP {error.status} {error.code}）："
                        f"{error.message}"
                    ) from None
                seq += 1
    raise PublishError(
        f"登记会话构建时序号一直冲突（试了 {_SESSION_BUILD_ATTEMPTS} 次），再运行一次"
    )
