"""`watch_files`：持续把另一台 Agent 上符合条件的文件拉到本地目录，可选拉完后删除源文件。

- 后台线程读监听（`files.watch`）的快照和事件，放进本地队列，主线程按条件逐个下载：
  节点下载大文件时事件不会在 Agent 上堆积溢出；
- 哪些文件该拉、拉过没有，记在 `_Files` 里：按「文件标识 + 大小」去重，快照（包括重连后
  `missed` 的快照）为准；
- 「至少 N 秒没有修改」用本机的单调时钟计时（最后一次看到它变化的时刻），不拿那台 Agent 的
  修改时间和本机时间比；下载前再查看一次，和上次看到的属性比较；
- 下载、删除源文件、本地路径列表的截断共用 `_pull.py`。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `watch_files` 一节。
"""

from __future__ import annotations

import queue
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict

from sfly import (
    Agent,
    AgentError,
    AgentFileMoved,
    AgentFileNotFound,
    AgentName,
    AgentTimeout,
    AgentUnreachable,
    Context,
    FileEvent,
    FileId,
    FileInfo,
    Metric,
    WatchSnapshot,
    node,
)
from sfly_std import _pull
from sfly_std._sampling import validate_duration

#: 上报指标的间隔（秒）。
METRIC_INTERVAL = 1.0
#: 拉取失败但可以再试（连接中断、文件还在变化）时，隔多久再试这个文件（秒）。
RETRY_DELAY = 2.0
#: 监听的连接中断、那台 Agent 重连超时后，重新开始监听的间隔：从这里起每次加倍，最多 `MAX_BACKOFF`。
FIRST_BACKOFF = 1.0
MAX_BACKOFF = 10.0


class WatchFilesOutputs(TypedDict):
    count: int
    total_bytes: int


@node(
    title="持续拉取文件",
    metrics=[
        Metric("pulled_files", kind="counter", description="已经拉取的文件数"),
        Metric("pulled_bytes", "B", kind="counter", description="已经拉取的文件的总字节数"),
        Metric("bytes_per_s", "B/s", description="当前的拉取速率（含正在拉取的文件）"),
    ],
    primary_metric="bytes_per_s",
)
def watch_files(
    ctx: Context,
    source: AgentName,
    directory: str,
    local_dir: str,
    pattern: str = "*",
    stable: float | None = None,
    delete_source: bool = False,
    duration: float | None = None,
) -> WatchFilesOutputs:
    """持续把 Agent `source` 上目录 `directory` 下文件名匹配 `pattern` 的文件
    拉到本地目录 `local_dir`：启动时已有的和之后出现的都拉，每个文件（文件标识 + 大小）只拉一次。

    - `stable`：文件至少这么多秒没有修改才拉；不设置时一出现就拉（`pattern` 应只匹配不再写入的文件，
      例如轮转后的 `app.log.*`）；
    - `delete_source`：每拉完一个文件就删除源文件；
    - `duration`：运行多少秒后成功结束，输出拉取的文件数 `count` 和总字节数 `total_bytes`；
      不设置时一直运行，直到被停止子流程节点停止或运行被取消。

    指标 `pulled_files`、`pulled_bytes`（累计）和 `bytes_per_s`（当前速率，主指标）。
    """
    if not local_dir:
        raise ValueError("local_dir 不能为空")
    if stable is not None and stable < 0:
        raise ValueError(f"stable 不能小于 0，实际为 {stable:g}")
    validate_duration(duration)
    agent = ctx.agent(source)
    root = Path(local_dir).absolute()
    pattern = pattern or "*"
    started = time.monotonic()
    deadline = None if duration is None else started + duration
    condition = "一出现就拉取" if not stable else f"至少 {stable:g} 秒没有修改才拉取"
    until = "直到被停止" if duration is None else f"运行 {duration:g} 秒"
    ctx.log.info(
        "监听 Agent %s 的 %s 下匹配 %s 的文件，%s，拉到 %s；%s",
        source,
        directory,
        pattern,
        condition,
        root,
        until,
    )
    events = _Watching(ctx, agent, source, directory, pattern)
    files = _Files(stable or 0.0)
    stats = _Stats(ctx, started)
    puller = _Puller(ctx, agent, files, stats, _LocalNames(root, directory), delete_source)
    while True:
        files.apply(events.take(timeout=0))
        now = time.monotonic()
        if deadline is not None and now >= deadline:
            break
        file = files.next_ready(now)
        if file is None:
            wake = min(files.next_wake(now), stats.next_report, *([deadline] if deadline else []))
            files.apply(events.take(timeout=max(0.0, wake - now)))
            stats.maybe_report()
            continue
        puller.pull(file)
        stats.maybe_report()
    stats.report()
    ctx.log.info("拉取了 %d 个文件，共 %d 字节", stats.files, stats.bytes)
    return {"count": stats.files, "total_bytes": stats.bytes}


