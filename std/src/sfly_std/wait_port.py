"""`wait_port`：等 TCP 端口可以连接。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `wait_port` 一节。
"""

from __future__ import annotations

import socket

from sfly import Context, node
from sfly_std._waiting import DEFAULT_POLL, DEFAULT_WAIT, poll_until

#: 单次连接尝试的最长时间（秒），不超过 `poll`。
CONNECT_TIMEOUT = 5.0


@node(title="等待端口")
def wait_port(
    ctx: Context,
    port: int,
    host: str = "127.0.0.1",
    wait: float = DEFAULT_WAIT,
    poll: float = DEFAULT_POLL,
) -> None:
    """每 `poll` 秒（默认 1）尝试连接一次 `host:port`（默认 `127.0.0.1`），能连上就成功；
    `wait` 秒（默认 300）内一直连不上时失败，错误信息附最后一次连接的错误。"""
    if not 0 < port < 65536:
        raise ValueError(f"port 必须在 1–65535 之间，实际为 {port}")
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
