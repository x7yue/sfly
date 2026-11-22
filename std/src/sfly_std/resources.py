"""资源采样：按采样间隔上报整机或一组进程的 CPU、内存、磁盘、网络等指标。

- `monitor_system`：本机的 CPU、内存、负载、磁盘空间、磁盘和网络速率（合计，以及按每块磁盘、
  每块网卡），返回 `SystemMonitorResult`；
- `monitor_processes`：一组目标进程（默认连同全部子孙进程）的资源，合计加每个进程各自一个序列，
  每次采样的明细写进产物 `processes.csv`（同一个节点里再调用依次是 `processes-2.csv`……，也可以用
  `csv_artifact` 指定名称），返回 `ProcessMonitorResult`。目标可以按进程号、进程名或命令行指定，
  被监控的进程重启之后（`refind` 秒内）按名字重新找到它、接着监控，不会因为进程换了一个就结束。

指标要在调用它们的节点的 `@node` 里声明：用这里导出的 `SYSTEM_METRICS`、`SYSTEM_CHARTS`、
`PROCESS_METRICS`、`PROCESS_CHARTS`（都是元组，要加自己的指标时 `PROCESS_METRICS + (Metric(…),)`）：

    @node(title="压测期间监控", metrics=PROCESS_METRICS, charts=PROCESS_CHARTS,
          primary_metric="cpu_percent")
    def watch(ctx: Context, name: str) -> None:
        monitor_processes(ctx, name=name, refind=30)

不设置 `duration` 时一直采样，直到任务被取消（`sfly.Cancelled` 从 `time.sleep` 里抛出，已上报的
指标都保留），所以要放在子流程里和压测同时运行，由停止子流程节点停止。路径参数可以是 `str` 或
`os.PathLike`，时间以秒为单位。

函数是同步的：在业务动作进行的同时采样，要把采样放在子流程里的另一个节点（和动作并行），或者放到
一个线程里调用并用 `duration` 限定时长；没有「做完动作就停下」的回调（以后可以加一个关键字参数，
不影响现在的用法）。
"""

from __future__ import annotations

import csv
import os
import sys
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal, NamedTuple, TypedDict

import psutil

from sfly import Chart, Context, Metric
from sfly_std import _names, _process
from sfly_std._sampling import rate, validate_duration, validate_interval
from sfly_std.processes import ProcessFinder, ProcessTarget
from sfly_std.waiting import poll_until

__all__ = [
    "PROCESS_CHARTS",
    "PROCESS_METRICS",
    "SYSTEM_CHARTS",
    "SYSTEM_METRICS",
    "ProcessExited",
    "ProcessMonitorResult",
    "ProcessNotFound",
    "SystemMonitorResult",
    "monitor_processes",
    "monitor_system",
]


class _Counters(NamedTuple):
    """某一时刻的累计字节数，两次之差除以间隔就是 `RATE_METRICS` 里对应的速率。"""

    disk_read: int
    disk_write: int
    net_rx: int
    net_tx: int


RATE_METRICS = (
    "disk_read_bytes_per_s",
    "disk_write_bytes_per_s",
    "net_rx_bytes_per_s",
    "net_tx_bytes_per_s",
)
#: 按网卡的指标（接收、发送），标签 `nic`。
NIC_METRICS = ("net_rx_bytes_per_s_by_nic", "net_tx_bytes_per_s_by_nic")
#: 按磁盘的指标（读取、写入），标签 `disk`。
DISK_METRICS = ("disk_read_bytes_per_s_by_disk", "disk_write_bytes_per_s_by_disk")


class _Reading(NamedTuple):
    """某一时刻每块网卡（接收、发送）和每块磁盘（读取、写入，含分区）的累计字节数。

    合计、按网卡和按磁盘的速率都从同一次读数算出。
    """

    nics: dict[str, tuple[int, int]]
    disks: dict[str, tuple[int, int]]


def _read() -> _Reading:
    nics = psutil.net_io_counters(pernic=True)
    disks = psutil.disk_io_counters(perdisk=True) or {}
    return _Reading(
        {name: (c.bytes_recv, c.bytes_sent) for name, c in nics.items()},
        {name: (c.read_bytes, c.write_bytes) for name, c in disks.items()},
    )


