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


def publish(archive: Path, client: Client) -> dict[str, Any]:
    """上传归档，返回控制面记录的节点包版本信息（包含 sha256）。"""
    try:
        body: dict[str, Any] = client.request(
            "POST",
            "/packages",
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
