"""本地调试时 `exec.run` 的看守进程。只用标准库（ADR 0002），不导入 sfly。

用法：`python -I -S exec_guard.py <宽限期> <状态 fd> <程序> <参数>...`。

在 Agent 上，命令由 Agent 启动，任务怎样结束（包括执行器被强制杀掉）都由 Agent 结束它的进程树。
本地调试时没有 Agent，命令由执行器启动；执行器被强制杀掉（SIGKILL）时自己来不及清理，命令又自成
一个进程组（不在执行器的进程组里），会留下孤儿。所以执行器先启动这个看守进程，由它启动命令：

- 命令自成一个进程组（一棵进程树），看守进程不在里面；
- 看守进程的标准输入是执行器那边的管道（「生命线」）：执行器关掉它（命令超时、任务被取消、
  `exec.run` 结束），或者执行器退出（包括被强制杀掉）时，看守进程读到 EOF；
- 命令退出、或者读到 EOF 时，看守进程结束命令的进程组（先 SIGTERM，宽限期过后 SIGKILL），
  在状态 fd 上写一行 JSON 后退出：`{"exit": 退出码}`（被信号终止时为负的信号值），
  启动失败时是 `{"error": "not_found" | "permission_denied" | "failed", "message": ...}`。

命令的标准输出、标准错误就是看守进程的（执行器读的管道），标准输入是 /dev/null。
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time


def main(argv: list[str]) -> int:
    grace, status, command = float(argv[1]), int(argv[2]), argv[3:]
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, start_new_session=True)
    except OSError as error:
        kind = (
            "not_found"
            if isinstance(error, FileNotFoundError)
            else "permission_denied"
            if isinstance(error, PermissionError)
            else "failed"
        )
        _report(status, {"error": kind, "message": str(error)})
        return 0
    done = threading.Event()

    def until_eof() -> None:
        while os.read(0, 4096):
            pass
        done.set()

    def until_exit() -> None:
        child.wait()
        done.set()

    threading.Thread(target=until_eof, daemon=True).start()
    threading.Thread(target=until_exit, daemon=True).start()
    done.wait()
    _end_group(child, grace)
    _report(status, {"exit": child.wait()})
    return 0


def _end_group(child: subprocess.Popen[bytes], grace: float) -> None:
    """结束命令的进程组：先 SIGTERM，等组里的进程都退出，最多等 `grace` 秒，再 SIGKILL。"""

    def signal_group(sig: int) -> bool:
        try:
            os.killpg(child.pid, sig)
        except (ProcessLookupError, PermissionError):
            return False
        return True

    if not signal_group(signal.SIGTERM):
        return
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        # 组长由等待它的线程回收；回收之前它的僵尸进程让进程组一直「活着」。
        if not signal_group(0):
            return
        time.sleep(0.02)
    signal_group(signal.SIGKILL)


def _report(status: int, message: dict[str, object]) -> None:
    try:
        os.write(status, json.dumps(message).encode("utf-8") + b"\n")
    except OSError:
        pass  # 执行器已经退出了：没人要这个结果。


if __name__ == "__main__":
    code = main(sys.argv)
    # 不等读标准输入的线程：直接退出。
    os._exit(code)
