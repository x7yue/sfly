#!/usr/bin/env python3
"""数据库迁移日志的检查（`pnpm lint:migrations`，规则见 CODING_STANDARDS.md「数据库」）。

drizzle 按 `apps/server/drizzle/meta/_journal.json` 里每条的 `when` 决定要不要执行一个迁移：
只执行 `when` 比库里最后一个已执行迁移新的，比的不是编号。几个 PR 同时加迁移、后合入的一方重新
排号时，只改了编号和文件名而没有把 `when` 改得比前一条大，这个迁移在已经执行过前一条的库上会被
静默跳过：没有报错，表或列就是没有，控制面要到用到它时才出错。CI 每次都从空库开始，抓不到。
所以这里不连数据库，只看这个目录：

1. 条目按编号从小到大排列时，`when` 严格递增；
2. 编号连续，文件名的前四位和条目的编号一致（`KNOWN_MISSING` 里是历史上没有合入过的编号）；
3. 每一条都有对应的 SQL 文件（`<tag>.sql`）和快照（`meta/<编号>_snapshot.json`），目录里没有
   多余的 SQL 文件和快照。

每处不对的地方都报：哪一条（或哪两条）、哪里不对、怎么改。失败时退出码 1。「先迁到倒数第二个，
再执行全部」的测试在 `apps/server/test/migration-upgrade.test.ts`：它连数据库，抓的是同一个
问题的实际后果。

用法：`python3 scripts/check_migrations.py [迁移目录]`，默认是 `apps/server/drizzle`。
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIR = ROOT / "apps" / "server" / "drizzle"
#: 历史上没有合入过的编号（0027 在合入前被换成了别的编号）：已经执行过的库里没有它，编号检查放过它。
#: 以后不能再有新的缺口；这里的编号真的有了迁移时要从这里删掉，检查会提醒。
KNOWN_MISSING = frozenset({27})

TAG = re.compile(r"^(\d{4})_[a-z0-9_]+$")
SNAPSHOT = re.compile(r"^(\d{4})_snapshot\.json$")


def shown(path: Path) -> Path:
    """报错里写的路径：仓库里的写成相对仓库根目录的。"""
    return path.relative_to(ROOT) if path.is_relative_to(ROOT) else path


def suggested_when(entries: list[dict[str, int | str]], at: int) -> int:
    """比前面所有条目的 `when` 都大的一个值：当前时间（毫秒），不够大时取前面最大的加一。"""
    before = [int(e["when"]) for e in entries[:at]]
    return max(int(time.time() * 1000), max(before, default=0) + 1)


def check(directory: Path) -> list[str]:
    """目录里的迁移日志有哪些问题（每处一条，写明怎么改）；没有问题时是空列表。"""
    journal_path = directory / "meta" / "_journal.json"
    where = shown(journal_path)
    folder = shown(directory)
    try:
        journal = json.loads(journal_path.read_text(encoding="utf-8"))
        entries: list[dict[str, int | str]] = sorted(journal["entries"], key=lambda e: e["idx"])
    except (OSError, ValueError, KeyError, TypeError) as error:
        return [
            f"{where}：读不了迁移日志（{error}）：它是 drizzle-kit 生成的，不要手写；"
            "用 pnpm --filter @sfly/server db:generate"
        ]

    problems: list[str] = []

    # 编号：不重复、文件名和条目一致、连续。
    seen: dict[int, str] = {}
    for entry in entries:
        idx, tag = int(entry["idx"]), str(entry["tag"])
        if idx in seen:
            problems.append(
                f"{where}：编号 {idx:04d} 有两条：{seen[idx]} 和 {tag}。"
                "后合入的一方把自己的迁移重新排号（接在目录里最大的编号后面）"
            )
        seen[idx] = tag
        match = TAG.match(tag)
        if match is None or int(match.group(1)) != idx:
            problems.append(
                f"{where}：第 {idx:04d} 条的名字是 {tag}，前四位应该是 {idx:04d}。"
                "改名（SQL 文件、快照、日志里的 tag 一起改），或者删掉重新生成"
            )
    if entries:
        numbers = {int(e["idx"]) for e in entries}
        last = int(entries[-1]["idx"])
        for number in sorted(set(range(last + 1)) - numbers - KNOWN_MISSING):
            problems.append(
                f"{where}：编号 {number:04d} 缺了：编号要连续。把后面的迁移接在前一个编号后面"
                "重新排号（SQL 文件、快照、日志里的 idx 和 tag 一起改，`when` 要保持递增）"
            )
        for number in sorted(KNOWN_MISSING & numbers):
            problems.append(
                f"{Path(__file__).name}：KNOWN_MISSING 里的 {number:04d} 现在有迁移了："
                "从 KNOWN_MISSING 里删掉它"
            )

    # when 按编号严格递增。
    for at in range(1, len(entries)):
        before, entry = entries[at - 1], entries[at]
        if int(entry["when"]) <= int(before["when"]):
            problems.append(
                f"{where}：迁移 {entry['tag']} 的 when（{entry['when']}）不比前一条 "
                f"{before['tag']} 的（{before['when']}）大。drizzle 只执行 when 比库里最后一个"
                f"已执行迁移新的：这个迁移在已经执行过 {before['tag']} 的库上会被静默跳过，"
                f"没有报错，表或列就是没有。把 {entry['tag']} 的 when 改成比 {before['tag']} "
                f"大的值，例如 {suggested_when(entries, at)}（当前时间的毫秒数）"
            )

    # 每一条都有 SQL 文件和快照，目录里没有多余的。
    sql_files = {p.name for p in directory.glob("*.sql")}
    snapshots = {p.name for p in (directory / "meta").glob("*_snapshot.json")}
    for entry in entries:
        idx, tag = int(entry["idx"]), str(entry["tag"])
        if f"{tag}.sql" not in sql_files:
            problems.append(
                f"{where}：日志里有 {tag}，但没有 {folder}/{tag}.sql。"
                "把文件补回来，或者用 db:generate 重新生成"
            )
        if f"{idx:04d}_snapshot.json" not in snapshots:
            problems.append(
                f"{where}：日志里有 {tag}，但没有 {folder}/meta/{idx:04d}_snapshot.json。"
                "快照是 drizzle-kit 生成迁移时一起写的：补回来，或者重新生成"
            )
    tags = {str(e["tag"]) for e in entries}
    for name in sorted(sql_files):
        if name.removesuffix(".sql") not in tags:
            problems.append(
                f"{folder}/{name} 不在 _journal.json 里：drizzle 不会执行它。"
                "它是别的编号重排后留下的？删掉；还要用？补进日志"
                "（用 db:generate 生成，不要手写）"
            )
    with_entry = {int(e["idx"]) for e in entries}
    for name in sorted(snapshots):
        match = SNAPSHOT.match(name)
        if match is None or int(match.group(1)) not in with_entry:
            problems.append(
                f"{folder}/meta/{name} 没有对应的日志条目：多余的快照，删掉（或者补上对应的迁移）"
            )
    return problems


def main(argv: list[str]) -> int:
    directory = Path(argv[1]).resolve() if len(argv) > 1 else DEFAULT_DIR
    problems = check(directory)
    for problem in problems:
        print(f"迁移日志：{problem}", file=sys.stderr)
    if problems:
        print(
            f"迁移日志有 {len(problems)} 处不对（规则见 {Path(__file__).name} 开头）。",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
