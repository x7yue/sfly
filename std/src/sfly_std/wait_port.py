"""`wait_port`：等 TCP 端口可以连接。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `wait_port` 一节；
逻辑在辅助函数 `sfly_std.waiting.wait_for_port`，这里是它的节点外壳。
"""

from __future__ import annotations

from typing import Annotated

from sfly import Context, Doc, node
from sfly_std.waiting import DEFAULT_POLL, DEFAULT_WAIT, wait_for_port


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

    失败：wait 秒内一直连不上时失败，错误信息写明等的是哪个地址、等了多久和最后一次连接的错误。
    端口能连上只说明进程在监听，不一定已经能处理请求：
    服务有健康检查接口时改用 http_request（打开 until_ok）等它返回成功。
    """
    wait_for_port(ctx, port, host=host, wait=wait, poll=poll)
