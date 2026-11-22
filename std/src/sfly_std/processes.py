"""进程：启动后台进程、停止它、按进程号、进程名或命令行找进程。

- `start_background_process`：在新会话里启动后台进程，节点结束后它继续运行（跨节点存活的进程，
  例如被测服务）；由一个看护进程记下它的退出码；
- `stop_background_process`：终止后台进程所在的进程组，先 SIGTERM，宽限期后 SIGKILL；
- `ProcessFinder`、`find_processes`：按 `pid`、`name`、`match` 找进程，可以连同子孙进程，
  每次调用都重新找（进程重启之后按名字就能找到新的）。

后台进程不属于任务的进程树：节点结束、任务被取消或超时都不会停止它，运行结束后也不会自动停止。
启动它的节点所在的场景里，一定要有一个停止它的节点（设为 always 节点），或者在节点自己的 `finally`
里停。
"""

from __future__ import annotations

import os
import select
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import psutil

from sfly import Context
from sfly_std import _process, _supervise
from sfly_std._process import Target as ProcessTarget
from sfly_std.waiting import poll_until

__all__ = [
    "BackgroundProcess",
    "ProcessFinder",
    "ProcessTarget",
    "StartFailed",
    "StopFailed",
    "StoppedProcess",
    "background_exit_code",
    "find_processes",
    "start_background_process",
    "stop_background_process",
]

#: 等看护进程报告命令 pid 的最长时间（秒）。
REPORT_TIMEOUT = 30.0
#: SIGKILL 之后等进程消失的最长时间（秒）。
KILL_WAIT = 5.0


class StartFailed(Exception):
    """后台进程没有启动起来。"""


class StopFailed(Exception):
    """SIGKILL 之后进程仍然没有退出。"""


@dataclass(frozen=True)
class BackgroundProcess:
    """`start_background_process` 启动起来的后台进程。"""

    #: 进程号：交给 `stop_background_process`、`ProcessFinder` 等。
    pid: int
    #: 日志文件的绝对路径：进程的标准输出和标准错误追加写在这里，
    #: `LogFile`、`follow_log_file` 读的就是它。
    log_file: str


@dataclass(frozen=True)
class StoppedProcess:
    """`stop_background_process` 的结果。"""

    #: 开始停止时进程是否还在运行。
    was_running: bool
    #: 进程的退出码：被信号终止时为 128 + 信号值（SIGTERM 为 143，被 SIGKILL 强制杀掉为 137）；
    #: 拿不到时为 None。
    exit_code: int | None


def start_background_process(
    ctx: Context,
    command: str,
    *,
    shell: str = "/bin/sh",
    env: dict[str, str] | None = None,
    cwd: str | None = None,
    log_file: str | None = None,
) -> BackgroundProcess:
    """在后台启动一个常驻进程，不等它结束，返回进程号和日志文件的路径。

    进程在新的会话和进程组里运行，不属于任务的进程树：节点结束、任务被取消或超时都不会停止它。
    标准输出和标准错误只写进日志文件（`log_file`，相对路径相对于 `cwd`，目录不存在时自动创建；
    不给时在后台进程目录 `ctx.procs_dir` 里，和任务目录按同一个保留期清理），不转为任务日志。
    `shell`、`env`、`cwd` 的含义同 `run_command`。

    只有解释器或工作目录不存在时（`FileNotFoundError`、`NotADirectoryError`）、看护进程没能启动
    命令时抛出 `StartFailed`；命令随后失败退出时这里仍然成功：用 `wait_for_port`、
    `wait_for_log_line` 等它就绪。
    """
    _process.check_cwd(cwd)
    if log_file is None:
        log = os.path.abspath(ctx.procs_dir / f"{ctx.task.node_id}.log")
    else:
        log = os.path.abspath(os.path.join(cwd or os.getcwd(), log_file))
    os.makedirs(os.path.dirname(log), exist_ok=True)

    read_fd, write_fd = os.pipe()
    try:
        with open(log, "ab") as out:
            supervisor = subprocess.Popen(
                [
                    sys.executable,
                    "-I",
                    _supervise.__file__,
                    str(ctx.procs_dir),
                    str(write_fd),
                    shell,
                    "-c",
                    command,
                ],
                cwd=cwd,
                env=_process.child_env(env),
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=subprocess.STDOUT,
                pass_fds=(write_fd,),
                # 新会话：不在任务的进程组里，任务结束、取消或超时时平台终止进程树都不会波及它。
                start_new_session=True,
            )
    finally:
        os.close(write_fd)
    try:
        report = _read_report(read_fd)
    finally:
        os.close(read_fd)
    preview = _process.preview(command)
    if not report.isdigit():
        supervisor.wait()
        reason = report.removeprefix("error ") or f"看护进程退出码 {supervisor.returncode}"
        raise StartFailed(f"无法启动后台进程（{reason}）：{preview}")
    pid = int(report)
    ctx.log.info("已启动后台进程 %d：%s；日志：%s", pid, preview, log)
    return BackgroundProcess(pid=pid, log_file=log)


