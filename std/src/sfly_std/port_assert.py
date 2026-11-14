"""`port_assert`：检查一次 TCP 端口能否连接。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `port_assert` 一节。
"""

from __future__ import annotations

import socket
from typing import Annotated, TypedDict

from sfly import Doc, node
from sfly_std import _params


class PortAssertOutputs(TypedDict):
    passed: Annotated[bool, Doc("通过时为 true")]


class PortAssertionFailed(Exception):
    """端口能否连接与期望不符，或者主机名解析不到。"""


@node(title="端口断言")
def port_assert(
    port: Annotated[int, Doc("端口号")],
    host: Annotated[str, Doc("主机名或 IP 地址")] = "127.0.0.1",
    reachable: Annotated[bool, Doc("应能连接；为 false 时应不能连接（连接被拒绝或超时）")] = True,
    connect_timeout: Annotated[float, Doc("这一次连接最多等多少秒，超时算不能连接")] = 3,
) -> PortAssertOutputs:
    """尝试连接一次 TCP 端口，检查能连或不能连。只检查当下这一次，不等待、不重试。

    副作用：没有，只从执行这个节点的 Agent 发起一次连接。

    失败：检查不通过时失败，错误信息写明地址、期望与实际。
    主机名解析不到时，无论 reachable 是什么都失败：多半是主机名写错了。
    要等端口可以连接用 wait_port。
    """
    _params.port(port)
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
