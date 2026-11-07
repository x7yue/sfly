"""`file_assert`：检查一次文件的状态（存在或不存在、大小、行数、内容）。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `file_assert` 一节。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import TypedDict

from sfly import node
from sfly_std import _params


class FileAssertOutputs(TypedDict):
    passed: bool


class FileAssertionFailed(Exception):
    """文件的状态与期望不符。"""


@node(title="文件断言")
def file_assert(
    path: str,
    exists: bool = True,
    min_size: int | None = None,
    max_size: int | None = None,
    min_lines: int | None = None,
    max_lines: int | None = None,
    matches: str | None = None,
) -> FileAssertOutputs:
    """检查一次 `path` 的状态，不等待。

    - `exists`（默认 true）：文件应存在；为 false 时应不存在，不能再给其他检查；
    - `min_size` / `max_size`：大小（字节）的下限 / 上限，含边界；
    - `min_lines` / `max_lines`：行数的下限 / 上限，含边界（最后一行没有换行符也算一行）；
    - `matches`：内容（按 UTF-8）应匹配的正则表达式，在任意位置匹配，
      多行模式（`^` `$` 匹配每一行）。

    全部通过时输出 `passed`（true）；有不通过的时失败，逐项列出期望与实际。
    """
    given = {
        "min_size": min_size,
        "max_size": max_size,
        "min_lines": min_lines,
        "max_lines": max_lines,
        "matches": matches,
    }
    given = {k: v for k, v in given.items() if v is not None}
    if not exists and given:
        raise ValueError(f"exists 为 false 时不能再给 {'、'.join(given)}")
    pattern = _params.regex("matches", matches, re.MULTILINE) if matches is not None else None
    file = Path(path)
    present = file.exists()
    if present != exists:
        expected = "应存在" if exists else "应不存在"
        actual = "实际存在" if present else "实际不存在"
        raise FileAssertionFailed(f"{path} {expected}，{actual}")

    if given and not file.is_file():
        raise FileAssertionFailed(f"{path} 不是普通文件，不能检查大小、行数和内容")
    checks: list[str | None] = []  # 每项检查：不通过时的说明，通过为 None
    if min_size is not None or max_size is not None:
        size = file.stat().st_size
        if min_size is not None:
            checks.append(
                None if size >= min_size else f"大小应 ≥ {min_size} 字节，实际是 {size} 字节"
            )
        if max_size is not None:
            checks.append(
                None if size <= max_size else f"大小应 ≤ {max_size} 字节，实际是 {size} 字节"
            )
    if min_lines is not None or max_lines is not None or pattern is not None:
        content = file.read_bytes()
        lines = content.count(b"\n") + (1 if content and not content.endswith(b"\n") else 0)
        if min_lines is not None:
            checks.append(
                None if lines >= min_lines else f"行数应 ≥ {min_lines}，实际是 {lines} 行"
            )
        if max_lines is not None:
            checks.append(
                None if lines <= max_lines else f"行数应 ≤ {max_lines}，实际是 {lines} 行"
            )
        if pattern is not None:
            text = content.decode("utf-8", errors="replace")
            checks.append(
                None
                if pattern.search(text)
                else f"内容应匹配正则 {json.dumps(matches, ensure_ascii=False)}，实际没有匹配"
            )

    failed = [c for c in checks if c is not None]
    if failed:
        listed = "\n".join(f"- {c}" for c in failed)
        raise FileAssertionFailed(
            f"{path} 的 {len(checks)} 项检查中 {len(failed)} 项不通过：\n{listed}"
        )
    return {"passed": True}
