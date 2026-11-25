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
from typing import TYPE_CHECKING, Any, Literal

import sfly
from sfly import Context, Metric, node

if TYPE_CHECKING:
    from sfly import FeishuBot, RunState
else:
    # 「飞书机器人」类型从 SDK 0.3.0 起才有、「运行状态」类型（RunState）从 0.6.0 起才有：
    # bundle-self-update 用上一个 Release 的 SDK 加载本包，那里用普通类型代替，
    # 本包的其余节点照常可用。
    FeishuBot = getattr(sfly, "FeishuBot", str)
    RunState = getattr(sfly, "RunState", dict)


class _NeverRaised(Exception):
    """旧 SDK 没有 `ArtifactLimitExceeded` 时 `artifact_limit` 节点接的类：永远不会抛出。"""


# `ArtifactLimitExceeded`、`ctx.artifacts.limit_bytes` 从 SDK 0.6.0 起才有（#477）：
# bundle-self-update 用上一个 Release 的 SDK 加载本包，导入时不能直接引用它们，
# 否则整个包都加载不了。
ArtifactLimitExceeded: type[Exception] = getattr(sfly, "ArtifactLimitExceeded", _NeverRaised)


@node(title="回显", outputs=["text"])
def echo(ctx: Context, text: Any) -> dict[str, Any]:
    """原样返回 text（任意 JSON 值，例如上游输出的产物引用表）。"""
    return {"text": text}


@node(title="失败", outputs=[])
def fail(ctx: Context, message: str = "stub failure") -> dict[str, Any]:
    raise RuntimeError(message)


@node(title="返回不是数的值", outputs=["x"])
def non_finite_output(ctx: Context, kind: str) -> dict[str, Any]:
    """返回 NaN 或无穷（kind 是 `nan`、`inf`、`-inf`）：JSON 里没有这些值，
    任务应该失败并写明原因（#481）。"""
    return {"x": float(kind)}


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
    ctx: Context,
    pid_file: str,
    seconds: float = 3600,
    ignore_term: bool = False,
    block_cancel_marker: bool = False,
) -> dict[str, Any]:
    """启动一个子进程后一起等待，把自己和子进程的 PID 写到 pid_file（超时、取消杀进程树的测试用）。

    ignore_term 时两个进程都忽略 SIGTERM，只能被强制杀掉。
    block_cancel_marker 时先在取消标记的路径（`SFLY_CANCEL`）上建一个目录：Agent 写取消标记会失败
    （EISDIR），测试看写失败时任务还是照常被终止。
    """
    if block_cancel_marker:
        os.mkdir(os.environ["SFLY_CANCEL"])
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


@node(title="停不理会 SIGTERM 的服务", outputs=[])
def stubborn_services(
    ctx: Context,
    pid_file: str,
    count: int = 2,
    grace: float = 3,
    cancelled_grace: float = 1,
) -> None:
    """起 count 个不理会 SIGTERM 的服务（各自一个会话，不在任务的进程树里），把 PID 写到 pid_file；
    被终止时在 finally 里依次停它们：SIGTERM 之后最多等一个宽限期再 SIGKILL。

    宽限期是 grace 秒；任务已被取消、也就是 `ctx.cancelled()` 为真（取消和超时进入收尾时间时 Agent
    都先写取消标记，#593）时压短成 cancelled_grace 秒。和 sfly-std 的 `stop_background_process`
    同样的做法：平台留给收尾的时间有限，每个服务都用满宽限期的话，后面的服务来不及被停掉。
    """
    services = [
        subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import signal, time\n"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "time.sleep(3600)",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        for _ in range(count)
    ]
    tmp = f"{pid_file}.tmp"
    with open(tmp, "w") as f:
        f.write(" ".join(str(service.pid) for service in services))
    os.replace(tmp, pid_file)
    try:
        time.sleep(3600)
    finally:
        wait = min(grace, cancelled_grace) if ctx.cancelled() else grace
        for service in services:
            service.terminate()
            try:
                service.wait(timeout=wait)
            except subprocess.TimeoutExpired:
                service.kill()
                service.wait()


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


