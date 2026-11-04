"""`sfly publish`：把节点包归档上传到控制面（`POST /packages`，请求体为归档原始字节）。"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


class PublishError(Exception):
    pass


def publish(archive: Path, server: str) -> dict[str, Any]:
    """上传归档，返回控制面记录的节点包版本信息（包含 sha256）。"""
    request = urllib.request.Request(
        f"{server.rstrip('/')}/packages",
        data=archive.read_bytes(),
        method="POST",
        headers={"Content-Type": "application/octet-stream", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            body: dict[str, Any] = json.loads(response.read())
            return body
    except urllib.error.HTTPError as error:
        status = f"HTTP {error.code}"
        detail = error.read().decode("utf-8", "replace")
        parsed = _parse_error(detail)
        if parsed:
            code, detail = parsed
            status = f"{status} {code}"
        raise PublishError(f"控制面拒绝发布（{status}）：{detail}") from None
    except urllib.error.URLError as error:
        raise PublishError(f"无法连接控制面 {server}：{error.reason}") from None


def _parse_error(body: str) -> tuple[str, str] | None:
    """解析控制面的错误响应 `{ error: { code, message, details? } }`；不是这个格式时返回 None。"""
    try:
        error = json.loads(body).get("error")
    except (ValueError, AttributeError):
        return None
    if not isinstance(error, dict):
        return None
    code, message = error.get("code"), error.get("message")
    if not isinstance(code, str) or not isinstance(message, str):
        return None
    return code, message
