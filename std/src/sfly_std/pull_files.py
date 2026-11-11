"""`pull_files`：把另一台 Agent 上匹配通配符的文件一次性拉到本地目录，可选拉完后删除源文件。

列出、下载、删除和输出的截断在 `_pull.py`。
用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `pull_files` 一节。
"""

from __future__ import annotations

from pathlib import Path
from typing import TypedDict

from sfly import AgentName, Context, node
from sfly_std import _pull


class PullFilesOutputs(TypedDict):
    files: list[str]
    count: int
    total_bytes: int


@node(title="拉取文件")
def pull_files(
    ctx: Context,
    source: AgentName,
    directory: str,
    local_dir: str,
    pattern: str = "*",
    recursive: bool = False,
    delete_source: bool = False,
) -> PullFilesOutputs:
    """把 Agent `source` 上目录 `directory` 下文件名匹配 `pattern` 的文件下载到本地目录 `local_dir`
    （`recursive` 时含子目录，保留子目录结构），`delete_source` 时每拉完一个就删除源文件。

    输出本地路径列表 `files`（最多 1000 个，更多时只列出前面的）、文件数 `count`、
    总字节数 `total_bytes`。
    """
    if not local_dir:
        raise ValueError("local_dir 不能为空")
    agent = ctx.agent(source)
    root = Path(local_dir).absolute()
    matched = list(agent.files.list(directory, pattern or "*", recursive=recursive))
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
