# 跨 Agent 处理文件

一个常见的场景：A 机器上的被测系统一边运行一边写日志，日志按大小或时间轮转，一次运行能写出上百 GB；清洗这些日志很占 CPU 和磁盘，不能和被测系统放在同一台机器上，要放到 B 机器上做，而且只清洗已经不再续写的文件。A 和 B 网络互通，但没有共享存储。

节点输出（不超过 1 MB）和产物（任务结束后才上传）都传不了这个量级，两条链之间也不能传值。做法是让 B 上的清洗节点直接访问 A 上的文件：节点通过 **Agent 能力**（[开发节点](sdk-reference.md) 的「`ctx.agent()`：Agent 能力」）监听 A 上的日志目录、把文件下载到 B 本地、清洗完删除 A 上的源文件。两台 Agent 直接连接，数据不经过控制面。

本页以日志清洗为完整示例：清洗节点的代码、场景怎么编排，以及怎样判断一个文件已经不再续写。不想写代码时用标准节点 `watch_files`，见最后一节。

## 准备

- A、B 两台 Agent 都是 0.2.0 及以上，节点包在 `[tool.sfly]` 里声明 `requires-sdk = ">=0.2.0"` 和 `requires-agent = ">=0.2.0"`（见 [开发节点](sdk-reference.md) 的「版本」）。
- B 能连到 A 的 Agent 端口（默认 50052，防火墙要放行；端口和对外地址的配置见 [安装 Agent](install-agent.md)）。这些接口没有认证，只应在内网使用。
- 清洗节点把要访问的 A 声明成「Agent」类型的参数（`source: AgentName`），在检查器里从 Agent 下拉框选择。节点只能访问这样拿到的 Agent 和自己所在的 Agent。
- 平台只告诉节点文件上发生了什么（新建、改名、写完关闭、修改、删除），**不判断文件是否写完**。哪些文件算写完，由你按被测系统的轮转方式决定（见下文「怎样判断文件不再续写」）。

## 清洗节点

下面的节点派到 B 上运行，参数 `source` 选 A。它监听 A 上的日志目录，把轮转出来的日志（`app.log.1`、`app.log.2`……，正在写的 `app.log` 不匹配）逐个下载到 B 本地、清洗（去掉 DEBUG 行再压缩）、删除 A 上的源文件，一直运行到被停止子流程节点停止：

```python
"""日志清洗：在 B 上运行，持续把 A 上轮转出来的日志拉到本地清洗，清洗完删除 A 上的源文件。"""

from __future__ import annotations

import gzip
import queue
import threading
from pathlib import Path

from sfly import (
    Agent,
    AgentError,
    AgentFileMoved,
    AgentFileNotFound,
    AgentName,
    Context,
    FileId,
    FileInfo,
    Metric,
    WatchSnapshot,
    node,
)


@node(
    title="清洗日志",
    metrics=[
        Metric("cleaned_files", kind="counter", description="已经清洗的文件数"),
        Metric("cleaned_bytes", "B", kind="counter", description="已经清洗的原始日志字节数"),
    ],
    primary_metric="cleaned_bytes",
)
def clean_logs(
    ctx: Context,
    source: AgentName,
    directory: str = "/srv/app/logs",
    pattern: str = "app.log.*",
    out_dir: str = "/data/cleaned",
) -> None:
    """监听 source 上的 directory，把轮转出来的日志（pattern）逐个下载到本地、清洗、
    删除源文件，直到被停止子流程节点停止。"""
    agent = ctx.agent(source)
    out = Path(out_dir)
    changes: queue.Queue = queue.Queue()

    def read_changes() -> None:
        # 后台线程只管读监听，主线程下载、清洗：清洗一个大文件期间事件不会在 Agent 上堆积。
        try:
            for item in agent.files.watch(directory, pattern):
                changes.put(item)
        except BaseException as error:
            changes.put(error)

    threading.Thread(target=read_changes, daemon=True).start()

    present: dict[FileId, FileInfo] = {}  # 现在匹配 pattern 的文件
    done: dict[FileId, int] = {}  # 已经清洗过的文件：文件标识 → 当时的大小
    cleaned = cleaned_bytes = 0
    while True:
        # 等到有变化，再把队列里已有的都取出来。
        items = [changes.get()]
        while not changes.empty():
            items.append(changes.get_nowait())
        for item in items:
            if isinstance(item, BaseException):
                raise item
            if isinstance(item, WatchSnapshot):
                # 以快照为准：重连、事件队列溢出之后会再给一份（item.missed 为 True）。
                present = {f.id: f for f in item.files}
                done = {i: size for i, size in done.items() if i in present}
            elif item.kind == "deleted":
                present.pop(item.id, None)
                done.pop(item.id, None)  # 文件标识以后可能被新文件重用
            else:
                present[item.id] = item.file  # 改名后文件标识不变，路径跟着更新

        for file in sorted(present.values(), key=lambda f: f.path):
            if done.get(file.id) == file.size:
                continue  # 清洗过了：按「文件标识 + 大小」去重
            raw = out / "raw" / Path(file.path).name
            try:
                got = agent.files.download(file.path, raw)
            except (AgentFileNotFound, AgentFileMoved):
                continue  # 被删除，或在连接中断期间移到了别处：等监听告诉我们新的路径
            except AgentError as error:
                if error.kind != "failed":
                    raise
                ctx.log.warning("%s 下载期间还在变化，之后再试：%s", file.path, error)
                continue
            clean(raw, out / f"{raw.name}.gz")
            raw.unlink()
            done[got.id] = got.size
            delete_if_unchanged(agent, got)
            cleaned += 1
            cleaned_bytes += got.size
            ctx.metric("cleaned_files", cleaned)
            ctx.metric("cleaned_bytes", cleaned_bytes)
            ctx.log.info("清洗了 %s（%d 字节）", got.path, got.size)


def clean(raw: Path, target: Path) -> None:
    """清洗：去掉 DEBUG 行，压缩。先写临时文件再改名，被停止时不留下半截的结果。"""
    partial = target.with_name(f".{target.name}.partial")
    try:
        with raw.open("rb") as src, gzip.open(partial, "wb") as dst:
            for line in src:
                if b" DEBUG " not in line:
                    dst.write(line)
        partial.rename(target)
    finally:
        partial.unlink(missing_ok=True)


def delete_if_unchanged(agent: Agent, got: FileInfo) -> None:
    """删除已经清洗的源文件；下载之后它被改名、换成了另一个文件或又写入了时不删。"""
    try:
        now = agent.files.stat(got.path)
    except AgentFileNotFound:
        return
    if (now.id, now.size, now.mtime_ns) == (got.id, got.size, got.mtime_ns):
        agent.files.delete(got.path)
```