def _whole_disk(name: str) -> bool:
    """是整块磁盘而不是分区，与 psutil 计算全部磁盘合计的口径相同：Linux 上是 /sys/block 下有的设备
    （含 loop 等虚拟设备）；其他平台按磁盘读到的本来就没有分区。"""
    if not sys.platform.startswith("linux"):
        return True
    return os.path.exists(f"/sys/block/{name.replace('/', '!')}")


def _net(reading: _Reading, nic: str | None) -> tuple[int, int]:
    if nic is None:
        return _sum(reading.nics.values())
    if nic not in reading.nics:
        raise ValueError(f"网卡 {nic!r} 不存在，本机的网卡有：{', '.join(sorted(reading.nics))}")
    return reading.nics[nic]


def _disk(reading: _Reading, disk: str | None) -> tuple[int, int]:
    if disk is None:
        return _sum(v for name, v in reading.disks.items() if _whole_disk(name))
    name = disk.removeprefix("/dev/")
    if name not in reading.disks:
        raise ValueError(f"磁盘 {disk!r} 不存在，本机的磁盘有：{', '.join(sorted(reading.disks))}")
    return reading.disks[name]


def _sum(values: Iterable[tuple[int, int]]) -> tuple[int, int]:
    first = second = 0
    for a, b in values:
        first += a
        second += b
    return first, second


def _counters(reading: _Reading, nic: str | None, disk: str | None) -> _Counters:
    return _Counters(*_disk(reading, disk), *_net(reading, nic))


@dataclass(frozen=True)
class SystemMonitorResult:
    """`monitor_system` 的结果。"""

    #: 采样了多少次。
    samples: int


#: `monitor_system` 上报的指标：自己的节点用 `@node(metrics=SYSTEM_METRICS, charts=SYSTEM_CHARTS,
#: primary_metric="cpu_percent")` 声明。
SYSTEM_METRICS = (
    Metric("cpu_percent", "%", description="CPU 使用率，所有核的平均"),
    Metric("mem_used_percent", "%", description="已用内存占总内存的比例"),
    Metric(
        "mem_used_bytes",
        "B",
        description="已用内存：总内存减去可用内存（available），不含可以回收的缓存",
    ),
    Metric("load1", "", description="1 分钟平均负载"),
    Metric("disk_used_percent", "%", description="disk_path 所在文件系统的已用空间比例"),
    Metric("disk_read_bytes_per_s", "B/s", description="磁盘每秒读取的字节数"),
    Metric("disk_write_bytes_per_s", "B/s", description="磁盘每秒写入的字节数"),
    Metric("net_rx_bytes_per_s", "B/s", description="网卡每秒接收的字节数"),
    Metric("net_tx_bytes_per_s", "B/s", description="网卡每秒发送的字节数"),
    Metric(
        "net_rx_bytes_per_s_by_nic",
        "B/s",
        description="每块网卡（含回环网卡 lo）每秒接收的字节数",
        labels=("nic",),
    ),
    Metric(
        "net_tx_bytes_per_s_by_nic",
        "B/s",
        description="每块网卡（含回环网卡 lo）每秒发送的字节数",
        labels=("nic",),
    ),
    Metric(
        "disk_read_bytes_per_s_by_disk",
        "B/s",
        description="每块磁盘（整块，不含分区）每秒读取的字节数",
        labels=("disk",),
    ),
    Metric(
        "disk_write_bytes_per_s_by_disk",
        "B/s",
        description="每块磁盘（整块，不含分区）每秒写入的字节数",
        labels=("disk",),
    ),
)

