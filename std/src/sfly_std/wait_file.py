"""`wait_file`：等文件出现，可选再等它稳定（大小和修改时间不再变化）。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `wait_file` 一节。
"""

from __future__ import annotations

import os
import stat
import time
from typing import TypedDict

from sfly import Context, node
from sfly_std._waiting import DEFAULT_POLL, DEFAULT_WAIT, poll_until


class WaitFileOutputs(TypedDict):
    size: int


@node(title="等待文件")
def wait_file(
    ctx: Context,
    path: str,
    stable: float = 0,
    wait: float = DEFAULT_WAIT,
    poll: float = DEFAULT_POLL,
) -> WaitFileOutputs:
    """每 `poll` 秒（默认 1）检查一次 `path`（相对路径相对任务工作目录），是文件就成功；
    `stable` 大于 0 时还要等文件的大小和修改时间连续 `stable` 秒不变（例如等对方写完报告）。
    `wait` 秒（默认 300）内没等到时失败。输出成功时文件的大小 `size`（字节）。"""
    if stable < 0:
        raise ValueError(f"stable 不能为负数，实际为 {stable:g}")
    # 上一次看到的 (大小, 修改时间) 和从什么时候起没再变过。
    last: tuple[int, int] | None = None
    unchanged_since = 0.0
    state = "文件不存在"

    def check() -> int | None:
        nonlocal last, unchanged_since, state
        try:
            st = os.stat(path)
        except FileNotFoundError:
            last, state = None, "文件不存在"
            return None
        if not stat.S_ISREG(st.st_mode):
            last, state = None, "路径存在但不是文件"
            return None
        now = time.monotonic()
        current = (st.st_size, st.st_mtime_ns)
        if current != last:
            last, unchanged_since = current, now
        if now - unchanged_since >= stable:
            return st.st_size
        state = "文件仍在变化"
        return None

    what = f"文件 {path} 出现" + (f"并稳定 {stable:g} 秒" if stable else "")
    ctx.log.info("等待%s，最多 %g 秒", what, wait)
    size, waited = poll_until(check, what=what, wait=wait, poll=poll, detail=lambda: state)
    ctx.log.info("文件 %s 已就绪（%d 字节），等了 %.1f 秒", path, size, waited)
    return {"size": size}