@dataclass
class _Puller:
    """拉取已经满足条件的文件；可以再试的失败（连接中断、文件还在变化）留到之后再拉。"""

    ctx: Context
    agent: Agent
    files: _Files
    stats: _Stats
    local: _LocalNames
    delete_source: bool

    def pull(self, file: FileInfo) -> None:
        ctx, files, stats = self.ctx, self.files, self.stats
        try:
            got = self._download(file)
        except (AgentUnreachable, AgentTimeout) as error:
            stats.failed()
            ctx.log.warning("拉取 %s 时连接中断，%g 秒后再试：%s", file.path, RETRY_DELAY, error)
            files.retry_later(file, RETRY_DELAY)
            return
        if got is None:
            return
        info, target = got
        files.pulled(info)
        self.local.pulled(info, target)
        stats.pulled(info.size)
        ctx.log.info("拉取了 %s（%d 字节）→ %s", info.path, info.size, target)
        if self.delete_source:
            self._delete(info)

    def _download(self, file: FileInfo) -> tuple[FileInfo, Path] | None:
        """下载 `file`，返回下载完成时的属性和本地路径；留到之后再拉时为 None。
        连接中断（包括判断失败原因时）抛出 `AgentUnreachable` / `AgentTimeout`。"""
        ctx, agent, files, stats = self.ctx, self.agent, self.files, self.stats
        # 事件可能还在路上：下载前再查看一次，变了就重新计时。
        if files.stable and not _unchanged(agent, file, files):
            return None
        target = self.local.target(file)
        try:
            # 拉取期间它被改名（日志又轮转了一次）不影响下载：got.path 是它现在的路径。
            got = _pull.download(agent, file, target, stats.transferring)
        except (AgentUnreachable, AgentTimeout):
            raise
        except AgentFileMoved:
            # 连接中断期间它被移到了别的目录，续传找不到它：和已经不在这个路径上一样处理。
            got = None
        except AgentError as error:
            stats.failed()
            if error.kind != "failed" or _unchanged(agent, file, files):
                raise
            # 不设置 stable 时也不马上重拉一个还在写的文件。
            files.retry_later(file, RETRY_DELAY)
            ctx.log.info("%s 在拉取期间变化了，之后再拉：%s", file.path, error)
            return None
        if got is None:
            # 被删除了，或被移到了别处：等监听的事件或快照告诉我们它在哪里。
            stats.failed()
            ctx.log.info("%s 已经不在这个路径上，跳过", file.path)
            files.retry_later(file, RETRY_DELAY)
            return None
        return got, target

    def _delete(self, got: FileInfo) -> None:
        try:
            deleted = _pull.delete_pulled(self.agent, got)
        except (AgentUnreachable, AgentTimeout) as error:
            self.ctx.log.warning("删除 %s 时连接中断，没有删除：%s", got.path, error)
            return
        if deleted == "changed":
            self.ctx.log.warning("%s 在拉取之后被改动或替换，没有删除", got.path)
        else:
            self.files.deleted(got.id)


def _unchanged(agent: Agent, file: FileInfo, files: _Files) -> bool:
    """再查看一次 `file`：路径上还是它、大小和修改时间都没变时为 True。变了的重新计时；
    路径上已经不是它（被删除、改名、替换）时过一会儿再看，等监听的事件或快照告诉我们它在哪里。"""
    try:
        now = agent.files.stat(file.path)
    except AgentFileNotFound:
        files.retry_later(file, RETRY_DELAY)
        return False
    if not _pull.changed(now, file):
        return True
    files.saw(now, changed=True)
    if now.id != file.id:
        files.retry_later(file, RETRY_DELAY)
    return False


