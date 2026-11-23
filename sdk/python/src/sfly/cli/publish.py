"""`sfly publish`：把节点包归档上传到控制面（`POST /packages`，请求体为归档原始字节）。

和别的平台命令一样经 `Client` 发请求：有令牌（`SFLY_API_TOKEN` 或 `sfly login` 存下的）
就带 `Authorization: Bearer`（发布要「发布」范围，平台管理员往公共项目发布也要它），
401 的提示写明 `sfly login`，重定向到别的主机时不带令牌。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sfly.cli.client import ApiError, Client
from sfly.cli.errors import CliError


class PublishError(Exception):
    pass


def publish(archive: Path, client: Client, project: str | None = None) -> dict[str, Any]:
    """上传归档，返回控制面记录的节点包版本信息（包含 sha256）。

    `project` 是发布到哪个项目：现在只能写 `public`（公共项目，只有平台管理员能这样做，
    要带他的令牌），不写发布到默认项目；写别的值时控制面返回 400，信息写明现在只能写 public。
    这是过渡的查询参数，路径带项目（#488）之后改成路径里的项目。
    """
    try:
        body: dict[str, Any] = client.request(
            "POST",
            "/packages",
            query={"project": project} if project is not None else None,
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
