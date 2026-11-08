"""`process_monitor`：按采样间隔统计目标进程（默认含整棵进程树）的资源。

指标是所有进程的合计，另按每个进程（标签 `pid`、`name`）各上报一个序列。
每个进程每次采样的明细写进产物 `processes.csv`，每采样一次就写入并刷新，
节点被停止、取消时已采集的明细不丢。用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的
`process_monitor` 一节。
"""

from __future__ import annotations

import csv
import os
import time
from collections.abc import Sequence
from datetime import datetime, timezone
from typing import Literal, TypedDict

import psutil

from sfly import Chart, Context, Metric, node
from sfly_std import _process
from sfly_std._process import Target
from sfly_std._sampling import rate, validate_duration, validate_interval
from sfly_std._waiting import poll_until

#: 每个进程每次采样的明细产物。
CSV_NAME = "processes.csv"
#: processes.csv 的列（与「标准节点」页一致）。
CSV_COLUMNS = (
    "time",
    "pid",
    "ppid",
    "name",
    "cpu_percent",
    "rss_bytes",
    "threads",
    "open_fds",
    "io_read_bytes_per_s",
    "io_write_bytes_per_s",
    "cmdline",
)
#: 按进程的指标（`*_by_process`）的标签键。
BY_PROCESS_LABELS = ("pid", "name")
#: 按进程的指标 → `_Sample` 里对应的值；值为 None（读不到）时这个进程不上报这一项。
BY_PROCESS: dict[
    str,
    Literal[
        "cpu_percent",
        "rss_bytes",
        "threads",
        "open_fds",
        "io_read_bytes_per_s",
        "io_write_bytes_per_s",
    ],
] = {
    "cpu_percent_by_process": "cpu_percent",
    "rss_bytes_by_process": "rss_bytes",
    "threads_by_process": "threads",
    "open_fds_by_process": "open_fds",
    "io_read_bytes_per_s_by_process": "io_read_bytes_per_s",
    "io_write_bytes_per_s_by_process": "io_write_bytes_per_s",
}
#: 等目标进程出现时的检查间隔（秒）。
WAIT_POLL = 0.2
#: 进程没有变化时，每隔多少秒把进程列表和各自的资源写一次日志。
LOG_EVERY = 60.0


class ProcessMonitorOutputs(TypedDict):
    samples: int
    processes_csv: str


class ProcessNotFound(Exception):
    """等了 `wait_for_process` 秒，仍有目标没有匹配到进程。"""


class ProcessExited(Exception):
    """监控期间某个目标匹配的进程全部退出了（`on_exit` 为 `fail`）。"""


class _Sample(TypedDict):
    pid: int
    ppid: int
    name: str
    cpu_percent: float
    rss_bytes: int
    threads: int
    open_fds: int | None
    io_read_bytes_per_s: float | None
    io_write_bytes_per_s: float | None
    cmdline: str


