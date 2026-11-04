"""通用桩节点（docs/SEMANTICS.md §8）。"""

from __future__ import annotations

import os
import signal
import subprocess
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


@node(title="进程树", outputs=["pids"])
def process_tree(
    ctx: Context, pid_file: str, seconds: float = 3600, ignore_term: bool = False
) -> dict[str, Any]:
    """启动一个子进程后一起等待，把自己和子进程的 PID 写到 pid_file（超时、取消杀进程树的测试用）。

    ignore_term 时两个进程都忽略 SIGTERM，只能被强制杀掉。
    """
    prelude = "import signal, time\n"
    if ignore_term:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        prelude += "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
    child = subprocess.Popen([sys.executable, "-c", f"{prelude}time.sleep({seconds})"])
    pids = [os.getpid(), child.pid]
    tmp = f"{pid_file}.tmp"
    with open(tmp, "w") as f:
        f.write(" ".join(map(str, pids)))
    os.replace(tmp, pid_file)
    child.wait()
    return {"pids": pids}


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


@node(title="产物", outputs=["refs"])
def artifacts(
    ctx: Context, files: dict[str, str] | None = None, fail: bool = False
) -> dict[str, Any]:
    """产物测试用：把 files（名称 → 文本内容）保存为产物，返回产物引用；fail 时保存后抛出异常。"""
    refs = {name: ctx.artifacts.save(name, content) for name, content in (files or {}).items()}
    if fail:
        raise RuntimeError("保存产物后失败")
    return {"refs": refs}


@node(title="大输出", outputs=["text"])
def big(ctx: Context, size: int) -> dict[str, Any]:
    """节点输出上限测试用：返回 size 个字符的文本。"""
    return {"text": "x" * size}