#: `monitor_system` 配套的图表。
SYSTEM_CHARTS = (
    Chart("CPU 使用率", "line", ("cpu_percent",)),
    Chart("内存使用率", "line", ("mem_used_percent",)),
    Chart("已用内存", "line", ("mem_used_bytes",)),
    Chart("负载", "line", ("load1",)),
    Chart("磁盘空间使用率", "line", ("disk_used_percent",)),
    Chart("磁盘读写", "line", ("disk_read_bytes_per_s", "disk_write_bytes_per_s")),
    Chart("网络收发", "line", ("net_rx_bytes_per_s", "net_tx_bytes_per_s")),
    Chart("磁盘读写（按磁盘）", "line", DISK_METRICS),
    Chart("网络收发（按网卡）", "line", NIC_METRICS),
)


def monitor_system(
    ctx: Context,
    *,
    interval: float = 1,
    duration: float | None = None,
    disk_path: str | os.PathLike[str] = "/",
    nic: str | None = None,
    disk: str | None = None,
) -> SystemMonitorResult:
    """按采样间隔上报执行它的 Agent 所在机器的 CPU、内存、负载、磁盘和网络指标；返回采样了多少次。

    `interval` 是采样间隔（秒，必须大于 0）；`duration` 秒后成功返回，不设置时一直运行，直到任务
    被取消（已经上报的指标都保留）；`disk_path` 是统计哪个文件系统的空间使用率（其中任意一个已存在
    的路径）；`nic` 是统计哪块网卡的收发速率（例如 `eth0`，不给是合计，含回环网卡）；`disk` 是统计
    哪块磁盘的读写速率（例如 `nvme0n1` 或 `/dev/sda`，不给时合计只算整块磁盘，不重复计入分区）。
    磁盘和网络的速率除了合计，还按每块整块磁盘、每块网卡各上报一个序列。
    指标按 `SYSTEM_METRICS` 声明。

    `interval`、`duration` 不合法或 `disk_path` 不存在时抛出 `ValueError`；指定的网卡、磁盘不存在时
    同样，信息列出本机有哪些网卡、磁盘。
    """
    validate_interval(interval)
    validate_duration(duration)
    if not os.path.exists(disk_path):
        raise ValueError(f"disk_path 不存在：{disk_path}")
    # 第一次采样的 CPU 使用率和速率都相对于这里。
    psutil.cpu_percent(interval=None)
    last = time.monotonic()
    last_reading = _read()
    before = _counters(last_reading, nic, disk)
    ctx.log.info(
        "开始监控：每 %g 秒采样一次，空间使用率统计 %s 所在的文件系统，网卡%s，磁盘%s；%s",
        interval,
        disk_path,
        "取合计" if nic is None else f" {nic}",
        "取合计" if disk is None else f" {disk}",
        "一直运行到被停止或取消" if duration is None else f"运行 {duration:g} 秒",
    )
    samples = 0
    try:
        deadline = None if duration is None else last + duration
        while True:
            wait = interval
            if deadline is not None:
                wait = min(interval, deadline - time.monotonic())
                if wait <= 0:
                    break
            time.sleep(wait)
            now = time.monotonic()
            elapsed = now - last
            last = now
            reading = _read()
            after = _counters(reading, nic, disk)
            memory = psutil.virtual_memory()
            ctx.metric("cpu_percent", psutil.cpu_percent(interval=None))
            samples += 1
            ctx.metric("mem_used_percent", memory.percent)
            ctx.metric("mem_used_bytes", memory.total - memory.available)
            ctx.metric("load1", psutil.getloadavg()[0])
            ctx.metric("disk_used_percent", psutil.disk_usage(os.fspath(disk_path)).percent)
            for name, current, previous in zip(RATE_METRICS, after, before, strict=True):
                ctx.metric(name, rate(current, previous, elapsed))
            _report_by_device(ctx, NIC_METRICS, "nic", reading.nics, last_reading.nics, elapsed)
            whole = {name: v for name, v in reading.disks.items() if _whole_disk(name)}
            _report_by_device(ctx, DISK_METRICS, "disk", whole, last_reading.disks, elapsed)
            before, last_reading = after, reading
    finally:
        # 被停止或取消时（Cancelled 从 sleep 里抛出）也执行；已上报的指标不受影响。
        ctx.log.info("监控结束，共采样 %d 次", samples)
    return SystemMonitorResult(samples=samples)


