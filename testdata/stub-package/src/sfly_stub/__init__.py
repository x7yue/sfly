"""通用桩节点（docs/SEMANTICS.md §8）。"""

from __future__ import annotations

import os
import sys
import time
from typing import Any

from sfly import Context, node


@node(title="回显", outputs=["text"])
def echo(ctx: Context, text: str) -> dict[str, Any]:
    return {"text": text}


@node(title="失败", outputs=[])
def fail(ctx: Context, message: str = "stub failure") -> dict[str, Any]:
    raise RuntimeError(message)


@node(title="等待", outputs=["slept"])
def sleep(ctx: Context, seconds: float) -> dict[str, Any]:
    time.sleep(seconds)
    return {"slept": seconds}


@node(title="环境探针", outputs=["prefix", "cwd", "env"])
def probe(ctx: Context) -> dict[str, Any]:
    """报告执行环境：解释器所在 venv、工作目录、相关环境变量。"""
    names = ["SFLY_TASK", "SFLY_OUTPUT", "SFLY_ARTIFACTS", "SFLY_EVENTS", "SFLY_CANCEL"]
    names += ["PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"]
    return {
        "prefix": sys.prefix,
        "cwd": os.getcwd(),
        "env": {name: os.environ.get(name) for name in names},
    }