@node(title="飞书通知", outputs=[])
def notify(
    ctx: Context, bot: FeishuBot, text: str, at_all: bool = False, unlisted: str = ""
) -> None:
    """ctx.notify 测试用（#234）：先写一行日志，再给 bot 发 text；unlisted 不为空时再发给它
    （普通字符串参数，不在任务引用的飞书机器人名单里）。

    ctx.notify 从 SDK 0.3.0 起才有：在上一个 Release 的 SDK 上这个节点不能运行。
    """
    ctx.log.info("发通知前")
    ctx.notify(bot, text, at_all=at_all)
    if unlisted:
        ctx.notify(unlisted, text)


@node(title="飞书原始消息", outputs=[])
def notify_message(ctx: Context, bot: FeishuBot, message: Any, unlisted: str = "") -> None:
    """ctx.notify(message=...) 测试用（#235）：把 message（任意 JSON 值，不检查）原样交给 bot；
    unlisted 不为空时再交给它（普通字符串参数，不在任务引用的飞书机器人名单里）。

    message= 从 SDK 0.3.0 起才有：在上一个 Release 的 SDK 上这个节点不能运行。
    """
    ctx.notify(bot, message=message)
    if unlisted:
        ctx.notify(unlisted, message=message)


@node(title="飞书卡片", outputs=[])
def notify_card(
    ctx: Context,
    bot: FeishuBot,
    title: str,
    markdown: str,
    color: Literal["blue", "green", "orange", "red", "grey"] = "blue",
) -> None:
    """sfly.feishu.card 测试用（#235）：给 bot 发一张标题、颜色和正文由参数给出的 Markdown 卡片。

    sfly.feishu 从 SDK 0.3.0 起才有，在函数里才访问它：上一个 Release 的 SDK 仍然能导入本包。
    """
    ctx.notify(bot, message=sfly.feishu.card(title, markdown, color))


#: 运行汇总的卡片：到此刻为止的结果 → （标题里的说法，卡片颜色）。
_RESULT: dict[str, tuple[str, Literal["green", "red", "grey"]]] = {
    "success": ("全部成功", "green"),
    "failed": ("有节点失败", "red"),
    "cancelled": ("已取消", "grey"),
}


@node(title="运行汇总", outputs=[])
def run_summary(ctx: Context, bot: FeishuBot, run: RunState) -> None:
    """运行汇总示例（#452，docs/guide/sdk-reference.md「运行汇总」）：放在链末尾、总是执行，
    按这次运行此刻的状态（`${{ run.state }}`）给 bot 发一张卡片：失败的节点和失败原因一行，
    被取消时写取消的人。

    `RunState` 从 SDK 0.6.0 起才有；`sfly.feishu` 在函数里才访问：
    上一个 Release 的 SDK 仍然能导入本包。
    """
    nodes = {n["node_id"]: n for chain in run["chains"] for n in chain["nodes"]}
    lines = []
    for node_id in run["failures"]:
        failed = nodes[node_id]
        reason = failed["error"]["headline"] if failed["error"] else "没有错误信息"
        lines.append(f"- 失败：{failed['display_name'] or node_id}：{reason}")
    if run["cancel"]:
        lines.append(f"- 由 {run['cancel']['requested_by']} 取消")
    words, color = _RESULT[run["result_so_far"]]
    title = f"{run['scenario']['name']}：{words}"
    ctx.notify(bot, message=sfly.feishu.card(title, "\n".join(lines) or "没有失败的节点", color))


