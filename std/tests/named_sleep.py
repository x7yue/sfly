"""测试用的「名字独特」的进程：进程名、命令行都能被 `name` / `match` 准确匹配到。

    python named_sleep.py <进程名> <秒数>

作为脚本运行时，把进程名改成 <进程名>，睡 <秒数> 秒后退出。进程名就是 `/proc/<pid>/comm`
（psutil 的 `name()`、ps 的 COMM），这里直接写 `/proc/self/comm` 修改，与可执行文件名无关。
不能用「把 sleep 复制或链接成别的名字」的做法：uutils coreutils（新版 Ubuntu 的默认实现）是多合一的
可执行文件，执行的文件名不是工具名时拒绝运行（`Security violation: Requested utility ...`）。
环境变量 `NAMED_SLEEP_COPIES=N`（默认 1）：改名后再 fork 出 N-1 个同名、同命令行的进程一起睡。

测试里用 `named_sleep` fixture（`NamedSleep`）启动它：测试文件
`from named_sleep import NamedSleep, named_sleep_fixture`。fixture 不放 conftest.py：
sdk/python/tests 已有 conftest.py，mypy 会报两个同名的 `conftest` 模块。
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import psutil
import pytest

#: psutil 对 15 个字符及以上的进程名（comm 最多 15 个字符，可能被截断）会改用命令行里的程序名。
MAX_NAME = 14


@dataclass(frozen=True)
class Named:
    """启动的进程：`pid` 是第一个进程，`pids` 是全部（`copies` 个，第一个之外都是它 fork 出的）。"""

    pid: int
    pids: list[int]
    name: str
    #: 命令行（各参数以空格连接，与节点展示的一致）。
    cmdline: str


class NamedSleep:
    """启动名字独特的进程（各自一个新进程组），`close()` 时杀掉整组。"""

    def __init__(self) -> None:
        self._procs: list[subprocess.Popen[bytes]] = []

    @staticmethod
    def argv(name: str, seconds: str) -> list[str]:
        """进程名为 `name`、睡 `seconds` 秒的命令（例如交给 `sh -c "...; exec ..."`）。"""
        assert 0 < len(name) <= MAX_NAME, name
        return [sys.executable, "-I", __file__, name, seconds]

    def start(self, name: str, seconds: str, copies: int = 1) -> Named:
        """启动，等到全部进程都已改名后返回。"""
        argv = self.argv(name, seconds)
        env = {**os.environ, "NAMED_SLEEP_COPIES": str(copies)}
        proc = subprocess.Popen(argv, env=env, start_new_session=True)
        self._procs.append(proc)
        return Named(proc.pid, wait_renamed(proc.pid, name, copies), name, " ".join(argv))

    def close(self) -> None:
        for proc in self._procs:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()


@pytest.fixture(name="named_sleep")
def named_sleep_fixture() -> Iterator[NamedSleep]:
    """启动进程名、命令行都独特的进程（不依赖 coreutils），测试结束时杀掉。"""
    procs = NamedSleep()
    yield procs
    procs.close()


def wait_renamed(pid: int, name: str, copies: int) -> list[int]:
    """等到进程 `pid` 及它 fork 出的 `copies - 1` 个进程的进程名都是 `name`，返回它们的 pid。"""
    root = psutil.Process(pid)
    # 进程名与可执行文件（Python 解释器）的文件名无关。
    assert Path(root.exe()).name != name
    deadline = time.monotonic() + 30
    while True:
        procs = [root, *root.children()]
        if len(procs) == copies and all(p.name() == name for p in procs):
            return sorted(p.pid for p in procs)
        assert root.is_running(), f"进程 {pid} 已退出"
        assert time.monotonic() < deadline, f"进程 {pid} 没有在 30 秒内改名为 {name}"
        time.sleep(0.01)


def main() -> None:
    name, seconds = sys.argv[1], float(sys.argv[2])
    with open("/proc/self/comm", "w") as comm:
        comm.write(name)
    for _ in range(int(os.environ.get("NAMED_SLEEP_COPIES", "1")) - 1):
        if os.fork() == 0:
            break
    time.sleep(seconds)


if __name__ == "__main__":
    main()
