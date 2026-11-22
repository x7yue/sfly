"""测试用的节点外壳：把 `sfly_std` 的辅助函数包成节点，在真实的执行器进程里跑。

辅助函数要在执行器里才能测到的行为（被取消时抛出 `Cancelled`、上报指标和日志、任务结束后的产物）
靠这些外壳来测（`sfly.testing.run_node`）。它们的参数和 0.3.0 里同名的节点一致，所以原来的测试
照常有效；但它们不是平台提供的节点：平台只提供 `shell`、`start_process`、`stop_process` 三个节点
（ADR 0030），其余能力在业务节点里直接调用辅助函数。
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Annotated, Literal, TypedDict

from sfly import AgentName, Context, Doc, node
from sfly_std.agent_files import WATCH_METRICS, pull_files_from_agent, watch_agent_files
from sfly_std.logs import FOLLOW_METRICS, follow_log_file, wait_for_log_line
from sfly_std.resources import (
    PROCESS_CHARTS,
    PROCESS_METRICS,
    SYSTEM_CHARTS,
    SYSTEM_METRICS,
    monitor_processes,
    monitor_system,
)
from sfly_std.waiting import DEFAULT_POLL, DEFAULT_WAIT, wait_for_file, wait_for_port


@node(
    title="系统监控",
    metrics=SYSTEM_METRICS,
    charts=SYSTEM_CHARTS,
    primary_metric="cpu_percent",
)
def system_monitor(
    ctx: Context,
    interval: Annotated[float, Doc("采样间隔（秒），必须大于 0")] = 1,
    duration: Annotated[
        float | None,
        Doc("监控多少秒后成功结束；不设置时一直运行，直到被停止子流程节点停止或运行被取消"),
    ] = None,
    disk_path: Annotated[
        str, Doc("统计哪个文件系统的空间使用率：给出其中的任意路径，必须已经存在")
    ] = "/",
    nic: Annotated[
        str | None, Doc("统计哪块网卡的收发速率，例如 eth0；合计包含回环网卡 lo")
    ] = None,
    disk: Annotated[
        str | None,
        Doc("统计哪块磁盘的读写速率，例如 nvme0n1 或 /dev/sda；合计只算整块磁盘，不重复计入分区"),
    ] = None,
) -> None:
    """按采样间隔上报执行它的 Agent 所在机器的 CPU、内存、负载、磁盘和网络指标。

    不设置 duration 时一直运行，直到被停止子流程节点停止或运行被取消，
    所以要放在子流程里和压测同时运行。
    被停止时记为「已停止」，不算失败，已经上报的指标都保留。

    失败：指定的网卡、磁盘或 disk_path 不存在时立即失败，错误信息列出本机有哪些网卡、磁盘。
    """
    monitor_system(
        ctx, interval=interval, duration=duration, disk_path=disk_path, nic=nic, disk=disk
    )


class ProcessMonitorOutputs(TypedDict):
    samples: Annotated[int, Doc("采样了多少次")]
    processes_csv: Annotated[str, Doc("产物 processes.csv 的引用")]


@node(
    title="监控进程",
    metrics=PROCESS_METRICS,
    charts=PROCESS_CHARTS,
    primary_metric="cpu_percent",
)
def process_monitor(
    ctx: Context,
    pid: Annotated[
        int | Sequence[int] | None, Doc("进程号，或进程号的列表；通常引用 start_process 的输出 pid")
    ] = None,
    name: Annotated[
        str | Sequence[str] | None,
        Doc("进程名（可执行文件名，例如 nginx，必须完全一致），或进程名的列表"),
    ] = None,
    match: Annotated[
        str | Sequence[str] | None,
        Doc("命令行（各参数以空格连接）的正则表达式，部分匹配即可，或正则的列表"),
    ] = None,
    include_children: Annotated[bool, Doc("是否连同目标的全部子孙进程一起统计")] = True,
    wait_for_process: Annotated[float, Doc("开始时最多等多少秒让每个目标都出现")] = 60,
    interval: Annotated[float, Doc("采样间隔（秒）")] = 1,
    duration: Annotated[
        float | None,
        Doc("监控多少秒后成功结束；不设置时一直运行，直到被停止子流程节点停止或运行被取消"),
    ] = None,
    on_exit: Annotated[
        Literal["fail", "succeed"], Doc("目标进程退出时：fail 让节点失败，succeed 让节点成功结束")
    ] = "fail",
) -> ProcessMonitorOutputs:
    """统计目标进程（默认连同全部子孙进程）用了多少资源，上报合计和每个进程各自的指标。

    副作用：每个进程每次采样的明细写进产物 processes.csv，进程列表有变化时写一条任务日志。

    不设置 duration 时一直运行，直到被停止子流程节点停止或运行被取消，被停止时记为「已停止」，
    不算失败。

    失败：开始时最多等 wait_for_process 秒让每个目标都出现，等不到时失败，错误信息列出没找到的目标。
    某个目标匹配的进程全部退出时，on_exit 为 fail（默认）则失败，为 succeed 则成功结束。
    pid、name、match 一个都没给时也失败。
    """
    result = monitor_processes(
        ctx,
        pid=pid,
        name=name,
        match=match,
        include_children=include_children,
        appear_within=wait_for_process,
        interval=interval,
        duration=duration,
        on_exit=on_exit,
    )
    return {"samples": result.samples, "processes_csv": result.csv_ref}


@node(title="等待端口")
def wait_port(
    ctx: Context,
    port: Annotated[int, Doc("端口号")],
    host: Annotated[
        str, Doc("主机名或 IP 地址，从执行节点的 Agent 所在的机器上连接")
    ] = "127.0.0.1",
    wait: Annotated[float, Doc("最多等多少秒")] = DEFAULT_WAIT,
    poll: Annotated[float, Doc("检查间隔（秒）")] = DEFAULT_POLL,
) -> None:
    """等一个 TCP 端口可以连接，用来等被测服务开始监听。

    失败：wait 秒内一直连不上时失败，错误信息写明等的是哪个地址、等了多久和最后一次连接的错误。
    端口能连上只说明进程在监听，不一定已经能处理请求：
    服务有健康检查接口时改用 http_request（打开 until_ok）等它返回成功。
    """
    wait_for_port(ctx, port, host=host, wait=wait, poll=poll)


class WaitFileOutputs(TypedDict):
    size: Annotated[int, Doc("成功时文件的大小（字节）")]


@node(title="等待文件")
def wait_file(
    ctx: Context,
    path: Annotated[str, Doc("文件路径；相对路径相对于任务工作目录")],
    stable: Annotated[
        float, Doc("文件出现后，还要等它的大小和修改时间连续这么多秒不变；为 0 时出现就成功")
    ] = 0,
    wait: Annotated[float, Doc("最多等多少秒")] = DEFAULT_WAIT,
    poll: Annotated[float, Doc("检查间隔（秒）")] = DEFAULT_POLL,
) -> WaitFileOutputs:
    """等一个文件出现，可以要求它保持若干秒不变，例如等对方把报告写完。

    失败：wait 秒内没等到时失败，错误信息写明当时的情况：「文件不存在」或「文件仍在变化」。
    只等普通文件：路径是目录时一直等到超时。
    """
    return {"size": wait_for_file(ctx, path, stable=stable, wait=wait, poll=poll).size}


class WaitLogLineOutputs(TypedDict):
    line: Annotated[str, Doc("第一行匹配的内容（不含换行符）")]


@node(title="等待日志行")
def wait_log_line(
    ctx: Context,
    path: Annotated[str, Doc("日志文件路径；相对路径相对于任务工作目录")],
    pattern: Annotated[
        str, Doc("Python 正则表达式，匹配行内任意位置（re.search）；要匹配整行用 ^...$")
    ],
    # 不叫 from：节点参数就是函数参数，而 from 是 Python 关键字。
    read_from: Annotated[
        Literal["end", "start"],
        Doc("从哪里开始看：end 只看节点开始之后新写入的内容，start 从文件开头看起"),
    ] = "end",
    wait: Annotated[float, Doc("最多等多少秒")] = DEFAULT_WAIT,
    poll: Annotated[float, Doc("检查间隔（秒）")] = DEFAULT_POLL,
) -> WaitLogLineOutputs:
    """等日志文件里出现匹配正则的行，用来等被测系统打出就绪日志。

    文件还不存在时等它出现；文件被轮转或截断时继续读新的内容。

    失败：wait 秒内没有出现匹配的行时失败，错误信息写明文件、正则和等了多久。
    文件一直不存在时，错误信息注明「文件不存在」。
    """
    found = wait_for_log_line(ctx, path, pattern, read_from=read_from, wait=wait, poll=poll)
    return {"line": found.line}


class FollowLogOutputs(TypedDict):
    lines: Annotated[int, Doc("转发的总行数（duration 到期时才有输出）")]


@node(title="跟随日志", metrics=FOLLOW_METRICS, primary_metric="lines_per_s")
def follow_log(
    ctx: Context,
    path: Annotated[str, Doc("日志文件路径；相对路径相对于任务工作目录")],
    # 不叫 from：节点参数就是函数参数，而 from 是 Python 关键字。
    read_from: Annotated[
        Literal["end", "start"],
        Doc("从哪里开始跟随：end 从节点开始时的文件末尾，start 先转发文件里已有的内容"),
    ] = "end",
    fail_on: Annotated[
        Sequence[str], Doc("正则表达式列表（re.search）：有一行匹配其中任意一个时节点失败")
    ] = (),
    duration: Annotated[
        float | None,
        Doc("跟随多少秒后成功结束；不设置时一直跟随，直到被停止子流程节点停止或运行被取消"),
    ] = None,
) -> FollowLogOutputs:
    """把日志文件新增的行实时转为任务日志，出现匹配的错误行时失败。

    文件还不存在时等它出现；文件被轮转或截断时继续跟随新的内容。
    不设置 duration 时一直跟随，直到被停止子流程节点停止或运行被取消。
    被停止时不算失败，已经转发的行都留在任务日志里。

    失败：有一行匹配 fail_on 里的任意一个正则时立即失败，错误信息附上第一行匹配的内容和匹配的正则。
    """
    result = follow_log_file(ctx, path, read_from=read_from, fail_on=fail_on, duration=duration)
    return {"lines": result.lines}


def _listed(paths: Sequence[Path]) -> list[str]:
    """输出里的本地路径列表（节点输出不能超过 1 MB）：最多 1000 个、序列化后最多 256 KiB，
    超过时只保留前面的，文件数另有输出。"""
    result: list[str] = []
    size = 2  # []
    for path in paths[:1000]:
        text = str(path)
        size += len(json.dumps(text, ensure_ascii=False).encode()) + 2  # 逗号和空格
        if size > 256 * 1024:
            break
        result.append(text)
    return result


class PullFilesOutputs(TypedDict):
    files: Annotated[
        list[str],
        Doc(
            "拉下来的文件的本地绝对路径，按拉取的顺序；最多列出 1000 个（序列化后最多 256 KiB），"
            "更多时只列出前面的，以 count 为准"
        ),
    ]
    count: Annotated[int, Doc("拉下来的文件数")]
    total_bytes: Annotated[int, Doc("拉下来的文件的总字节数")]


@node(title="拉取文件")
def pull_files(
    ctx: Context,
    source: Annotated[
        AgentName,
        Doc(
            "来源 Agent：文件在哪一台 Agent 上（「Agent」类型的参数，"
            "检查器里从已注册的 Agent 中选）"
        ),
    ],
    directory: Annotated[str, Doc("来源 Agent 所在机器上的目录，绝对路径")],
    local_dir: Annotated[
        str,
        Doc(
            "拉到哪个本地目录：执行这个节点的 Agent 所在机器上的路径，相对路径相对于任务工作目录；"
            "不存在时自动创建"
        ),
    ],
    pattern: Annotated[str, Doc("文件名的通配符，只匹配文件名（不含目录），例如 app.log.*")] = "*",
    recursive: Annotated[
        bool, Doc("为 true 时也拉取子目录里匹配的文件，在 local_dir 下保留子目录结构")
    ] = False,
    delete_source: Annotated[
        bool, Doc("为 true 时每拉完一个文件就删除来源 Agent 上的这个源文件")
    ] = False,
) -> PullFilesOutputs:
    """把另一台 Agent 上某个目录下匹配通配符的文件一次性拉到本地目录，可以拉完后删除源文件。

    副作用：在 local_dir 里创建文件，目录不存在时自动创建，同名的已有文件被替换。
    每个文件先写到临时文件，下载完成、核对大小后才改名，不会留下半截文件，已经拉完的文件保留。
    delete_source 打开时，每拉完一个文件就删除来源 Agent 上的这个源文件，只删下载成功的。

    失败：directory 不存在、不是目录或没有权限时失败。
    某个文件下载失败时立即失败，错误信息写明是哪个文件，之后的不再拉取。
    文件在下载期间被改写、截短或大小变了（还在写入）时，下载失败。
    没有匹配的文件时不失败，输出的 count 为 0。
    """
    result = pull_files_from_agent(
        ctx,
        source,
        directory=directory,
        local_dir=local_dir,
        pattern=pattern,
        recursive=recursive,
        delete_source=delete_source,
    )
    return {
        "files": _listed(result.paths),
        "count": result.count,
        "total_bytes": result.total_bytes,
    }


class WatchFilesOutputs(TypedDict):
    count: Annotated[int, Doc("拉下来的文件数（duration 到期时才有输出）")]
    total_bytes: Annotated[int, Doc("拉下来的文件的总字节数")]


@node(title="持续拉取文件", metrics=WATCH_METRICS, primary_metric="bytes_per_s")
def watch_files(
    ctx: Context,
    source: Annotated[
        AgentName,
        Doc(
            "来源 Agent：文件在哪一台 Agent 上（「Agent」类型的参数，"
            "检查器里从已注册的 Agent 中选）"
        ),
    ],
    directory: Annotated[str, Doc("来源 Agent 所在机器上要监听的目录，绝对路径；不含子目录")],
    local_dir: Annotated[
        str,
        Doc(
            "拉到哪个本地目录：执行这个节点的 Agent 所在机器上的路径，相对路径相对于任务工作目录；"
            "不存在时自动创建"
        ),
    ],
    pattern: Annotated[str, Doc("文件名的通配符，只匹配文件名（不含目录），例如 app.log.*")] = "*",
    stable: Annotated[
        float | None, Doc("文件至少这么多秒没有修改才拉；不设置（或为 0）时一出现就拉")
    ] = None,
    delete_source: Annotated[
        bool, Doc("为 true 时每拉完一个文件就删除来源 Agent 上的这个源文件")
    ] = False,
    duration: Annotated[
        float | None,
        Doc("运行多少秒后成功结束；不设置时一直运行，直到被停止子流程节点停止或运行被取消"),
    ] = None,
) -> WatchFilesOutputs:
    """持续监听另一台 Agent 上的一个目录，把匹配通配符的文件拉到本地目录，每个文件只拉一次。

    副作用：在 local_dir 里创建文件，目录不存在时自动创建，同名的已有文件被替换。
    启动时已有的和之后出现的文件都拉；每个文件先写到临时文件，下载完成后才改名，不会留下半截文件。
    delete_source 打开时，每拉完一个文件就删除来源 Agent 上的源文件，只删拉成功的。
    一直运行到 duration 到期，或被停止子流程节点停止、运行被取消。
    被停止时记为「已停止」，不算失败，已经拉完的文件保留。
    平台不判断文件是否写完：按被测系统怎样轮转日志来选 pattern 和 stable。

    失败：第一次就连不上来源 Agent、directory 不存在或没有权限时立即失败。
    之后连接中断不失败，写一条警告日志，一直重试到连上。
    """
    result = watch_agent_files(
        ctx,
        source,
        directory=directory,
        local_dir=local_dir,
        pattern=pattern,
        stable=stable or 0,
        delete_source=delete_source,
        duration=duration,
    )
    return {"count": result.count, "total_bytes": result.total_bytes}
