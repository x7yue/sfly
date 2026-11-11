"""通用桩节点（docs/SEMANTICS.md §8）。"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from importlib import metadata
from typing import Any

from sfly import Context, Metric, node


@node(title="回显", outputs=["text"])
def echo(ctx: Context, text: Any) -> dict[str, Any]:
    """原样返回 text（任意 JSON 值，例如上游输出的产物引用表）。"""
    return {"text": text}


@node(title="失败", outputs=[])
def fail(ctx: Context, message: str = "stub failure") -> dict[str, Any]:
    raise RuntimeError(message)


@node(title="按参数成功或失败", outputs=["ok"])
def outcome(ctx: Context, succeed: bool = True, message: str = "stub failure") -> dict[str, Any]:
    """succeed 为 False 时抛出 RuntimeError(message)，否则成功。"""
    if not succeed:
        raise RuntimeError(message)
    return {"ok": True}


@node(title="启动常驻进程", outputs=["pid"])
def start_process(ctx: Context, seconds: float = 3600) -> dict[str, Any]:
    """启动一个脱离任务进程树（新会话、不继承标准输入输出）的常驻进程，节点结束后它继续运行。"""
    child = subprocess.Popen(
        [sys.executable, "-c", f"import time; time.sleep({seconds})"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return {"pid": child.pid}


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _signal(pid: int, sig: int) -> None:
    # 进程可能在存活检查之后、发信号之前退出。
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        pass


@node(title="停止常驻进程", outputs=["was_running"])
def stop_process(ctx: Context, pid: int | None = None, wait: float = 10) -> dict[str, Any]:
    """终止 start_process 启动的进程并等它退出；pid 为空（上游没有产出）时什么也不做。"""
    if pid is None or not _alive(pid):
        return {"was_running": False}
    _signal(pid, signal.SIGTERM)
    deadline = time.monotonic() + wait
    while _alive(pid):
        if time.monotonic() > deadline:
            _signal(pid, signal.SIGKILL)
            break
        time.sleep(0.05)
    return {"was_running": True}


@node(title="下载", outputs=["texts"])
def download(ctx: Context, urls: dict[str, str]) -> dict[str, Any]:
    """按引用地址下载文本（读取上游节点的产物，urls 即 artifacts 节点输出的 refs）。"""
    import urllib.request

    texts = {}
    for name, url in urls.items():
        with urllib.request.urlopen(url, timeout=30) as response:
            texts[name] = response.read().decode("utf-8")
    return {"texts": texts}


@node(title="闸门", outputs=["attempt"])
def gate(ctx: Context, ready_file: str, release_file: str, seconds: float = 120) -> dict[str, Any]:
    """写出 ready_file（追加一行本次尝试序号）后等待 release_file 出现再成功；超过 seconds 则失败。

    让测试在任务执行中途制造故障（Agent 断线、控制面重启）。
    """
    with open(os.environ["SFLY_TASK"]) as f:
        attempt = int(json.load(f)["attempt"])
    with open(ready_file, "a") as f:
        f.write(f"{attempt}\n")
    deadline = time.monotonic() + seconds
    while not os.path.exists(release_file):
        if time.monotonic() > deadline:
            raise TimeoutError(f"{release_file} 没有出现")
        time.sleep(0.05)
    return {"attempt": attempt}


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


@node(title="等待取消", outputs=[])
def wait_cancel(
    ctx: Context, ready_file: str, report_file: str, seconds: float = 3600, artifacts: int = 0
) -> None:
    """写出 ready_file 后等待；被终止时（finally）把 ctx.cancelled() 写到 report_file。

    取消测试用。artifacts 大于 0 时先保存这么多个名字很长的空产物，让取消后打印的产物清单很长。
    """
    for i in range(artifacts):
        ctx.artifacts.save(f"{i:05d}-{'x' * 100}.txt", "")
    with open(ready_file, "w") as f:
        f.write(str(os.getpid()))
    try:
        time.sleep(seconds)
    finally:
        with open(report_file, "w") as f:
            f.write("cancelled" if ctx.cancelled() else "not cancelled")


@node(title="环境探针", outputs=["prefix", "cwd", "env"])
def probe(ctx: Context) -> dict[str, Any]:
    """报告执行环境：解释器所在 venv、工作目录、相关环境变量。"""
    names = [
        "SFLY_TASK",
        "SFLY_OUTPUT",
        "SFLY_ARTIFACTS",
        "SFLY_EVENTS",
        "SFLY_CANCEL",
        "SFLY_PROCS",
        "SFLY_AGENT_SOCKET",
    ]
    names += ["PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"]
    return {
        "prefix": sys.prefix,
        "cwd": os.getcwd(),
        "env": {name: os.environ.get(name) for name in names},
    }


@node(title="任务信息", outputs=["run_id", "node_id", "task_id", "attempt", "procs_dir"])
def task_info(ctx: Context) -> dict[str, Any]:
    """报告 `ctx.task` 与 `ctx.procs_dir`（需要 0.0.4 及以上的 SDK）。"""
    t = ctx.task
    return {
        "run_id": t.run_id,
        "node_id": t.node_id,
        "task_id": t.task_id,
        "attempt": t.attempt,
        "procs_dir": str(ctx.procs_dir),
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
    ctx: Context,
    files: dict[str, str] | None = None,
    fail: bool = False,
    mtimes: dict[str, float] | None = None,
) -> dict[str, Any]:
    """产物测试用：把 files（名称 → 文本内容）保存为产物，返回产物引用；fail 时保存后抛出异常。

    mtimes（名称 → Unix 秒）把对应产物文件的修改时间改成指定的值。
    """
    refs = {name: ctx.artifacts.save(name, content) for name, content in (files or {}).items()}
    for name, mtime in (mtimes or {}).items():
        os.utime(ctx.artifacts.path(name), (mtime, mtime))
    if fail:
        raise RuntimeError("保存产物后失败")
    return {"refs": refs}


@node(title="大输出", outputs=["text"])
def big(ctx: Context, size: int) -> dict[str, Any]:
    """节点输出上限测试用：返回 size 个字符的文本。"""
    return {"text": "x" * size}


@node(title="大量日志", outputs=["lines"])
def flood(ctx: Context, lines: int = 1000, interval: float = 0.0) -> dict[str, Any]:
    """完整日志测试用：输出 lines 行日志，来源（print / 标准错误 / SDK）和 SDK 级别轮换。"""
    levels = [ctx.log.debug, ctx.log.info, ctx.log.warning, ctx.log.error]
    for i in range(1, lines + 1):
        kind = i % 3
        if kind == 1:
            print(f"第 {i} 行 stdout")
        elif kind == 2:
            print(f"第 {i} 行 stderr", file=sys.stderr)
        else:
            levels[(i // 3) % 4]("第 %d 行 sdk", i)
        if interval:
            time.sleep(interval)
    return {"lines": lines}


@node(title="大量输出", outputs=[])
def spew(ctx: Context, stdout_mib: float = 0, stderr_mib: float = 0) -> None:
    """日志副本轮换测试用：向标准输出 / 标准错误各写出约这么多 MiB（每行 1 KiB）。

    每个流最后写一行「最后一行」。
    """
    line = "x" * 1023 + "\n"
    for stream, mib in ((sys.stdout, stdout_mib), (sys.stderr, stderr_mib)):
        for _ in range(int(mib * 1024)):
            stream.write(line)
        stream.write("最后一行\n")
        stream.flush()


@node(title="写盘失败", outputs=[])
def write_failure(ctx: Context, message: str = "OSError: [Errno 122] Disk quota exceeded") -> None:
    """错误摘要测试用（#70）：往标准错误打一行 message，然后模拟磁盘写满——

    工作目录里的 stderr.log 读不到（换成同名目录），执行器写 output.json 失败而异常退出
    （临时文件路径被同名目录占住）。
    """
    deadline = time.monotonic() + 10
    while not os.path.exists("stderr.log") and time.monotonic() < deadline:
        time.sleep(0.01)
    print(message, file=sys.stderr, flush=True)
    os.remove("stderr.log")
    os.mkdir("stderr.log")
    os.mkdir(os.environ["SFLY_OUTPUT"] + ".tmp")


@node(
    title="高频指标",
    outputs=["count"],
    metrics=[Metric("total", "", "counter", "累计上报次数")],
    primary_metric="total",
)
def metric_burst(ctx: Context, seconds: float = 3.0) -> dict[str, Any]:
    """事件通道测试用：在 seconds 秒内尽快上报累计计数 total（每次加一），返回上报次数。"""
    deadline = time.monotonic() + seconds
    count = 0
    while time.monotonic() < deadline:
        count += 1
        ctx.metric("total", float(count))
    return {"count": count}


class _Pacer:
    """定速节拍（性能测试的几个定速节点共用）：每 100 次对一次时间，提前了就等到计划时刻，
    落后了记下最长落后多久。"""

    def __init__(self, rate: float) -> None:
        self.rate = rate
        self.start = time.monotonic()
        self.max_behind = 0.0

    def ticks(self, total: int, before_wait: Callable[[], None] | None = None) -> Iterator[int]:
        """依次给出 0..total-1；before_wait 在每次等待之前调用（例如先把缓冲写出去）。"""
        for i in range(total):
            if i % 100 == 0:
                delay = self.start + i / self.rate - time.monotonic()
                if delay > 0:
                    if before_wait is not None:
                        before_wait()
                    time.sleep(delay)
                else:
                    self.max_behind = max(self.max_behind, -delay)
            yield i

    @property
    def elapsed(self) -> float:
        """从开始到现在的秒数。"""
        return time.monotonic() - self.start


@node(
    title="定速指标",
    outputs=["count", "elapsed", "max_behind_ms", "max_call_ms"],
    metrics=[Metric("seq", "", "gauge", "本次上报的序号")],
    primary_metric="seq",
)
def metric_rate(ctx: Context, rate: float = 10000, seconds: float = 10) -> dict[str, Any]:
    """性能测试用（pnpm perf）：按每秒 rate 次的速率上报 seconds 秒，第 i 次上报 seq = i。

    每 100 次对一次时间，提前了就等到计划时刻。返回上报次数、实际用时（秒）、
    比计划落后的最长时间与单次 `ctx.metric()` 的最长耗时（毫秒）：事件通道堵住时后两者会变大。
    """
    total = int(rate * seconds)
    pacer = _Pacer(rate)
    max_call = 0.0
    for i in pacer.ticks(total):
        before = time.perf_counter()
        ctx.metric("seq", float(i + 1))
        max_call = max(max_call, time.perf_counter() - before)
    return {
        "count": total,
        "elapsed": pacer.elapsed,
        "max_behind_ms": pacer.max_behind * 1000,
        "max_call_ms": max_call * 1000,
    }


@node(
    title="定速时钟",
    outputs=["count", "elapsed"],
    metrics=[Metric("clock_ms", "ms", "gauge", "调用 ctx.metric() 时的 Unix 毫秒数")],
    primary_metric="clock_ms",
)
def metric_clock(ctx: Context, rate: float = 1000, seconds: float = 10) -> dict[str, Any]:
    """性能测试用（pnpm perf 的端到端延迟）：按每秒 rate 次的速率上报 seconds 秒，

    每次上报调用时的 Unix 毫秒数。Agent 按秒合并成 gauge：最小值是这一秒第一次调用的时刻，
    最新值是最后一次，收到推送的一方据此算出从 `ctx.metric()` 到看到数据的延迟。
    每 100 次对一次时间，提前了就等到计划时刻。
    """
    total = int(rate * seconds)
    pacer = _Pacer(rate)
    for _ in pacer.ticks(total):
        ctx.metric("clock_ms", time.time() * 1000)
    return {"count": total, "elapsed": pacer.elapsed}


@node(title="定速输出", outputs=["lines", "bytes", "elapsed", "max_behind_ms"])
def stdout_rate(
    ctx: Context, mib_per_second: float = 10, seconds: float = 10, line_bytes: int = 1024
) -> dict[str, Any]:
    """性能测试用（pnpm perf）：按每秒 mib_per_second MiB 的速率向标准输出写 seconds 秒。

    每行连同换行 line_bytes 字节，以「序号 + 空格」开头，序号从 1 开始，用来核对日志不丢不重。
    每 100 行对一次时间，提前了就等到计划时刻。返回行数、字节数、实际用时（秒）
    与比计划落后的最长时间（毫秒）：标准输出写不动（Agent 背压）时它会变大。
    """
    total = int(mib_per_second * 1024 * 1024 * seconds / line_bytes)
    filler = "x" * line_bytes
    out = sys.stdout
    pacer = _Pacer(total / seconds)
    for i in pacer.ticks(total, before_wait=out.flush):
        head = f"{i + 1} "
        out.write(head + filler[: line_bytes - len(head) - 1] + "\n")
    out.flush()
    return {
        "lines": total,
        "bytes": total * line_bytes,
        "elapsed": pacer.elapsed,
        "max_behind_ms": pacer.max_behind * 1000,
    }


def _labeled_metrics() -> list[Metric]:
    """带标签的指标（#78）。

    bundle-self-update 用上一个 Release 的 Agent 和它自带的 SDK 加载本包，那个 SDK 的 `Metric`
    还没有 `labels`：在那里不声明这个指标，本包的其余节点照常可用。
    """
    try:
        return [Metric("conn", "", "gauge", "按连接区分的瞬时值", labels=["host", "port"])]
    except TypeError:
        return []


@node(
    title="指标",
    outputs=[],
    metrics=[
        Metric("level", "", "gauge", "瞬时值"),
        Metric("total", "", "counter", "累计值"),
        *_labeled_metrics(),
    ],
    primary_metric="level",
)
def metrics(ctx: Context, steps: list[Any]) -> None:
    """指标测试用：按顺序执行 steps。

    - `[指标名, 值]`：`ctx.metric(指标名, float(值))`，值可以是 `"nan"`、`"inf"` 这样的字符串；
    - `[指标名, 值, 标签]`：同上，带上标签（对象，原样传给 `labels`）；
    - 数字：等待这么多秒；
    - `"align"`：等到 Agent 合并指标用的下一秒开始（让随后的几次上报落在同一秒里）。
      Agent 按单调时钟分秒（ADR 0018），所以这里按同一个时钟对齐，不看系统时间。
    """
    # 与 Agent 的 clock::monotonic_ms 同一个时钟：
    # Linux 上是 CLOCK_BOOTTIME，其他系统是 CLOCK_MONOTONIC。
    merge_clock = getattr(time, "CLOCK_BOOTTIME", time.CLOCK_MONOTONIC)
    for step in steps:
        if step == "align":
            time.sleep(1 - time.clock_gettime(merge_clock) % 1)
        elif isinstance(step, (int, float)):
            time.sleep(step)
        elif len(step) == 3:
            name, value, labels = step
            ctx.metric(name, float(value), labels=labels)
        else:
            name, value = step
            ctx.metric(name, float(value))
