"""按进程号、进程名或命令行找进程（内部实现）：`processes.find_processes` 和
`resources.monitor_processes` 用它，不对外承诺。

- `ProcessTarget`：一个找进程的条件（`pid`、`name`、`match` 里的一项）；
- `ProcessFinder`：按一组目标找进程，每个目标各自匹配零到多个进程，可以连同子孙进程；
  按 `pid` 指定的目标第一次找到时记住进程对象（pid 被别的进程复用时不会把新进程当成它），
  按 `name`、`match` 指定的目标每次都重新找（进程重启之后能找到新的）。

公开的只有 `processes.find_processes`：两步的 `roots()` → `processes(roots)`、「记住第一次找到的
进程」这些语义留作内部实现，以后要公开是兼容的新增，公开了就收不回来。
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, TypeVar

import psutil

from sfly_std import _params, _process

T = TypeVar("T", int, str)


@dataclass(frozen=True)
class ProcessTarget:
    """一个找进程的条件：`pid`（进程号）、`name`（进程名，完全相同）或 `match`（命令行正则，
    部分匹配）；`kind` 说明是哪一种，另外三个字段只有对应的那种有值。"""

    kind: Literal["pid", "name", "match"]
    #: `kind` 为 `"pid"` 时的进程号。
    pid: int = 0
    #: `kind` 为 `"name"`、`"match"` 时的进程名、正则的原文。
    text: str = ""
    #: `kind` 为 `"match"` 时编译好的正则。
    pattern: re.Pattern[str] | None = None

    @property
    def label(self) -> str:
        """日志和错误信息里的写法，例如 `pid 123`、`name "nginx"`、`match "server\\.py"`。"""
        if self.kind == "pid":
            return f"pid {self.pid}"
        return f"{self.kind} {json.dumps(self.text, ensure_ascii=False)}"

    def matches(self, proc: psutil.Process, name: str, command: str) -> bool:
        """进程 `proc`（进程名 `name`、命令行 `command`，各参数以空格连接）是否满足这个条件。"""
        if self.kind == "pid":
            return proc.pid == self.pid
        if self.kind == "name":
            return name == self.text
        assert self.pattern is not None
        return self.pattern.search(command) is not None


def parse_targets(
    pid: int | Sequence[int] | None,
    name: str | Sequence[str] | None,
    match: str | Sequence[str] | None,
) -> list[ProcessTarget]:
    """把 `pid`、`name`、`match` 参数（单个值或列表）变成条件，按这个顺序；
    写法不对时抛出 ValueError。"""
    pids, names, patterns = as_list(pid), as_list(name), as_list(match)
    if not (pids or names or patterns):
        raise ValueError("至少要给出 pid、name、match 中的一个")
    for p in pids:
        if p <= 0:
            raise ValueError(f"pid 必须是正整数，实际为 {p}")
    return (
        [ProcessTarget("pid", pid=p) for p in pids]
        + [ProcessTarget("name", text=n) for n in names]
        + [ProcessTarget("match", text=m, pattern=_params.regex("match", m)) for m in patterns]
    )


def as_list(value: T | Sequence[T] | None) -> list[T]:
    """单个值或列表（JSON 数组）统一成列表。"""
    if value is None:
        return []
    if isinstance(value, (int, str)):
        return [value]
    return list(value)


class ProcessFinder:
    """按目标（`pid`、`name`、`match` 里的每一项）找进程；`include_children` 时加上全部子孙进程。

    每个目标各自匹配零到多个进程：`roots()` 按目标给出匹配到的进程（某个目标的列表为空，说明它现在
    没有进程），`processes(roots)` 展开成 pid → 进程。按 `pid` 指定的目标第一次找到时记住进程对象，
    之后 pid 被别的进程复用时不会把新进程当成它；按 `name`、`match` 指定的目标每次都重新找，
    进程重启之后能找到新的。写法不对（一个目标都没有、`pid` 不是正整数、正则不合法）时构造函数抛出
    `ValueError`。`include_children` 默认 True，和 `find_processes`、`monitor_processes` 一致。
    """

    #: 找进程的条件，按 `pid`、`name`、`match` 的顺序。
    targets: tuple[ProcessTarget, ...]

    def __init__(
        self,
        *,
        pid: int | Sequence[int] | None = None,
        name: str | Sequence[str] | None = None,
        match: str | Sequence[str] | None = None,
        include_children: bool = True,
    ) -> None:
        self.targets = tuple(parse_targets(pid, name, match))
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
