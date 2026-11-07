"""`port_assert`：检查一次 TCP 端口能否连接。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `port_assert` 一节。
"""

from __future__ import annotations

import socket
from typing import TypedDict

from sfly import node


class PortAssertOutputs(TypedDict):
    passed: bool


class PortAssertionFailed(Exception):
    """端口能否连接与期望不符，或者主机名解析不到。"""


@node(title="端口断言")
def port_assert(
    port: int,
    host: str = "127.0.0.1",
    reachable: bool = True,
    connect_timeout: float = 3,
) -> PortAssertOutputs:
    """尝试连接一次 `host:port`（TCP），不等待、不重试。

    - `reachable`（默认 true）：应能连接；为 false 时应不能连接（连接被拒绝或超时）；
    - `connect_timeout`：这一次连接最多等多少秒（默认 3），超时算不能连接。

    主机名解析不到时无论 `reachable` 是什么都失败（多半是写错了）。通过时输出 `passed`（true）。
    """
    if not 1 <= port <= 65535:
        raise ValueError(f"port 必须在 1–65535 之间，实际为 {port}")
    if connect_timeout <= 0:
        raise ValueError(f"connect_timeout 必须大于 0，实际为 {connect_timeout}")
    try:
        socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise PortAssertionFailed(f"无法解析主机名 {host}：{error}") from None

    target = f"{host}:{port}"
    try:
        with socket.create_connection((host, port), timeout=connect_timeout):
            pass
    except TimeoutError:
        if reachable:
            raise PortAssertionFailed(
                f"{target} 应能连接，实际 {connect_timeout:g} 秒内没有连上"
            ) from None
    except OSError as error:
        if reachable:
            raise PortAssertionFailed(f"{target} 应能连接，实际连接失败：{error}") from None
    else:
        if not reachable:
            raise PortAssertionFailed(f"{target} 应不能连接，实际能连接")
    return {"passed": True}