# ---- 监听 ----


class _Watching:
    """在后台线程里读监听的快照和事件，放进本地队列（节点下载大文件时事件不会在 Agent 上堆积）。

    第一次监听失败（连不上、目录不存在）时节点失败；之后连接中断、那台 Agent 重连超时，
    就隔一会儿重新开始监听，新的快照为准。
    """

    def __init__(
        self, ctx: Context, agent: Agent, source: str, directory: str, pattern: str
    ) -> None:
        self._ctx = ctx
        self._agent = agent
        self._source = source
        self._directory = directory
        self._pattern = pattern
        self._queue: queue.Queue[WatchSnapshot | FileEvent | BaseException] = queue.Queue()
        threading.Thread(target=self._run, name="watch_files", daemon=True).start()

    def take(self, timeout: float) -> Iterator[WatchSnapshot | FileEvent]:
        """等最多 `timeout` 秒，给出队列里现有的快照和事件；监听失败时抛出它的异常。"""
        try:
            item = self._queue.get(timeout=timeout) if timeout > 0 else self._queue.get_nowait()
        except queue.Empty:
            return
        while True:
            if isinstance(item, BaseException):
                raise item
            yield item
            try:
                item = self._queue.get_nowait()
            except queue.Empty:
                return

    def _run(self) -> None:
        delivered = False
        backoff = FIRST_BACKOFF
        while True:
            try:
                for item in self._agent.files.watch(self._directory, self._pattern):
                    delivered = True
                    backoff = FIRST_BACKOFF
                    self._queue.put(item)
                self._queue.put(RuntimeError("监听意外结束"))
                return
            except (AgentUnreachable, AgentTimeout) as error:
                if not delivered:
                    self._queue.put(error)
                    return
                self._ctx.log.warning(
                    "监听 Agent %s 的连接中断，%g 秒后重新开始监听：%s",
                    self._source,
                    backoff,
                    error,
                )
            except BaseException as error:
                self._queue.put(error)
                return
            time.sleep(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF)


# ---- 哪些文件该拉 ----


@dataclass
class _Known:
    """监听范围里的一个文件：最近看到的属性、最后一次看到它变化的时刻（本机单调时钟）、
    最早什么时候再试。"""

    info: FileInfo
    changed_at: float
    not_before: float = 0.0


class _Files:
    """监听范围里有哪些文件、哪些已经拉过（文件标识 → 拉取时的大小）。"""

    def __init__(self, stable: float) -> None:
        #: 文件至少这么多秒没有修改才拉（0 为一出现就拉）。
        self.stable = stable
        self._known: dict[FileId, _Known] = {}
        self._pulled: dict[FileId, int] = {}

    def apply(self, items: Iterator[WatchSnapshot | FileEvent]) -> None:
        for item in items:
            if isinstance(item, WatchSnapshot):
                self._snapshot(item.files)
            elif item.kind == "deleted":
                self.gone(item.id)
            else:
                self.saw(item.file, changed=item.kind != "moved")

    def _snapshot(self, files: tuple[FileInfo, ...]) -> None:
        """以快照为准：不在快照里的文件已经不在了；属性变了的重新计时。"""
        current = {f.id: f for f in files}
        for gone in set(self._known) - set(current):
            del self._known[gone]
        for gone in set(self._pulled) - set(current):
            del self._pulled[gone]
        for info in files:
            known = self._known.get(info.id)
            self.saw(info, changed=known is None or _pull.changed(info, known.info))

    def saw(self, info: FileInfo, *, changed: bool) -> None:
        """看到了文件的属性（`changed`：它刚变化过，重新计时）。"""
        known = self._known.get(info.id)
        now = time.monotonic()
        if known is None:
            self._known[info.id] = _Known(info, now)
            return
        known.info = info
        if changed:
            known.changed_at = now

    def gone(self, file: FileId) -> None:
        """文件已经不在了（被删除、移出监听范围）。它的标识以后可能被新文件重用，所以也忘掉拉过它。"""
        self._known.pop(file, None)
        self._pulled.pop(file, None)

    def deleted(self, file: FileId) -> None:
        """拉完之后我们删除了它。队列里可能还有删除之前的事件提到它（例如拉取期间它被改名），
        所以先记着拉过它，等监听报告它被删除（或快照里没有它）时再忘掉。"""
        self._known.pop(file, None)

    def pulled(self, info: FileInfo) -> None:
        self._pulled[info.id] = info.size

    def retry_later(self, info: FileInfo, delay: float) -> None:
        known = self._known.get(info.id)
        if known is not None:
            known.not_before = time.monotonic() + delay

    def _ready_at(self, known: _Known) -> float | None:
        """什么时候可以拉；已经拉过（同样的大小）时为 None。"""
        if self._pulled.get(known.info.id) == known.info.size:
            return None
        return max(known.changed_at + self.stable, known.not_before)

    def next_ready(self, now: float) -> FileInfo | None:
        """现在可以拉的文件里最早满足条件的一个。"""
        ready = [
            (at, known.info.path, known.info)
            for known in self._known.values()
            if (at := self._ready_at(known)) is not None and at <= now
        ]
        return min(ready, key=lambda r: r[:2])[2] if ready else None

    def next_wake(self, now: float) -> float:
        """下一个文件满足条件的时刻；没有等待中的文件时为无穷大。"""
        times = [at for known in self._known.values() if (at := self._ready_at(known)) is not None]
        return min(times, default=float("inf"))