要点：

- **监听**（`files.watch`）先给出一份快照（当前匹配的文件），之后持续给出事件。读监听放在后台线程里：主线程清洗一个几 GB 的文件要好一会儿，这期间事件照常被取走；不这样做，事件在 A 的 Agent 上堆积到溢出，只能重新给一份快照。
- **以快照为准、按文件标识去重**：两台 Agent 之间的连接中断后自动重连、或者事件来不及发出时，会重新给一份 `missed=True` 的快照，之前的一些事件没有送到。所以不要假设每个变化都有事件，每次收到快照都以它为准重建「现在有哪些文件」。文件标识（设备号 + inode）在改名后不变：`app.log.1` 轮转成 `app.log.2` 时还是同一个文件，不会再清洗一次。文件被删除后标识可能被新文件重用，所以删除时也从 `done` 里去掉。
- **下载**（`files.download`）由 B 的 Agent 直接把数据写到本地路径，不经过节点进程，大文件的速度不受 Python 影响；连接中断时自动从断点续传。先写临时文件、完成并核对大小后才改名，本地不会出现半截文件。下载期间源文件被改名（例如又轮转了一次）不影响下载，返回的 `got.path` 是它现在的路径；被改写、截短时抛出 `AgentError`（`kind` 为 `failed`），这里留到之后再试。
- **删除**（`files.delete`）之前再查看一次：下载之后同一个路径上可能已经是另一个文件（按序号轮转时 `app.log` 改名成了新的 `app.log.1`）。查看和删除之间仍有很短的间隔，轮转恰好发生在这里时会删错，要完全避免就不要删，或者让被测系统把轮转出来的文件用不会重复的名字（例如带时间戳）。
- **被停止时**节点里抛出 `sfly.Cancelled`：正在进行的下载立即结束（临时文件被删除），清洗的结果先写临时文件再改名，所以不会留下半截的结果；已经清洗完的都保留。下次运行时 A 上剩下的文件会重新出现在快照里，接着清洗。
- A 要是 Linux 上的 Agent，日志目录在本地文件系统上：监听用 inotify 实现，NFS 这类网络文件系统上看不到别的机器做的修改。

本地调试时把 A 映射到一个本地目录（`run_node(..., agents={"a-01": tmp_path / "a"})`，见 [开发节点](sdk-reference.md) 的「本地调试、测试与联调」），在测试里往这个目录写文件、改名，验证清洗节点的逻辑；之后用 `sfly dev` 在真实的两台 Agent 上联调。

## 场景怎么编排

清洗要和 A 上的测试同时进行，所以放在子流程里：

```text
主链（A）：入口 → 启动被测系统 → 异步任务 → 压测 → 让最后的日志轮转出来 → 等清洗追上 → 停止子流程「清洗」(always) → 清理(always)
                                     │
                                     └─触发─▶ 子流程「清洗」（B）：子流程入口 → 清洗日志
```

