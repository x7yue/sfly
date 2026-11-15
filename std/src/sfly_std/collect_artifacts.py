"""`collect_artifacts`：按通配符把文件收集为产物。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `collect_artifacts` 一节。
"""

from __future__ import annotations

import json
import zipfile
from collections.abc import Sequence
from pathlib import Path
from typing import Annotated, TypedDict

from sfly import Context, Doc, node

#: `archive` 为 true 时打成的 zip 产物的名称。
ARCHIVE_NAME = "artifacts.zip"
#: 输出 `refs` 序列化后的最大字节数（节点输出不能超过 1 MB）；超过时不收集，提示改用 `archive`。
REFS_OUTPUT_BYTES = 512 * 1024


class CollectArtifactsOutputs(TypedDict):
    refs: Annotated[
        dict[str, str],
        Doc(
            "产物名称（相对 base_dir 的路径，/ 分隔）→ 产物引用；"
            "archive 为 true 时只有 artifacts.zip 一项；没有匹配到文件时为空对象"
        ),
    ]


class NothingCollected(Exception):
    """`required` 为 true，但一个文件都没有匹配到。"""


class TooManyRefs(Exception):
    """匹配的文件太多，`refs` 会超过输出的大小上限。"""


@node(title="收集产物")
def collect_artifacts(
    ctx: Context,
    paths: Annotated[
        Sequence[str], Doc("通配符列表，都是相对 base_dir 的路径，例如 *.log 或目录 screenshots")
    ],
    base_dir: Annotated[
        str | None, Doc("在哪个目录下匹配，通常写被测系统或前面的 shell 写结果的绝对路径")
    ] = None,
    archive: Annotated[
        bool, Doc("为 true 时把匹配到的文件打成一个 zip 产物 artifacts.zip，不再逐个保存")
    ] = False,
    required: Annotated[bool, Doc("一个文件都没匹配到时是否让节点失败")] = True,
) -> CollectArtifactsOutputs:
    """按通配符把文件保存为产物，在运行页面的节点详情里下载，也可以把产物引用交给后面的节点。

    副作用：匹配到的文件保存为产物（archive 为 true 时打成一个 zip），不改动原文件。
    产物在任务结束后由 Agent 上传到控制面，随运行一起按保留期清理。

    失败：base_dir 不存在时失败。
    一个文件都没匹配到时，required 为 true（默认）则失败，错误信息写明 base_dir 和通配符。
    匹配的文件太多、输出放不下时失败，错误信息写明文件数，改用 archive 或缩小 paths。
    通配符是绝对路径或含 .. 时失败。
    """
    _validate(paths)
    base = Path(base_dir) if base_dir is not None else Path.cwd()
    if not base.is_dir():
        raise FileNotFoundError(f"base_dir 不存在：{base}")
    # 产物目录本身（Agent 上在任务工作目录里）不收集，否则会把产物再复制进自己。
    # SDK 没有直接给出产物目录：顶层产物名称的本地路径的父目录就是它（ctx.artifacts.path 会建好）。
    own = ctx.artifacts.path(ARCHIVE_NAME).parent.resolve()
    found: set[Path] = set()
    for pattern in paths:
        for match in base.glob(pattern):
            if match.is_dir():
                found.update(p for p in match.rglob("*") if p.is_file())
            elif match.is_file():
                found.add(match)
    files = sorted(p for p in found if not p.resolve().is_relative_to(own))
    if not files and required:
        patterns = json.dumps(list(paths), ensure_ascii=False)
        raise NothingCollected(f"{base} 下没有匹配 {patterns} 的文件")
    names = {path.relative_to(base).as_posix(): path for path in files}
    archived = archive and bool(files)
    refs = (
        {ARCHIVE_NAME: ctx.artifacts.ref(ARCHIVE_NAME)}
        if archived
        else {name: ctx.artifacts.ref(name) for name in names}
    )
    refs_size = len(json.dumps(refs, ensure_ascii=False).encode())
    if refs_size > REFS_OUTPUT_BYTES:
        raise TooManyRefs(
            f"匹配到 {len(files)} 个文件，refs 共 {refs_size} 字节，超过 512 KiB 的上限"
            "（节点输出不能超过 1 MB）：用 archive=true 打成一个 zip，或缩小 paths"
        )
    size = sum(p.stat().st_size for p in files)
    ctx.log.info("从 %s 收集了 %d 个文件，共 %d 字节", base, len(files), size)
    if archived:
        with zipfile.ZipFile(ctx.artifacts.path(ARCHIVE_NAME), "w", zipfile.ZIP_DEFLATED) as zf:
            for name, path in names.items():
                zf.write(path, name)
    else:
        for name, path in names.items():
            ctx.artifacts.save(name, path)
    return {"refs": refs}


def _validate(paths: Sequence[str]) -> None:
    """通配符都要是 base_dir 内的相对路径：产物名称就是相对 base_dir 的路径。"""
    if not paths:
        raise ValueError("paths 至少要有一个通配符")
    for pattern in paths:
        if not pattern:
            raise ValueError("paths 里的通配符不能为空")
        if pattern.startswith("/"):
            raise ValueError(f"paths 里的通配符必须是相对 base_dir 的路径，实际为 {pattern!r}")
        if ".." in pattern.split("/"):
            raise ValueError(f"paths 里的通配符不能含 ..，实际为 {pattern!r}")