# ---- 本地文件名 ----


class _LocalNames:
    """文件拉到本地的哪里：`local_dir` 下的同名文件。日志按序号轮转时，同一个名字先后是不同的文件
    （`app.log.1` 轮转成 `app.log.2`，新的 `app.log.1` 出现）：本次拉下来的另一个文件还在
    那个位置时不覆盖它，改用 `<名字>.~<n>~`。"""

    def __init__(self, root: Path, directory: str) -> None:
        self._root = root
        self._directory = directory
        self._owners: dict[Path, FileId] = {}

    def target(self, file: FileInfo) -> Path:
        target = _pull.local_path(self._directory, file.path, self._root)
        n = 1
        candidate = target
        while self._taken(candidate, file.id):
            candidate = target.with_name(f"{target.name}.~{n}~")
            n += 1
        return candidate

    def _taken(self, path: Path, file: FileId) -> bool:
        owner = self._owners.get(path)
        return owner is not None and owner != file and path.exists()

    def pulled(self, file: FileInfo, path: Path) -> None:
        self._owners[path] = file.id


# ---- 指标 ----


class _Stats:
    """已拉取的文件数、字节数和当前速率；指标每 `METRIC_INTERVAL` 秒最多上报一次。

    速率按两次上报之间传输的字节数算，包括正在拉取的文件已经下载的部分（几 GB 的文件拉一次要
    好一会儿，只算拉完的文件时速率忽高忽低），也包括拉到一半失败、之后重拉的部分。
    """

    def __init__(self, ctx: Context, started: float) -> None:
        self._ctx = ctx
        self.files = 0
        self.bytes = 0
        self._current = 0  # 正在拉取的文件已经下载的字节数
        self._moved = 0  # 一共传输了多少字节
        self._last_at = started
        self._last_moved = 0
        self.next_report = started + METRIC_INTERVAL

    def transferring(self, downloaded: int, _size: int) -> None:
        """正在拉取的文件的进度（`files.download` 的 `progress`）。"""
        self._moved += max(downloaded - self._current, 0)
        self._current = downloaded
        self.maybe_report()

    def failed(self) -> None:
        """正在拉取的文件没有拉完。"""
        self._current = 0

    def pulled(self, size: int) -> None:
        self._moved += max(size - self._current, 0)
        self._current = 0
        self.files += 1
        self.bytes += size

    def maybe_report(self) -> None:
        if time.monotonic() >= self.next_report:
            self.report()

    def report(self) -> None:
        now = time.monotonic()
        elapsed = max(now - self._last_at, 1e-6)
        self._ctx.metric("pulled_files", self.files)
        self._ctx.metric("pulled_bytes", self.bytes)
        self._ctx.metric("bytes_per_s", (self._moved - self._last_moved) / elapsed)
        self._last_at, self._last_moved = now, self._moved
        self.next_report = now + METRIC_INTERVAL
