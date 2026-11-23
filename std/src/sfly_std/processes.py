"""进程：启动后台进程、停止它、按进程号、进程名或命令行找进程。

- `start_background_process`：在新会话里启动后台进程，节点结束后它继续运行（跨节点存活的进程，
  例如被测服务）；由一个看护进程记下它的退出码；
- `stop_background_process`：终止后台进程所在的进程组，先 SIGTERM，宽限期后 SIGKILL；
- `background_exit_status`：后台进程现在还在不在，退出了的话退出码是什么（只有看护进程记过的才有）；
- `find_processes`：按 `pid`、`name`、`match` 找进程，可以连同子孙进程，每次调用都重新找
  （进程重启之后按名字就能找到新的）。

后台进程不属于任务的进程树：节点结束、任务被取消或超时都不会停止它，运行结束后也不会自动停止。
启动它的节点所在的场景里，一定要有一个停止它的节点（设为 always 节点），或者在节点自己的
`finally` 里停：在 `finally` 里停要在平台给的收尾时间（默认 10 秒）内做完，见
`stop_background_process`。

路径参数可以是 `str` 或 `os.PathLike`，返回的路径是 `pathlib.Path`（后缀 `*_path` 是本地路径）；
时间都以秒为单位。`find_processes` 返回的进程是 `psutil.Process`：psutil 的接口也是这里的接口。
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
from pathlib import Path

import psutil

from sfly import Context
from sfly_std import _names, _params, _process, _supervise
from sfly_std._finder import ProcessFinder
from sfly_std.waiting import poll_until

__all__ = [
    "BackgroundExit",
    "BackgroundProcess",
    "StartFailed",
    "StopFailed",
    "StoppedProcess",
    "background_exit_status",
    "find_processes",
    "start_background_process",
    "stop_background_process",
]

#: 等看护进程报告命令 pid 的最长时间（秒）。
REPORT_TIMEOUT = 30.0
#: `stop_background_process` 的 `grace` 默认值（秒）：平台终止任务时只给节点 10 秒收尾
#: （Agent 的 `--terminate-grace`，默认 10 秒），在 `finally` 里停进程要留出发 SIGKILL 的时间。
DEFAULT_GRACE = 5.0
#: SIGKILL 之后等进程消失的最长时间（秒）。
KILL_WAIT = 5.0
#: 任务已经被取消（`ctx.cancelled()`）时，宽限期最长这么多秒、SIGKILL 之后最多等这么多秒：
#: 取消和超时时平台的 SIGTERM 和取消标记同时到，剩下的收尾时间已经不多。
CANCELLED_GRACE = 3.0
CANCELLED_KILL_WAIT = 2.0


class StartFailed(Exception):
    """后台进程没有启动起来。"""


class StopFailed(Exception):
    """SIGKILL 之后进程仍然没有退出。"""


@dataclass(frozen=True)
class BackgroundProcess:
    """`start_background_process` 启动起来的后台进程。"""

    #: 进程号：交给 `stop_background_process`、`background_exit_status`、`find_processes` 等。
    pid: int
    #: 日志文件的绝对路径（本地路径）：进程的标准输出和标准错误追加写在这里，`LogFile`、
    #: `follow_log_file`、`wait_for_log_line` 读的就是它；要存成产物时直接交给
    #: `ctx.artifacts.save(名称, 它)`。
    log_path: Path


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
    cwd: str | os.PathLike[str] | None = None,
    log_path: str | os.PathLike[str] | None = None,
) -> BackgroundProcess:
    """在后台启动一个常驻进程，不等它结束，返回进程号和日志文件的路径。

    进程在新的会话和进程组里运行，不属于任务的进程树：节点结束、任务被取消或超时都不会停止它。
    标准输出和标准错误只写进日志文件，不转为任务日志。`log_path` 相对路径相对于 `cwd`，目录不存在
    时自动创建，同一个文件追加写（自己指定时写到哪里是你的事，同名的文件被接着写）；不给时每次
    调用得到一个新的文件，在后台进程目录 `ctx.procs_dir`（和任务目录按同一个保留期清理）里：
    第一次是 `<节点 ID>.log`，同一个节点里再起进程（起第二个服务；节点被重试）依次是
    `<节点 ID>-2.log`、`<节点 ID>-3.log`……，所以两个进程的日志不会混在一起，
    `wait_for_log_line(…, read_from="start")` 也不会匹配到上一个进程打的行。
    `shell`、`env`、`cwd` 的含义同 `run_command`。

    工作目录不存在时抛出 `NotADirectoryError`；解释器不存在、看护进程没能启动命令时抛出
    `StartFailed`（`run_command` 在解释器不存在时抛出的是 `FileNotFoundError`，两个函数不同）。
    命令随后失败退出时这里仍然成功：用 `wait_for_port`、`wait_for_log_line` 等它就绪。
    """
    _process.check_cwd(cwd)
    if log_path is None:
        procs = Path(ctx.procs_dir)
        procs.mkdir(parents=True, exist_ok=True)
        log = (procs / _names.claim(procs.joinpath, f"{ctx.task.node_id}.log")).absolute()
    else:
        log = Path(os.path.abspath(os.path.join(cwd or os.getcwd(), log_path)))
        log.parent.mkdir(parents=True, exist_ok=True)

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
    return BackgroundProcess(pid=pid, log_path=log)


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
    grace: float = DEFAULT_GRACE,
) -> StoppedProcess:
    """停止 `start_background_process` 启动的后台进程：终止 `pid` 所在的整个进程组。

    先发 SIGTERM，`grace` 秒后还没退出的发 SIGKILL；进程组里的子进程一起终止，自己脱离进程组的
    进程不在其中。进程已经不在、或 `pid` 为 None（例如启动它的那一步没有成功）时什么也不做，直接
    成功，所以适合放在 `finally` 里清理。返回开始停止时它是否在运行，和退出码（取自看护进程
    记下的）。

    在 `finally` 里清理要在平台给节点的收尾时间内做完：任务被取消或超时时，平台向节点发 SIGTERM，
    10 秒（Agent 的 `--terminate-grace`，默认 10 秒）后强制杀掉整棵进程树，来不及发 SIGKILL 时
    服务和它的看护进程都会留下。所以 `grace` 默认只有 5 秒，比平台的收尾时间短；任务已经被取消
    （`ctx.cancelled()`）时再收紧：宽限期最多 3 秒，SIGKILL 之后最多等 2 秒（给的 `grace` 更小时
    用更小的）。服务退出得慢、需要更长的宽限期时，不要在 `finally` 里停，用单独的 always 节点
    （`stop_process`，它有自己的时间）。

    这些上限是按每次调用算的，不是整个收尾的预算：每停一个不响应 SIGTERM 的服务要用掉约 `grace`
    秒。取消和超时一样，Agent 都先写取消标记再发 SIGTERM（`ctx.cancelled()` 在收尾时间里为真），所以
    两种情况下每个最多约 3 秒，三个这样的服务的收尾约 9.4 秒；停四个及以上这样的服务时，要把
    `grace` 给小（总和留在 10 秒以内），或者用 always 节点停。

    SIGKILL 之后进程仍然没有退出（例如卡在不可中断的磁盘读写里）时抛出 `StopFailed`；`pid` 不是
    正整数、`grace` 是布尔值时抛出 `ValueError`。
    """
    _params.seconds("grace", grace)
    if pid is None:
        ctx.log.info("没有给出 pid，不需要停止")
        return StoppedProcess(was_running=False, exit_code=None)
    if pid <= 0:
        raise ValueError(f"pid 必须是正整数，实际为 {pid}")
    cancelled = ctx.cancelled()
    kill_wait = CANCELLED_KILL_WAIT if cancelled else KILL_WAIT
    if cancelled and grace > CANCELLED_GRACE:
        ctx.log.info(
            "任务已被取消，平台留给收尾的时间不多，宽限期从 %g 秒缩短为 %g 秒",
            grace,
            CANCELLED_GRACE,
        )
        grace = CANCELLED_GRACE
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
        found = _members(pgid) if pgid is not None else []
        # 进程刚被杀掉、内核还在收尾时，进程组里查不到它，但 `background_exit_status` 看它还在：
        # 等到连这个进程号也不在了才算停好，两个函数对同一个进程的说法才一致。
        if pid not in found and _process.alive_pid(pid):
            found.append(pid)
        return found

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
            if not _wait_gone(targets, kill_wait):
                raise StopFailed(f"发送 SIGKILL 后 {kill_wait:g} 秒，{what}仍未退出：{targets()}")
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


@dataclass(frozen=True)
class BackgroundExit:
    """`background_exit_status` 的结果：后台进程现在是什么状态。

    `running` 回答的是「这个进程现在还在不在」，不管它是不是 `start_background_process` 启动的；
    `supervised` 说明退出码查不查得到（只有看护进程记过的才有）。四种情况：

    - 还在运行：`running` 为 True，`exit_code` 为 None；
    - 已经退出，有退出码：`running` 为 False，`exit_code` 是退出码；
    - 已经退出，不知道退出码：`running` 为 False，`exit_code` 为 None。看护进程没来得及记下就
      没了：整个进程组被强制结束（`stop_background_process` 发了 SIGKILL，或者被 `kill -9`、
      内存不足时被系统杀掉）时看护进程和服务一起没了；
    - 不是 `start_background_process` 启动的（`supervised` 为 False）：只知道进程号现在对应的进程
      在不在（`running`），`exit_code` 一定是 None。
    """

    #: 是 `start_background_process` 启动的（看护进程有它的记录），退出之后一般查得到退出码。
    supervised: bool
    #: 进程现在还在（不算已退出、还没被回收的僵尸进程）。
    running: bool
    #: 退出码：被信号终止时为 128 + 信号值；还在运行、查不到、或者看护进程没来得及记下时为 None。
    exit_code: int | None


def background_exit_status(ctx: Context, pid: int, *, wait: float = 0) -> BackgroundExit:
    """后台进程现在的状态：还在不在（`running`），退出了的话退出码是什么（`exit_code`）。

    这是个查询，默认看一眼就返回。进程刚退出时看护进程可能还没写下退出码：`wait` 给大于 0 的
    秒数时，还没有退出码的最多等这么久；等完还没有退出码，再看进程还在不在（整个进程组被强制
    结束时退出码永远写不进去，这时回答「已经退出，不知道退出码」，而不是「还在运行」）。
    `wait` 是秒数（不能是布尔值，否则抛出 `ValueError`）。
    """
    _params.seconds("wait", wait)
    status = _process.exit_status(ctx.procs_dir, pid, wait)
    running = _process.alive_pid(pid)
    if status is None:
        return BackgroundExit(supervised=False, running=running, exit_code=None)
    if status.exit_code is not None:
        return BackgroundExit(supervised=True, running=False, exit_code=status.exit_code)
    return BackgroundExit(supervised=True, running=running, exit_code=None)


def find_processes(
    *,
    pid: int | Sequence[int] | None = None,
    name: str | Sequence[str] | None = None,
    match: str | Sequence[str] | None = None,
    include_children: bool = True,
) -> list[psutil.Process]:
    """按进程号、进程名（完全相同）或命令行（正则，部分匹配）找当前存在的进程，默认连同子孙进程。

    三个参数都可以是单个值或列表，满足其中任意一个就算；不含僵尸进程和调用者自己。至少要给一个，
    否则抛出 `ValueError`。`include_children` 为 True（默认，和 `monitor_processes` 一致：一个服务
    指的是它的主进程和启动的全部子进程）时结果里还有匹配到的进程的全部子孙进程；只要匹配到的进程
    本身时传 False。每次调用都重新找：进程重启之后按 `name` 或 `match` 就能找到新的进程，`pid`
    找到的是那个进程号现在对应的进程。返回的是 `psutil.Process`，psutil 的接口也是这里的接口。
    """
    finder = ProcessFinder(pid=pid, name=name, match=match, include_children=include_children)
    return list(finder.processes(finder.roots()).values())