@node(title="动作和标记", outputs=[])
def actions(ctx: Context, unfinished: bool = False, release_file: str = "") -> None:
    """动作与标记测试用（#355）：先写一行日志，嵌套记录动作，记一个标记，失败一次，再写一行日志。
    unfinished 时再开始一个不结束的动作。
    给了 release_file 时（#356），最后在嵌套的「等待放行」「检查放行文件」里等到这个文件出现才结束，
    让测试在节点执行中看到正在做的动作。

    ctx.action、ctx.mark 从 SDK 0.4.0 起才有：在上一个 Release 的 SDK 上这个节点不能运行。
    """
    ctx.log.info("动作前")
    with ctx.action("下单", 订单="1001") as order:
        ctx.mark("收到第一笔成交", 订单="1001")
        with ctx.action("风控检查"):
            pass
        order.note(回报="已成交")
    with ctx.action("下单", 订单="1002") as order:
        order.fail("拒单：余额不足")
    if unfinished:
        ctx.action.start("从不结束", 订单="1003")
    ctx.log.info("动作后")
    if release_file:
        with ctx.action("等待放行", 文件=os.path.basename(release_file)):
            with ctx.action("检查放行文件"):
                while not os.path.exists(release_file):
                    time.sleep(0.05)


@node(title="带 secret 值的动作文字", outputs=[])
def actions_with_secret_texts(ctx: Context, token: str) -> None:
    """名称、字段的键和值、失败原因里，secret 值正好跨在各自的上限处（#583）：SDK 不能把它切成两半，
    控制面才能先打码再截断。一个动作以失败结束（失败原因），一个动作留着不结束（摘要里「正在做」）。

    ctx.action 从 SDK 0.4.0 起才有：在上一个 Release 的 SDK 上这个节点不能运行。
    """
    from sfly import actions

    key = "k" * (actions.MAX_NAME_CHARS - 10) + token
    value = "v" * (actions.MAX_VALUE_CHARS - 10) + token
    with ctx.action("n" * (actions.MAX_NAME_CHARS - 10) + token, **{key: value}) as order:
        order.fail("r" * (actions.MAX_REASON_CHARS - 10) + token)
    ctx.action.start("m" * (actions.MAX_NAME_CHARS - 10) + token)


@node(title="上报数值", outputs=[])
def report_numbers(ctx: Context, current: str, total: str, price: str) -> None:
    """数值经过 Agent 保持不变的测试用（#450）：把 current、total 读成浮点数交给 ctx.progress，
    把 price 读成浮点数作为动作的字段（Python 把它写成字符串）。三个都用字符串传入：
    只测事件管道，不经过 Agent 读输入的那一步。

    ctx.action 从 SDK 0.4.0 起才有：在上一个 Release 的 SDK 上这个节点不能运行。
    """
    ctx.progress(float(current), float(total), "数值")
    with ctx.action("下单", 价格=float(price)):
        pass


@node(title="最长的动作摘要", outputs=[])
def actions_max(ctx: Context) -> None:
    """动作摘要最长时的测试用（#356）：正在做的、最近结束的、最近失败的都列满，名称、字段、失败原因都取上限，
    字符都是汉字（UTF-8 里三个字节），节点退出时 SDK 发出的那一份摘要有几百 KiB。

    ctx.action 从 SDK 0.4.0 起才有：在上一个 Release 的 SDK 上这个节点不能运行。
    """
    from sfly import actions

    fields: dict[str, Any] = {
        f"字段{i}": "值" * actions.MAX_VALUE_CHARS for i in range(actions.MAX_FIELDS)
    }
    pad = actions.MAX_NAME_CHARS - 2
    for i in range(actions.RECENT_LIMIT + actions.RECENT_FAILED_LIMIT):
        ctx.action.start(f"{i:02d}" + "拒" * pad, **fields).fail("因" * actions.MAX_REASON_CHARS)
    for i in range(actions.RUNNING_LIMIT):
        ctx.action.start(f"{i:02d}" + "做" * pad, **fields)


