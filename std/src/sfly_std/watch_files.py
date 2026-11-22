"""`watch_files`：持续把另一台 Agent 上符合条件的文件拉到本地目录，可选拉完后删除源文件。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `watch_files` 一节；
逻辑在辅助函数 `sfly_std.agent_files.watch_agent_files`，这里是它的节点外壳。
"""

from __future__ import annotations

from typing import Annotated, TypedDict

from sfly import AgentName, Context, Doc, node
from sfly_std.agent_files import WATCH_METRICS, watch_agent_files


class WatchFilesOutputs(TypedDict):
    count: Annotated[int, Doc("拉下来的文件数（duration 到期时才有输出）")]
    total_bytes: Annotated[int, Doc("拉下来的文件的总字节数")]


@node(title="持续拉取文件", metrics=WATCH_METRICS, primary_metric="bytes_per_s")
def watch_files(
    ctx: Context,
    source: Annotated[
        AgentName,
        Doc(
            "来源 Agent：文件在哪一台 Agent 上（「Agent」类型的参数，"
            "检查器里从已注册的 Agent 中选）"
        ),
    ],
    directory: Annotated[str, Doc("来源 Agent 所在机器上要监听的目录，绝对路径；不含子目录")],
    local_dir: Annotated[
        str,
        Doc(
            "拉到哪个本地目录：执行这个节点的 Agent 所在机器上的路径，相对路径相对于任务工作目录；"
            "不存在时自动创建"
        ),
    ],
    pattern: Annotated[str, Doc("文件名的通配符，只匹配文件名（不含目录），例如 app.log.*")] = "*",
    stable: Annotated[
        float | None, Doc("文件至少这么多秒没有修改才拉；不设置（或为 0）时一出现就拉")
    ] = None,
    delete_source: Annotated[
        bool, Doc("为 true 时每拉完一个文件就删除来源 Agent 上的这个源文件")
    ] = False,
    duration: Annotated[
        float | None,
        Doc("运行多少秒后成功结束；不设置时一直运行，直到被停止子流程节点停止或运行被取消"),
    ] = None,
) -> WatchFilesOutputs:
    """持续监听另一台 Agent 上的一个目录，把匹配通配符的文件拉到本地目录，每个文件只拉一次。

    副作用：在 local_dir 里创建文件，目录不存在时自动创建，同名的已有文件被替换。
    启动时已有的和之后出现的文件都拉；每个文件先写到临时文件，下载完成后才改名，不会留下半截文件。
    delete_source 打开时，每拉完一个文件就删除来源 Agent 上的源文件，只删拉成功的。
    一直运行到 duration 到期，或被停止子流程节点停止、运行被取消。
    被停止时记为「已停止」，不算失败，已经拉完的文件保留。
    平台不判断文件是否写完：按被测系统怎样轮转日志来选 pattern 和 stable。

    失败：第一次就连不上来源 Agent、directory 不存在或没有权限时立即失败。
    之后连接中断不失败，写一条警告日志，一直重试到连上。
    """
    result = watch_agent_files(
        ctx,
        source,
        directory,
        local_dir,
        pattern=pattern,
        stable=stable,
        delete_source=delete_source,
        duration=duration,
    )
    return {"count": result.count, "total_bytes": result.total_bytes}