def _read_report(fd: int) -> str:
    """读看护进程经管道报告的一行（命令的 pid 或 `error <原因>`），直到它关闭管道。"""
    data = b""
    deadline = time.monotonic() + REPORT_TIMEOUT
    while (left := deadline - time.monotonic()) > 0:
        ready, _, _ = select.select([fd], [], [], left)
        if not ready:
            break
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        data += chunk
    return data.decode("utf-8", errors="replace").strip()


def stop_background_process(
    ctx: Context,
    pid: int | None,
    *,
    grace: float = 10,
) -> StoppedProcess:
    """停止 `start_background_process` 启动的后台进程：终止 `pid` 所在的整个进程组。

    先发 SIGTERM，`grace` 秒后还没退出的发 SIGKILL；进程组里的子进程一起终止，自己脱离进程组的
    进程不在其中。进程已经不在、或 `pid` 为 None（例如启动它的那一步没有成功）时什么也不做，直接
    成功，所以适合放在 `finally` 里清理。返回开始停止时它是否在运行，和退出码（取自看护进程
    记下的）。

    SIGKILL 之后进程仍然没有退出（例如卡在不可中断的磁盘读写里）时抛出 `StopFailed`；`pid` 不是
    正整数时抛出 `ValueError`。
    """
    if pid is None:
        ctx.log.info("没有给出 pid，不需要停止")
        return StoppedProcess(was_running=False, exit_code=None)
    if pid <= 0:
        raise ValueError(f"pid 必须是正整数，实际为 {pid}")
    status = _supervise.read_status(ctx.procs_dir, pid)
    was_running = _process.alive_pid(pid)
    try:
        pgid: int | None = os.getpgid(pid) if was_running else None
    except ProcessLookupError:
        was_running, pgid = False, None
    if pgid is None and status is not None:
        # 进程自己退出了，它在后台启动的进程可能还在同一个进程组里。
        pgid = status.pgid
    if pgid is not None and (pgid <= 1 or pgid == os.getpgrp()):
        pgid = None  # 不是独立的进程组（例如和执行器同组）：只终止这个进程

    def targets() -> list[int]:
        if pgid is not None:
            return _members(pgid)
        return [pid] if _process.alive_pid(pid) else []

    def send(sig: signal.Signals) -> None:
        try:
            if pgid is not None:
                os.killpg(pgid, sig)
            else:
                os.kill(pid, sig)
        except ProcessLookupError:
            pass

    killed = False
    if targets():
        what = f"进程组 {pgid}" if pgid is not None else f"进程 {pid}"
        ctx.log.info("向%s发送 SIGTERM，宽限期 %g 秒", what, grace)
        send(signal.SIGTERM)
        if not _wait_gone(targets, grace):
            ctx.log.warn("宽限期 %g 秒已过，%s仍未退出，发送 SIGKILL", grace, what)
            killed = was_running and _process.alive_pid(pid)
            send(signal.SIGKILL)
            if not _wait_gone(targets, KILL_WAIT):
                raise StopFailed(f"发送 SIGKILL 后 {KILL_WAIT:g} 秒，{what}仍未退出：{targets()}")
    elif not was_running:
        ctx.log.info("进程 %d 已不在运行", pid)

    # 进程刚退出时看护进程可能还没写下退出码。
    wait = _process.EXIT_CODE_WAIT if was_running and not killed else 0
    exit_code = _process.exit_code(ctx.procs_dir, pid, wait)
    if exit_code is None and killed:
        exit_code = 128 + signal.SIGKILL
    if was_running:
        ctx.log.info("进程 %d 已退出，退出码 %s", pid, exit_code)
    return StoppedProcess(was_running=was_running, exit_code=exit_code)


def _members(pgid: int) -> list[int]:
    """进程组里还活着的进程（不含僵尸进程）。"""
    members = []
    for proc in psutil.process_iter():
        try:
            if os.getpgid(proc.pid) == pgid and _process.alive(proc):
                members.append(proc.pid)
        except ProcessLookupError:
            continue
    return members