def _report_by_device(
    ctx: Context,
    metrics: tuple[str, str],
    label: str,
    current: dict[str, tuple[int, int]],
    previous: dict[str, tuple[int, int]],
    elapsed: float,
) -> None:
    """每块网卡或磁盘各自上报两项速率；上次读数里还没有的设备（刚出现）从下一次采样开始上报。"""
    for device, values in current.items():
        if device not in previous:
            continue
        for metric, now, then in zip(metrics, values, previous[device], strict=True):
            ctx.metric(metric, rate(now, then, elapsed), labels={label: device})


#: 每个进程每次采样的明细产物的默认名称：同一个节点里第二次起依次是 `processes-2.csv`……
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


@dataclass(frozen=True)
class ProcessMonitorResult:
    """`monitor_processes` 的结果。"""

    #: 采样了多少次。
    samples: int
    #: 明细产物的引用（下载地址，不是本地路径）：每个进程每次采样的明细。
    processes_csv: str
    #: 明细实际保存成的产物名称（`ctx.artifacts.path(它)` 是本地文件）。
    csv_artifact: str


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


#: `monitor_processes` 上报的指标：自己的节点用 `@node(metrics=PROCESS_METRICS,
#: charts=PROCESS_CHARTS, primary_metric="cpu_percent")` 声明。
PROCESS_METRICS = (
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
)

#: `monitor_processes` 配套的图表。
PROCESS_CHARTS = (
    Chart("CPU", metrics=("cpu_percent",)),
    Chart("内存", metrics=("rss_bytes",)),
    Chart("线程与文件描述符", metrics=("threads", "open_fds")),
    Chart("磁盘读写", metrics=("io_read_bytes_per_s", "io_write_bytes_per_s")),
    Chart("CPU（按进程）", metrics=("cpu_percent_by_process",)),
    Chart("内存（按进程）", metrics=("rss_bytes_by_process",)),
    Chart("线程数（按进程）", metrics=("threads_by_process",)),
    Chart("文件描述符（按进程）", metrics=("open_fds_by_process",)),
    Chart(
        "磁盘读写（按进程）",
        metrics=("io_read_bytes_per_s_by_process", "io_write_bytes_per_s_by_process"),
    ),
)


