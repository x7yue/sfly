"""后台进程的看护进程：`start_process` 和 `stop_process` 共用。只用标准库。

`start_process` 在新会话里启动看护进程（`python -I _supervise.py <后台进程目录> <管道> <命令…>`），
看护进程是新会话和新进程组的组长，在同一个进程组里启动命令，然后：

1. 写好命令的状态文件 `<后台进程目录>/.process-<pid>.json`
   （`pid`、进程组 `pgid`、`exit_code: null`），再经管道把命令的 pid 告诉 `start_process`
   （启动失败时写 `error <原因>`）；
2. 等命令退出，把退出码（被信号终止时为 128 + 信号值）写进状态文件后退出。

后台进程不是执行器的子进程，执行器（以及之后的 `stop_process`）拿不到它的退出码，
所以由看护进程记下。看护进程忽略 SIGTERM、SIGINT、SIGHUP（只设置处理函数，不是 SIG_IGN，
命令不会继承），`stop_process` 向整个进程组发 SIGTERM 时它留下来记录命令的退出码；
SIGKILL 时它和命令一起被杀掉，没有退出码。
"""

from __future__ import annotations

import dataclasses
import json
import os
import signal
import subprocess
import sys
from pathlib import Path


@dataclasses.dataclass(frozen=True)
class Status:
    """状态文件的内容。"""

    pid: int
    #: 命令所在的进程组（看护进程是组长）。
    pgid: int
    #: 命令的退出码（被信号终止时为 128 + 信号值）；还在运行时为 None。
    exit_code: int | None


def status_path(procs_dir: str | os.PathLike[str], pid: int) -> Path:
    """后台进程 `pid` 的状态文件。"""
    return Path(procs_dir) / f".process-{pid}.json"


def read_status(procs_dir: str | os.PathLike[str], pid: int) -> Status | None:
    """读取状态文件；不存在或内容不对时为 None。"""
    try:
        data = json.loads(status_path(procs_dir, pid).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("pid") != pid:
        return None
    pgid, exit_code = data.get("pgid"), data.get("exit_code")
    if not isinstance(pgid, int) or not (exit_code is None or isinstance(exit_code, int)):
        return None
    return Status(pid, pgid, exit_code)


def _write_status(path: Path, status: Status) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(dataclasses.asdict(status)), encoding="utf-8")
    os.replace(tmp, path)


def _ignore(signum: int, frame: object) -> None:
    pass


def main(argv: list[str]) -> int:
    procs_dir, report_fd, command = argv[1], int(argv[2]), argv[3:]
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, _ignore)
    with os.fdopen(report_fd, "w", encoding="utf-8") as report:
        try:
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL)
        except OSError as error:
            report.write(f"error {error}\n")
            return 127
        path = status_path(procs_dir, child.pid)
        status = Status(child.pid, os.getpgrp(), None)
        try:
            Path(procs_dir).mkdir(parents=True, exist_ok=True)
            _write_status(path, status)
        except OSError as error:
            print(f"无法写入状态文件 {path}：{error}", file=sys.stderr, flush=True)
        report.write(f"{child.pid}\n")
    returncode = child.wait()
    status = dataclasses.replace(
        status, exit_code=returncode if returncode >= 0 else 128 - returncode
    )
    try:
        _write_status(path, status)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