def _wait_gone(targets: Callable[[], list[int]], timeout: float) -> bool:
    """最多等 `timeout` 秒，直到 `targets()` 为空；返回是否等到了。"""
    try:
        poll_until(
            lambda: True if not targets() else None,
            what="进程退出",
            wait=max(timeout, 0),
            poll=_process.POLL_INTERVAL,
        )
    except TimeoutError:
        return False
    return True


def background_exit_code(
    ctx: Context, pid: int, *, wait: float = _process.EXIT_CODE_WAIT
) -> int | None:
    """看护进程记下的后台进程的退出码。

    不是 `start_background_process` 启动的进程、或还没退出时为 None。进程刚退出时看护进程可能
    还没写下退出码：最多等 `wait` 秒。
    """
    return _process.exit_code(ctx.procs_dir, pid, wait)


def find_processes(
    *,
    pid: int | Sequence[int] | None = None,
    name: str | Sequence[str] | None = None,
    match: str | Sequence[str] | None = None,
    include_children: bool = False,
) -> list[psutil.Process]:
    """按进程号、进程名（完全相同）或命令行（正则，部分匹配）找当前存在的进程，可以连同子孙进程。

    三个参数都可以是单个值或列表，满足其中任意一个就算；不含僵尸进程和调用者自己。至少要给一个，
    否则抛出 `ValueError`。每次调用都重新找：进程重启之后按 `name` 或 `match` 就能找到新的进程，
    `pid` 找到的是那个进程号现在对应的进程。要一直盯着一组目标（再找、记住第一次找到的进程）用
    `ProcessFinder`。
    """
    finder = ProcessFinder(pid=pid, name=name, match=match, include_children=include_children)
    return list(finder.processes(finder.roots()).values())


class ProcessFinder:
    """按目标（`pid`、`name`、`match` 里的每一项）找进程；`include_children` 时加上全部子孙进程。

    每个目标各自匹配零到多个进程：`roots()` 按目标给出匹配到的进程（某个目标的列表为空，说明它现在
    没有进程），`processes(roots)` 展开成 pid → 进程。按 `pid` 指定的目标第一次找到时记住进程对象，
    之后 pid 被别的进程复用时不会把新进程当成它；按 `name`、`match` 指定的目标每次都重新找，
    进程重启之后能找到新的。写法不对（一个目标都没有、`pid` 不是正整数、正则不合法）时构造函数抛出
    `ValueError`。
    """

    def __init__(
        self,
        *,
        pid: int | Sequence[int] | None = None,
        name: str | Sequence[str] | None = None,
        match: str | Sequence[str] | None = None,
        include_children: bool = True,
    ) -> None:
        self.targets: list[ProcessTarget] = _process.targets(pid, name, match)
        self._include_children = include_children
        # 按 pid 指定的目标第一次找到时的进程：pid 被别的进程复用时不会把新进程当成它。
        self._pinned: dict[int, psutil.Process] = {}

    def roots(self) -> dict[ProcessTarget, list[psutil.Process]]:
        """每个目标当前匹配的进程（不含僵尸进程和执行器自己），按参数里的顺序。"""
        found: dict[ProcessTarget, list[psutil.Process]] = {t: [] for t in self.targets}
        for target in self.targets:
            if target.kind != "pid":
                continue
            proc = self._pinned.get(target.pid)
            if proc is None:
                try:
                    proc = self._pinned[target.pid] = psutil.Process(target.pid)
                except psutil.NoSuchProcess:
                    continue
            if proc.is_running() and _process.alive(proc):
                found[target].append(proc)
        by_name = [t for t in self.targets if t.kind != "pid"]
        if by_name:
            for proc in psutil.process_iter(["name", "cmdline"]):
                if proc.pid == os.getpid() or not _process.alive(proc):
                    continue
                name = proc.info["name"] or ""
                command = " ".join(proc.info["cmdline"] or ())
                for target in by_name:
                    if target.matches(proc, name, command):
                        found[target].append(proc)
        return found

    def processes(
        self, roots: dict[ProcessTarget, list[psutil.Process]]
    ) -> dict[int, psutil.Process]:
        """目标进程（`include_children` 时含子孙进程），pid → 进程。"""
        result: dict[int, psutil.Process] = {}
        for matched in roots.values():
            for root in matched:
                family = [root]
                if self._include_children:
                    try:
                        family += root.children(recursive=True)
                    except psutil.NoSuchProcess:
                        continue
                for proc in family:
                    if proc.pid != os.getpid() and _process.alive(proc):
                        result.setdefault(proc.pid, proc)
        return result
