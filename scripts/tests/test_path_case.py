"""仓库里不能有只差大小写的路径：macOS 默认的 APFS 不区分大小写，CI 的 runner
也可能把工作目录放在这样的文件系统上。同一目录下去掉扩展名后只差大小写的文件也不行：
`import "./Timeline"` 会先找 `Timeline.ts`，不区分大小写时命中 `timeline.ts`，
导入了另一个模块（Typecheck 与 vite build 失败）。"""

from __future__ import annotations

import os
import subprocess
from collections import defaultdict
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]


def case_collisions(paths: list[str]) -> list[list[str]]:
    """只差大小写的路径组：完整路径、目录，以及同一目录下去掉最后一个扩展名后的文件名。"""
    groups: defaultdict[str, set[str]] = defaultdict(set)
    for path in paths:
        p = PurePosixPath(path)
        for parent in list(p.parents)[:-1]:
            groups[str(parent).lower()].add(str(parent))
        stem = str(p.with_suffix("")) if p.suffix else path
        groups[stem.lower()].add(stem)
    return sorted(sorted(names) for names in groups.values() if len(names) > 1)


def test_finds_files_that_resolve_to_the_same_module_on_a_case_insensitive_file_system() -> None:
    assert case_collisions(
        [
            "web/monitor/Timeline.tsx",
            "web/monitor/timeline.ts",
            "web/monitor/timeline.test.ts",
            "Docs/a.md",
            "docs/b.md",
            "web/README.md",
        ]
    ) == [["Docs", "docs"], ["web/monitor/Timeline", "web/monitor/timeline"]]


def test_tracked_paths_do_not_differ_only_in_case() -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    files = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, env=env, capture_output=True, text=True, check=True
    ).stdout.splitlines()
    assert case_collisions(files) == []