1. 新建子流程「清洗」，放清洗节点，节点的 Agent 选 B，参数 `source` 选 A。
2. 主链上的节点选 A。启动被测系统之后放异步任务节点，触发「清洗」；接着放压测。
3. 压测之后，停止子流程之前，**确认要清洗的文件都已经轮转出来、清洗完**（见下一段）。
4. 放停止子流程节点，选「清洗」，打开 always：前面失败时也照样停止清洗，否则运行一直结束不了。停掉被测系统、删除日志目录这类清理放在它**之后**。
5. 清洗节点会一直运行到被停止，节点超时默认 1 小时：压测更长时，在检查器里把它的超时调大。

清洗节点被停止时记为「已停止」，不算失败；子流程和运行照常记为成功。子流程什么时候停，平台不替你决定，**被测系统停了不代表日志已经写完**：

- 最后一个文件还叫 `app.log`，没有轮转出来，不匹配 `app.log.*`。要清洗它，就在停止之前让被测系统轮转一次（例如发 logrotate 要求的信号、或者停掉被测系统后在 A 上把它改名），或者等它不再变化后单独处理。
- 被测系统可能还有没刷到磁盘的缓冲，退出时才写出最后一段。
- 清洗比产生慢时，压测结束时 A 上还排着没清洗的文件。清洗完就删除源文件时，可以在主链上用一个 Shell 节点（选 A）等日志目录里不再有 `app.log.*`，再停止子流程；不删源文件时，让清洗节点每清洗完一个就在 B 上写一个标记，主链等标记齐了再停。
- 也可以让清洗节点自己结束：例如被测系统写完后留下一个约定的文件（`app.log.end`），清洗节点看到它、清洗完剩下的文件就 `return`，这时不需要停止子流程节点；或者给节点一个时长参数，到期自己结束。

## 怎样判断文件不再续写

没有通用的答案，取决于被测系统怎样写、怎样轮转日志。常见的几种做法和各自的坑：

| 做法 | 怎么做 | 坑 |
|---|---|---|
| 轮转改名之后才处理 | `pattern` 只匹配轮转出来的名字（`app.log.*`），正在写的 `app.log` 不匹配 | 有的程序改名后还拿着旧文件的句柄继续写一会儿，直到收到重新打开的信号（例如 logrotate 的 `postrotate` 里发 `SIGHUP`、nginx 的 `USR1`），这段时间里改名后的文件还在变大。logrotate 的 `copytruncate` 不改名：复制出 `app.log.1` 的过程中它就已经出现了，复制完原文件才被截断。按序号轮转时名字会移位（`app.log.1` → `app.log.2`），要按文件标识而不是路径去重 |
| 至少 N 秒没有修改 | 记下最后一次看到文件变化（`created`、`modified`、`closed` 事件）的时刻，满 N 秒没有新的变化才处理；处理前再 `stat` 一次，和上次看到的大小、修改时间比较 | 写入方停顿超过 N 秒（流量低、GC 停顿、压测的间歇）时，没写完的文件也被当成写完；N 太大则处理得晚，磁盘占用更高。计时要用本机的单调时钟（`time.monotonic()`），**不要**拿 `FileInfo.mtime` 和本机的 `time.time()` 比较：那是 A 的时钟，两台机器的时钟不一定一致 |
| 写完关闭 | 收到 `closed` 事件（以写方式打开的文件被关闭）才处理 | 不代表不会再写：有的日志库每写一条就打开、关闭一次，同一个文件会收到很多次 `closed`；关闭后也可以再以追加方式打开续写 |
| 写入方给出信号 | 被测系统写完一个文件后再写一个标记（`app.log.1.done`），或者先写临时名、写完再改名为正式名；节点只处理有标记的、或者正式名的文件 | 最可靠，但要被测系统配合；标记文件本身也会出现在监听里，`pattern` 要把它们区分开 |
| 被测系统结束了 | 主链上压测结束后才处理 | 结束不代表写完：最后一个文件没有轮转出来、缓冲还没有刷盘（见上一节）；而且等到结束才开始，失去了边测边清洗的意义 |

几种做法可以组合，例如「已经轮转改名，并且至少 30 秒没有修改」。不管用哪种，都要能容忍判断错：下载期间文件被改写时 `files.download` 会失败而不是给出半截内容，删除前再比较一次属性，按「文件标识 + 大小」去重——同一个文件后来又变大了，就再处理一次。

## 不写代码：标准节点 `watch_files`

清洗工具本身是现成的程序、只需要读一个本地目录时，用标准节点 `watch_files`（见 [标准节点](standard-nodes.md)）代替上面的监听和下载：它放在子流程里、派到 B 上，持续把 A 上符合条件的文件拉到 B 的本地目录，条件是文件名匹配通配符，可以再加「至少 N 秒没有修改」；每个文件只拉一次，可以拉完后删除 A 上的源文件，运行页面上能看到已拉取的文件数、字节数和速率。被停止子流程节点停止时记为「已停止」。B 上处理这个目录的节点要跳过以 `.` 开头的临时文件。

只在最后一次性取回文件时（例如压测结束后把剩下的日志都拉回来），用 `pull_files`。