@node(
    title="监控进程",
    metrics=[
        Metric("cpu_percent", unit="%", description="所有进程的 CPU 占用之和（一个核满载为 100）"),
        Metric("rss_bytes", unit="B", description="所有进程的常驻内存之和"),
        Metric("threads", description="所有进程的线程数之和"),
        Metric("open_fds", description="所有进程打开的文件描述符数之和"),
        Metric("io_read_bytes_per_s", unit="B/s", description="所有进程的磁盘读取速率之和"),
        Metric("io_write_bytes_per_s", unit="B/s", description="所有进程的磁盘写入速率之和"),
        Metric(
            "cpu_percent_by_process",
            unit="%",
            description="每个进程的 CPU 占用（一个核满载为 100）",
            labels=BY_PROCESS_LABELS,
        ),
        Metric(
            "rss_bytes_by_process",
            unit="B",
            description="每个进程的常驻内存",
            labels=BY_PROCESS_LABELS,
        ),
        Metric("threads_by_process", description="每个进程的线程数", labels=BY_PROCESS_LABELS),
        Metric(
            "open_fds_by_process",
            description="每个进程打开的文件描述符数（读不到的进程不上报）",
            labels=BY_PROCESS_LABELS,
        ),
        Metric(
            "io_read_bytes_per_s_by_process",
            unit="B/s",
            description="每个进程的磁盘读取速率（读不到的进程不上报）",
            labels=BY_PROCESS_LABELS,
        ),
        Metric(
            "io_write_bytes_per_s_by_process",
            unit="B/s",
            description="每个进程的磁盘写入速率（读不到的进程不上报）",
            labels=BY_PROCESS_LABELS,
        ),
    ],
    charts=[
        Chart("CPU", metrics=["cpu_percent"]),
        Chart("内存", metrics=["rss_bytes"]),
        Chart("线程与文件描述符", metrics=["threads", "open_fds"]),
        Chart("磁盘读写", metrics=["io_read_bytes_per_s", "io_write_bytes_per_s"]),
        Chart("CPU（按进程）", metrics=["cpu_percent_by_process"]),
        Chart("内存（按进程）", metrics=["rss_bytes_by_process"]),
        Chart("线程数（按进程）", metrics=["threads_by_process"]),
        Chart("文件描述符（按进程）", metrics=["open_fds_by_process"]),
        Chart(
            "磁盘读写（按进程）",
            metrics=["io_read_bytes_per_s_by_process", "io_write_bytes_per_s_by_process"],
        ),
    ],
    primary_metric="cpu_percent",
)
def process_monitor(
    ctx: Context,
    pid: int | Sequence[int] | None = None,
    name: str | Sequence[str] | None = None,
    match: str | Sequence[str] | None = None,
    include_children: bool = True,
    wait_for_process: float = 60,
    interval: float = 1,
    duration: float | None = None,
    on_exit: Literal["fail", "succeed"] = "fail",
) -> ProcessMonitorOutputs:
    """每 `interval` 秒（默认 1）采样一次目标进程，上报所有进程的合计指标和每个进程各自的指标。

    - 目标：`pid`（进程号）、`name`（进程名，完全相同）、`match`（命令行正则，部分匹配即可），
      都可以是列表，至少给出一个；`include_children`（默认 true）时加上目标的全部子孙进程；
    - 启动时最多等 `wait_for_process` 秒（默认 60）让每个目标都匹配到进程，等不到时失败；
    - 某个目标匹配的进程全部退出时，`on_exit` 为 `fail`（默认）则失败，为 `succeed` 则成功结束；
    - `duration`（秒）过后成功结束；不设置时一直运行到被停止或取消。

    每个进程每次采样的明细写进产物 `processes.csv`；输出采样次数 `samples` 和它的产物引用
    `processes_csv`。
    """
    targets = _Targets(_process.targets(pid, name, match), include_children)
    validate_interval(interval)
    validate_duration(duration)

    _wait_for_targets(ctx, targets, wait_for_process)
    tracked: dict[int, _Tracked] = {}
    _refresh(targets, tracked)
    ctx.log.info(
        "监控 %d 个进程：\n%s", len(tracked), "\n".join(t.describe() for t in tracked.values())
    )

    started = last_log = time.monotonic()
    count = 0
    with open(ctx.artifacts.path(CSV_NAME), "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        f.flush()
        while duration is None or time.monotonic() - started < duration:
            time.sleep(interval)
            now = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
            samples: list[_Sample] = []
            for t in tracked.values():
                try:
                    samples.append(t.sample())
                except psutil.NoSuchProcess:
                    pass  # 刚退出，下面 _refresh 时报告
            for s in samples:
                writer.writerow({"time": now, **{k: "" if v is None else v for k, v in s.items()}})
            f.flush()
            count += 1
            _report_totals(ctx, samples)
            _report_by_process(ctx, samples)

            exited, added, removed = _refresh(targets, tracked)
            if added or removed:
                lines = [f"新增 {t.describe()}" for t in added]
                lines += [f"已退出 pid {t.proc.pid} {t.name}" for t in removed]
                ctx.log.info("进程有变化，现在监控 %d 个进程：\n%s", len(tracked), "\n".join(lines))
            elif time.monotonic() - last_log >= LOG_EVERY:
                last_log = time.monotonic()
                ctx.log.info(
                    "监控 %d 个进程：\n%s", len(samples), "\n".join(_describe(s) for s in samples)
                )
            if exited:
                what = "、".join(_with_exit_code(ctx, target) for target in exited)
                if on_exit == "fail":
                    raise ProcessExited(f"目标进程已退出：{what}")
                ctx.log.info("目标进程已退出：%s；on_exit 为 succeed，结束监控", what)
                break
    return {"samples": count, "processes_csv": ctx.artifacts.ref(CSV_NAME)}


class _Targets:
    """按目标（`pid`、`name`、`match` 里的每一项）找进程；`include_children` 时加上全部子孙进程。

    每个目标各自匹配零到多个进程。
    """

    def __init__(self, targets: Sequence[Target], include_children: bool) -> None:
        self._targets = list(targets)
        self._include_children = include_children
        # 按 pid 指定的目标第一次找到时的进程：pid 被别的进程复用时不会把新进程当成它。
        self._pinned: dict[int, psutil.Process] = {}

    def roots(self) -> dict[Target, list[psutil.Process]]:
        """每个目标当前匹配的进程（不含僵尸进程和执行器自己），按参数里的顺序。"""
        found: dict[Target, list[psutil.Process]] = {t: [] for t in self._targets}
        for target in self._targets:
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
        by_name = [t for t in self._targets if t.kind != "pid"]
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

    def processes(self, roots: dict[Target, list[psutil.Process]]) -> dict[int, psutil.Process]:
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


def _wait_for_targets(ctx: Context, targets: _Targets, wait: float) -> None:
    """等到每个目标都匹配到进程；`wait` 秒后仍有目标没有匹配到时失败。"""
    missing: list[str] = []

    def all_found() -> bool | None:
        missing[:] = [t.label for t, matched in targets.roots().items() if not matched]
        return True if not missing else None

    if all_found():
        return
    ctx.log.info("等待目标进程出现（最多 %g 秒）：%s", wait, "、".join(missing))
    try:
        poll_until(all_found, what="目标进程出现", wait=max(wait, 0), poll=WAIT_POLL)
    except TimeoutError:
        raise ProcessNotFound(
            f"等待 {wait:g} 秒后仍没有找到目标进程：{'、'.join(missing)}"
        ) from None


class _Tracked:
    """跨采样保留的进程：psutil 用同一个对象算两次采样之间的 CPU 占用，IO 速率也要上次的读数。"""

    def __init__(self, proc: psutil.Process) -> None:
        self.proc = proc
        with proc.oneshot():
            proc.cpu_percent(None)  # 第一次调用只记下起点，下一次采样返回这段时间的占用
            self.name = proc.name()
            self.cmdline = _process.cmdline(proc)
        self.io = _io(proc)

    def describe(self) -> str:
        return f"pid {self.proc.pid} {self.name}：{_process.preview(self.cmdline)}"

    def sample(self) -> _Sample:
        proc = self.proc
        with proc.oneshot():
            cpu = proc.cpu_percent(None)
            rss = proc.memory_info().rss
            threads = proc.num_threads()
            ppid = proc.ppid()
            # exec 换了程序时 pid 不变，名称和命令行跟着变。
            self.name = proc.name()
            self.cmdline = _process.cmdline(proc)
            try:
                fds: int | None = proc.num_fds()
            except psutil.AccessDenied:
                fds = None  # 别的用户的进程
        read_rate = write_rate = None
        io = _io(proc)
        if io is not None and self.io is not None and io[0] > self.io[0]:
            elapsed = io[0] - self.io[0]
            read_rate = rate(io[1], self.io[1], elapsed)
            write_rate = rate(io[2], self.io[2], elapsed)
        self.io = io
        return {
            "pid": proc.pid,
            "ppid": ppid,
            "name": self.name,
            "cpu_percent": cpu,
            "rss_bytes": rss,
            "threads": threads,
            "open_fds": fds,
            "io_read_bytes_per_s": read_rate,
            "io_write_bytes_per_s": write_rate,
            "cmdline": self.cmdline,
        }


def _refresh(
    targets: _Targets, tracked: dict[int, _Tracked]
) -> tuple[list[Target], list[_Tracked], list[_Tracked]]:
    """按目标当前匹配的进程更新 `tracked`。

    返回（匹配的进程已全部退出的目标, 新增的进程, 退出的进程）。
    """
    roots = targets.roots()
    found = targets.processes(roots)
    removed = [tracked.pop(pid) for pid in list(tracked) if pid not in found]
    added: list[_Tracked] = []
    for pid, proc in found.items():
        old = tracked.get(pid)
        if old is not None and old.proc == proc:  # 同一个 pid、同一个启动时间
            continue
        if old is not None:
            removed.append(old)  # pid 被复用
        try:
            tracked[pid] = _Tracked(proc)
        except psutil.NoSuchProcess:
            tracked.pop(pid, None)
            continue
        added.append(tracked[pid])
    exited = [target for target, matched in roots.items() if not matched]
    return exited, added, removed


def _report_totals(ctx: Context, samples: Sequence[_Sample]) -> None:
    """上报所有进程的合计；拿不到的值（别的用户的进程的文件描述符、IO）不计入。"""
    ctx.metric("cpu_percent", sum(s["cpu_percent"] for s in samples))
    ctx.metric("rss_bytes", sum(s["rss_bytes"] for s in samples))
    ctx.metric("threads", sum(s["threads"] for s in samples))
    ctx.metric("open_fds", sum(s["open_fds"] or 0 for s in samples))
    ctx.metric("io_read_bytes_per_s", sum(s["io_read_bytes_per_s"] or 0 for s in samples))
    ctx.metric("io_write_bytes_per_s", sum(s["io_write_bytes_per_s"] or 0 for s in samples))


def _report_by_process(ctx: Context, samples: Sequence[_Sample]) -> None:
    """每个进程各自上报，标签是 pid 和进程名；读不到的值（文件描述符、IO）不上报。"""
    for s in samples:
        labels = {"pid": str(s["pid"]), "name": s["name"]}
        for metric, key in BY_PROCESS.items():
            value = s[key]
            if value is not None:
                ctx.metric(metric, value, labels=labels)


def _io(proc: psutil.Process) -> tuple[float, int, int] | None:
    """（读数时刻、累计读字节、累计写字节）；没有权限读取或平台不支持时为 None。"""
    try:
        counters = proc.io_counters()
    except (psutil.AccessDenied, psutil.NoSuchProcess, AttributeError):
        return None
    return (time.monotonic(), counters.read_bytes, counters.write_bytes)


def _describe(s: _Sample) -> str:
    fds = "-" if s["open_fds"] is None else s["open_fds"]
    return (
        f"pid {s['pid']} {s['name']}：CPU {s['cpu_percent']:.1f}%，"
        f"内存 {s['rss_bytes'] / (1 << 20):.1f} MiB，线程 {s['threads']}，文件描述符 {fds}"
    )


def _with_exit_code(ctx: Context, target: Target) -> str:
    """按 pid 指定的目标是同一次运行里 `start_process` 启动的进程时，附上看护进程记下的退出码。"""
    if target.kind != "pid":
        return target.label
    code = _process.exit_code(ctx.procs_dir, target.pid, _process.EXIT_CODE_WAIT)
    return target.label if code is None else f"{target.label}（退出码 {code}）"
