"""`sfly publish`：把节点包归档上传到控制面（`POST /packages`，请求体为归档原始字节）。"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from sfly.cli.client import parse_error_body


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
        parsed = parse_error_body(detail)
        if parsed:
            code, detail, _ = parsed
            status = f"{status} {code}"
        raise PublishError(f"控制面拒绝发布（{status}）：{detail}") from None
    except urllib.error.URLError as error:
        raise PublishError(f"无法连接控制面 {server}：{error.reason}") from None