def monitor_processes(
    ctx: Context,
    *,
    pid: int | Sequence[int] | None = None,
    name: str | Sequence[str] | None = None,
    match: str | Sequence[str] | None = None,
    include_children: bool = True,
    wait_for_process: float = 60,
    interval: float = 1,
    duration: float | None = None,
    on_exit: Literal["fail", "succeed"] = "fail",
    refind: float = 0,
    csv_artifact: str | None = None,
) -> ProcessMonitorResult:
    """统计目标进程（默认连同全部子孙进程）用了多少资源，上报合计和每个进程各自的指标。

    目标用 `pid`（进程号）、`name`（进程名，必须完全一致）、`match`（命令行的正则，部分匹配）指定，
    都可以是单个值或列表，至少给一个。每个进程每次采样的明细写进产物 `processes.csv`，进程列表有
    变化时写一条任务日志。指标按 `PROCESS_METRICS` 声明。开始时最多等 `wait_for_process` 秒让每个
    目标都出现，等不到时抛出 `ProcessNotFound`，信息列出没找到的目标。

    `duration` 秒后成功返回；不设置时一直采样，直到任务被取消（已上报的指标和已写的明细都保留）。
    某个目标匹配的进程全部退出时：`on_exit` 为 `"fail"`（默认）抛出 `ProcessExited`，为 `"succeed"`
    成功返回。

    明细保存成的产物名称默认每次调用不同：第一次是 `processes.csv`，同一个节点里再调用依次是
    `processes-2.csv`、`processes-3.csv`……（前一次的明细不会被覆盖）；用 `csv_artifact` 指定名称时
    直接用它（同名的已有产物被覆盖）。实际用的名称在返回值的 `csv_artifact` 里。

    `refind` 解决被监控的进程会重启的问题（崩溃后被拉起、发版时被替换）：给了 `refind`（秒）时，
    按 `name` 或 `match` 指定的目标，进程退出之后最多再等这么多秒让新的进程出现，出现了就接着监控
    （日志里写明），超过时才按 `on_exit` 处理；等待期间不上报指标（没有进程可统计）。按 `pid`
    指定的目标不能这样找（进程号是一次性的），退出了就按 `on_exit` 处理。默认 0：不等。
    注意两点：新出现的进程是新的进程号，按进程的那组指标（标签 `pid`、`name`）因为 `pid` 标签变了
    是新的一条序列，合计的指标接着原来的序列、中间断开等待的那一段；等待期间任何名字、命令行
    符合条件的进程都算「重新出现」，同名的无关进程也一样，所以 `name`、`match` 要写得足够具体。

    `interval`、`duration` 不合法，或 `pid`、`name`、`match` 一个都没给、写法不对时抛出
    `ValueError`。
    """
    targets = ProcessFinder(pid=pid, name=name, match=match, include_children=include_children)
    validate_interval(interval)
    validate_duration(duration)
    if refind < 0:
        raise ValueError(f"refind 不能为负数，实际为 {refind:g}")

    _wait_for_targets(ctx, targets, wait_for_process)
    tracked: dict[int, _Tracked] = {}
    _refresh(targets, tracked)
    ctx.log.info(
        "监控 %d 个进程：\n%s", len(tracked), "\n".join(t.describe() for t in tracked.values())
    )

    started = last_log = time.monotonic()
    count = 0
    # 按名字指定的目标：从什么时候起没有匹配的进程（`refind` 用）。
    missing_since: dict[ProcessTarget, float] = {}
    csv_name = csv_artifact or _names.claim(ctx.artifacts.path, CSV_NAME)
    with open(ctx.artifacts.path(csv_name), "w", newline="", encoding="utf-8") as f:
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
            # 等被监控的进程重新出现期间（给了 refind、这一次一个进程都没采到）没有进程可统计：
            # 不上报全是 0 的合计。
            if samples or refind <= 0:
                _report_totals(ctx, samples)
                _report_by_process(ctx, samples)

            exited, added, removed = _refresh(targets, tracked)
            exited = _still_exited(ctx, exited, missing_since, refind)
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
    return ProcessMonitorResult(
        samples=count, processes_csv=ctx.artifacts.ref(csv_name), csv_artifact=csv_name
    )


def _wait_for_targets(ctx: Context, targets: ProcessFinder, wait: float) -> None:
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
    targets: ProcessFinder, tracked: dict[int, _Tracked]
) -> tuple[list[ProcessTarget], list[_Tracked], list[_Tracked]]:
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


def _with_exit_code(ctx: Context, target: ProcessTarget) -> str:
    """按 pid 指定的目标是同一次运行里 `start_process` 启动的进程时，附上看护进程记下的退出码。"""
    if target.kind != "pid":
        return target.label
    code = _process.exit_code(ctx.procs_dir, target.pid, _process.EXIT_CODE_WAIT)
    return target.label if code is None else f"{target.label}（退出码 {code}）"


def _still_exited(
    ctx: Context,
    exited: list[ProcessTarget],
    missing_since: dict[ProcessTarget, float],
    refind: float,
) -> list[ProcessTarget]:
    """`refind` 秒内按名字指定的目标还没有重新出现之前不算退出：返回真的该按 `on_exit` 处理的目标，
    并记下等待的开始和重新出现（写日志）。"""
    now = time.monotonic()
    for target in [t for t in missing_since if t not in exited]:
        waited = now - missing_since.pop(target)
        ctx.log.info("目标 %s 重新出现，等了 %.1f 秒，接着监控", target.label, waited)
    if refind <= 0:
        return exited
    gone: list[ProcessTarget] = []
    for target in exited:
        if target.kind == "pid":
            gone.append(target)
            continue
        since = missing_since.setdefault(target, now)
        if since == now:
            ctx.log.info("目标 %s 的进程都退出了，最多再等 %g 秒让它重新出现", target.label, refind)
        if now - since >= refind:
            gone.append(target)
    return gone
