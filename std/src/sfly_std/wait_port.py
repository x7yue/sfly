"""`wait_port`：等 TCP 端口可以连接。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `wait_port` 一节。
"""

from __future__ import annotations

import socket
from typing import Annotated

from sfly import Context, Doc, node
from sfly_std import _params
from sfly_std._waiting import DEFAULT_POLL, DEFAULT_WAIT, poll_until

#: 单次连接尝试的最长时间（秒），不超过 `poll`。
CONNECT_TIMEOUT = 5.0


@node(title="等待端口")
def wait_port(
    ctx: Context,
    port: Annotated[int, Doc("端口号")],
    host: Annotated[
        str, Doc("主机名或 IP 地址，从执行节点的 Agent 所在的机器上连接")
    ] = "127.0.0.1",
    wait: Annotated[float, Doc("最多等多少秒")] = DEFAULT_WAIT,
    poll: Annotated[float, Doc("检查间隔（秒）")] = DEFAULT_POLL,
) -> None:
    """等一个 TCP 端口可以连接，用来等被测服务开始监听。

    副作用：没有，只是每隔 poll 秒尝试连接一次，连接从执行这个节点的 Agent 所在的机器发起。

    失败：wait 秒内一直连不上时失败，错误信息写明等的是哪个地址、等了多久和最后一次连接的错误。
    端口能连上只说明进程在监听，不一定已经能处理请求：
    服务有健康检查接口时改用 http_request（打开 until_ok）等它返回成功。
    """
    _params.port(port)
    target = f"{host}:{port}"
    last_error = ""

    def connect() -> bool | None:
        nonlocal last_error
        try:
            with socket.create_connection((host, port), timeout=min(CONNECT_TIMEOUT, poll)):
                return True
        except OSError as error:
            last_error = error.strerror or str(error) or type(error).__name__
            return None

    ctx.log.info("等待 %s 可以连接，最多 %g 秒", target, wait)
    _, waited = poll_until(
        connect,
        what=f"端口 {target} 可以连接",
        wait=wait,
        poll=poll,
        detail=lambda: f"最后一次连接：{last_error}" if last_error else "",
    )
    ctx.log.info("%s 已可以连接，等了 %.1f 秒", target, waited)