@node(title="连发动作摘要", outputs=[])
def summary_burst(ctx: Context, count: int, interval: float) -> None:
    """Agent 转发动作摘要的测试用（#356）：不经过 ctx.action，直接往事件管道写 count 份摘要，
    间隔 interval 秒，第 i 份的 total 是 i。SDK 自己每秒最多发一份，这里写得比它快，
    测的是 Agent 一侧只转发最新的一份。
    """
    with open(os.environ["SFLY_EVENTS"], "a", encoding="utf-8") as events:
        for i in range(1, count + 1):
            summary = {
                "type": "action_summary",
                "ts": int(time.time() * 1000),
                "mono": sfly.context.monotonic_ms(),
                "total": i,
                "reported": i,
                "capped_ts": None,
                "capped_mono": None,
                "names": [],
                "running": [],
                "recent": [],
                "recent_failed": [],
            }
            events.write(json.dumps(summary, ensure_ascii=False) + "\n")
            events.flush()
            time.sleep(interval)


@node(title="直接写动作事件", outputs=[])
def raw_events(ctx: Context, lines: list[Any]) -> None:
    """Agent 转发动作明细的测试用（#357）：不经过 ctx.action，把 lines 的每一项写成事件管道里的
    一行，一次写完。对象项按 JSON 写（键的先后照输入，中文不转义），字符串项原样写，所以可以写出
    SDK 不会写的内容：没有 mono 的事件、结果不认识的事件、缺必需字段的事件。
    """
    text = "".join(
        (line if isinstance(line, str) else json.dumps(line, ensure_ascii=False)) + "\n"
        for line in lines
    )
    with open(os.environ["SFLY_EVENTS"], "a", encoding="utf-8") as events:
        events.write(text)
        events.flush()


#: `action_flood` 写的 ts、mono 的基数：一个固定的过去时刻，和读到它时的时钟都差得很远。
FLOOD_TS = 1_700_000_000_000
FLOOD_MONO = 1_000_000


@node(title="大量动作明细", outputs=[])
def action_flood(ctx: Context, count: int, release_file: str = "") -> None:
    """Agent 转发动作明细的测试用（#357）：不经过 ctx.action（SDK 自己最多上报 10 万个），尽快往
    事件管道写出 id 从 1 到 count 的 count 个动作和标记，写完立即退出：奇数 id 是动作
    （`action_start` 紧跟着它的 `action_end`），偶数 id 是标记。每个事件的 ts 是 `FLOOD_TS + id`、
    mono 是 `FLOOD_MONO + id`。给了 release_file 时先等到这个文件出现再写。
    """
    while release_file and not os.path.exists(release_file):
        time.sleep(0.02)
    with open(os.environ["SFLY_EVENTS"], "a", encoding="utf-8") as events:
        for first in range(1, count + 1, 2000):
            lines = []
            for i in range(first, min(first + 2000, count + 1)):
                ts, mono = FLOOD_TS + i, FLOOD_MONO + i
                if i % 2:
                    lines.append(
                        f'{{"type":"action_start","ts":{ts},"mono":{mono},"id":{i},'
                        f'"parent":null,"depth":0,"name":"下单","fields":{{}}}}\n'
                    )
                    lines.append(
                        f'{{"type":"action_end","ts":{ts},"mono":{mono},"id":{i},'
                        f'"result":"success","reason":null,"fields":{{}}}}\n'
                    )
                else:
                    lines.append(
                        f'{{"type":"mark","ts":{ts},"mono":{mono},"id":{i},'
                        f'"parent":null,"depth":0,"name":"成交","fields":{{}}}}\n'
                    )
            events.write("".join(lines))
            events.flush()


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


