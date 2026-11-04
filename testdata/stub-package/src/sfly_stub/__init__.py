"""通用桩节点（docs/SEMANTICS.md §8）。"""

from __future__ import annotations

import os
import sys
import time
from importlib import metadata
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


@node(title="版本", outputs=["package", "version"])
def about(ctx: Context) -> dict[str, Any]:
    """报告当前生效的节点包名与版本（安装与版本切换测试用；同一份源码可换包名和版本构建）。"""
    dist = metadata.distribution(__name__)
    return {"package": dist.metadata["Name"], "version": dist.version}


@node(title="多路日志", outputs=[])
def chatter(
    ctx: Context, steps: int = 0, interval: float = 0.0, secret: str = ""
) -> dict[str, Any]:
    """日志与进度测试用：print、标准错误、子进程输出、各级别 SDK 日志，然后按步上报进度。"""
    import subprocess

    print("来自 print")
    print("来自标准错误", file=sys.stderr)
    subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; print('来自子进程'); print('子进程错误', file=sys.stderr)",
        ],
        check=True,
    )
    ctx.log.debug("sdk 调试")
    ctx.log.info("sdk 信息 %d", 1)
    ctx.log.warning("sdk 警告")
    ctx.log.error("sdk 错误")
    if secret:
        print(f"token={secret}; again {secret}")
    for i in range(steps):
        ctx.progress(i + 1, steps, f"第 {i + 1} 步")
        time.sleep(interval)
    return {}
