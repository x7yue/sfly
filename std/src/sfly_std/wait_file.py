"""`wait_file`：等文件出现，可选再等它稳定（大小和修改时间不再变化）。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `wait_file` 一节；
逻辑在辅助函数 `sfly_std.waiting.wait_for_file`，这里是它的节点外壳。
"""

from __future__ import annotations

from typing import Annotated, TypedDict

from sfly import Context, Doc, node
from sfly_std.waiting import DEFAULT_POLL, DEFAULT_WAIT, wait_for_file


class WaitFileOutputs(TypedDict):
    size: Annotated[int, Doc("成功时文件的大小（字节）")]


@node(title="等待文件")
def wait_file(
    ctx: Context,
    path: Annotated[str, Doc("文件路径；相对路径相对于任务工作目录")],
    stable: Annotated[
        float, Doc("文件出现后，还要等它的大小和修改时间连续这么多秒不变；为 0 时出现就成功")
    ] = 0,
    wait: Annotated[float, Doc("最多等多少秒")] = DEFAULT_WAIT,
    poll: Annotated[float, Doc("检查间隔（秒）")] = DEFAULT_POLL,
) -> WaitFileOutputs:
    """等一个文件出现，可以要求它保持若干秒不变，例如等对方把报告写完。

    失败：wait 秒内没等到时失败，错误信息写明当时的情况：「文件不存在」或「文件仍在变化」。
    只等普通文件：路径是目录时一直等到超时。
    """
    return {"size": wait_for_file(ctx, path, stable=stable, wait=wait, poll=poll)}