@node(title="产物上限", outputs=["refs", "limit", "refused", "limit_env"])
def artifact_limit(
    ctx: Context,
    files: dict[str, str] | None = None,
    direct: dict[str, int] | None = None,
    catch_limit: bool = False,
    fail: bool = False,
) -> dict[str, Any]:
    """产物上限测试用（#477）：把 files（名称 → 文本内容）保存为产物，direct（名称 → 字节数）
    不经过 `save`、直接往产物目录里写这么大的文件（兜住不检查上限的写法）；fail 时保存后抛出异常。
    catch_limit 时接住 `ArtifactLimitExceeded`，把没保存的名称放进输出的 refused。
    输出的 limit 是节点里读到的 `ctx.artifacts.limit_bytes`（上一个 Release 的 SDK 没有它：None）。
    """
    refs: dict[str, str] = {}
    refused: list[str] = []
    for name, content in (files or {}).items():
        try:
            refs[name] = ctx.artifacts.save(name, content)
        except ArtifactLimitExceeded:
            if not catch_limit:
                raise
            refused.append(name)
    for name, size in (direct or {}).items():
        ctx.artifacts.path(name).write_bytes(b"x" * size)
    if fail:
        raise RuntimeError("保存产物后失败")
    return {
        "refs": refs,
        "limit": getattr(ctx.artifacts, "limit_bytes", None),
        "refused": refused,
        # 执行器的环境变量原文：Agent 在上限是 0（旧版本控制面没带）时不设置它
        # （SDK 把 "0" 也当作没有上限，看不出区别）。
        "limit_env": os.environ.get("SFLY_ARTIFACT_LIMIT_BYTES"),
    }


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


@node(title="一长行", outputs=[])
def long_line(ctx: Context, head: int, value: str, tail: int, stream: str = "stdout") -> None:
    """超长行拆分测试用（#622）：往标准输出（stream 是 stderr 时往标准错误）写一行：
    head 个 a、value、tail 个 b。"""
    out = sys.stderr if stream == "stderr" else sys.stdout
    out.write("a" * head + value + "b" * tail + "\n")
    out.flush()


@node(title="异常文字很长", outputs=[])
def big_exception(ctx: Context, size: int) -> None:
    """失败文字有上界的测试用（#723）：抛出一条 size 个字符的异常。"""
    raise RuntimeError("e" * size)


@node(title="直接写 output.json", outputs=[])
def raw_output(
    ctx: Context, kind: str, size: int, traceback_size: int = 0, char: str = "m"
) -> None:
    """Agent 自己判断输出大小的测试用（#723）：绕过执行器的检查（也是旧版本的执行器的写法：说明和堆栈都不限长），
    直接写 output.json 然后退出。kind 是 success（outputs 里一个 size 个字符的文字）或 failed（message 是 size 个
    `char`，traceback 是 traceback_size 个 `char`）。"""
    if kind == "success":
        doc: dict[str, Any] = {"status": "success", "outputs": {"text": "x" * size}}
    else:
        doc = {
            "status": "failed",
            "error": {"message": char * size, "traceback": char * traceback_size},
        }
    with open(os.environ["SFLY_OUTPUT"], "w", encoding="utf-8") as output:
        json.dump(doc, output)
    os._exit(0)


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


#: action_rate 依次使用的动作名称：4 种，每种都不超过每种名称的上限（5 万个），合计会超过 10 万个。
RATE_ACTION_NAMES = ("下单", "撤单", "查询", "回报")


@node(
    title="定速动作",
    outputs=["count", "elapsed", "max_behind_ms", "max_call_ms"],
)
def action_rate(ctx: Context, rate: float = 5000, seconds: float = 10) -> dict[str, Any]:
    """性能测试用（pnpm perf，#357）：按每秒 rate 个动作记录 seconds 秒，第 i 个是
    `with ctx.action(RATE_ACTION_NAMES[i % 4], 序号=i + 1)`，每个动作往事件管道写两行
    （开始、结束）。

    每 100 个对一次时间，提前了就等到计划时刻。返回动作个数、实际用时（秒）、
    比计划落后的最长时间与单次 `ctx.action()`（进入加离开 with）的最长耗时（毫秒）。
    """
    total = int(rate * seconds)
    pacer = _Pacer(rate)
    max_call = 0.0
    for i in pacer.ticks(total):
        before = time.perf_counter()
        with ctx.action(RATE_ACTION_NAMES[i % len(RATE_ACTION_NAMES)], 序号=i + 1):
            pass
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
