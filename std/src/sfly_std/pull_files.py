"""`pull_files`：把另一台 Agent 上匹配通配符的文件一次性拉到本地目录，可选拉完后删除源文件。

列出、下载、删除和输出的截断在 `_pull.py`。
用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `pull_files` 一节。
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, TypedDict

from sfly import AgentName, Context, Doc, node
from sfly_std import _pull


class PullFilesOutputs(TypedDict):
    files: Annotated[
        list[str],
        Doc(
            "拉下来的文件的本地绝对路径，按拉取的顺序；最多列出 1000 个（序列化后最多 256 KiB），"
            "更多时只列出前面的，以 count 为准"
        ),
    ]
    count: Annotated[int, Doc("拉下来的文件数")]
    total_bytes: Annotated[int, Doc("拉下来的文件的总字节数")]


@node(title="拉取文件")
def pull_files(
    ctx: Context,
    source: Annotated[
        AgentName,
        Doc(
            "来源 Agent：文件在哪一台 Agent 上（「Agent」类型的参数，"
            "检查器里从已注册的 Agent 中选）"
        ),
    ],
    directory: Annotated[str, Doc("来源 Agent 所在机器上的目录，绝对路径")],
    local_dir: Annotated[
        str,
        Doc(
            "拉到哪个本地目录：执行这个节点的 Agent 所在机器上的路径，相对路径相对于任务工作目录；"
            "不存在时自动创建"
        ),
    ],
    pattern: Annotated[str, Doc("文件名的通配符，只匹配文件名（不含目录），例如 app.log.*")] = "*",
    recursive: Annotated[
        bool, Doc("为 true 时也拉取子目录里匹配的文件，在 local_dir 下保留子目录结构")
    ] = False,
    delete_source: Annotated[
        bool, Doc("为 true 时每拉完一个文件就删除来源 Agent 上的这个源文件")
    ] = False,
) -> PullFilesOutputs:
    """把另一台 Agent 上某个目录下匹配通配符的文件一次性拉到本地目录，可以拉完后删除源文件。

    副作用：在 local_dir 里创建文件，目录不存在时自动创建，同名的已有文件被替换。
    每个文件先写到临时文件，下载完成、核对大小后才改名，不会留下半截文件，已经拉完的文件保留。
    delete_source 打开时，每拉完一个文件就删除来源 Agent 上的这个源文件，只删下载成功的。

    失败：directory 不存在、不是目录或没有权限时失败。
    某个文件下载失败时立即失败，错误信息写明是哪个文件，之后的不再拉取。
    文件在下载期间被改写、截短或大小变了（还在写入）时，下载失败。
    没有匹配的文件时不失败，输出的 count 为 0。
    """
    if not local_dir:
        raise ValueError("local_dir 不能为空")
    agent = ctx.agent(source)
    root = Path(local_dir).absolute()
    matched = list(agent.files.list(directory, pattern, recursive=recursive))
    total = sum(f.size for f in matched)
    found = f"Agent {source} 的 {directory} 下有 {len(matched)} 个文件匹配 {pattern}"
    ctx.log.info("%s，共 %d 字节，拉到 %s", found, total, root)
    pulled: list[Path] = []
    done = 0
    for index, file in enumerate(matched, 1):
        message = f"第 {index}/{len(matched)} 个文件：{file.path}"
        target = _pull.local_path(directory, file.path, root)

        def report(
            n: int, _size: int, base: int = done, of: int = total, text: str = message
        ) -> None:
            ctx.progress(base + n, of, text)

        try:
            got = _pull.download(agent, file, target, report)
        except Exception:
            ctx.log.error("拉取 %s 失败，之前已经拉取了 %d 个文件", file.path, len(pulled))
            raise
        if got is None:
            ctx.log.warning("%s 在列出之后被删除，跳过", file.path)
            total -= file.size
            continue
        done += got.size
        total += got.size - file.size
        pulled.append(target)
        ctx.progress(done, total, message)
        if delete_source and _pull.delete_pulled(agent, got) == "changed":
            ctx.log.warning("%s 在下载之后被改动或替换，没有删除", file.path)
    ctx.log.info("拉取了 %d 个文件，共 %d 字节", len(pulled), done)
    return {"files": _pull.listed(pulled), "count": len(pulled), "total_bytes": done}
