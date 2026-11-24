#!/usr/bin/env python3
"""术语检查（`pnpm lint:docs` 的一部分）：GLOSSARY.md 里标了「不用」的说法不再出现在仓库里。

目前查一个概念：secret 参数（GLOSSARY.md「secret 参数」）。界面、命令行、文档、报错、
代码注释和测试里，这个概念只写「secret」（参数、值、环境变量），不写「敏感」「保密」「机密」：

- 「敏感」：`大小写不敏感` 这类「不敏感」不算。
- 「保密」「机密」：一律不用。

不查：`GLOSSARY.md`（「不用」的说法就写在那里）、`docs/adr`（历史决定，不改写）、
`docs/research`、`docs/prototype`、`docs/perf/<版本>/`（历史材料）、本脚本和它的测试；
二进制文件、读不出 UTF-8 的文件。

确实要写这几个词（别的意思）时，在 `scripts/terms.allow` 加一行 `文件 | 原文 | 原因`
（原文是那一行里出现的一段话，能在该文件里找到；原因必填）；不再需要放行时这一行也会报错，
要删掉。能改写的先改写。失败时退出码 1。
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALLOW_FILE = "scripts/terms.allow"
# 不用的说法（正则），和替代它的写法。
DEPRECATED: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?<!不)敏感"), "secret（参数、值、环境变量）"),
    (re.compile(r"保密"), "secret（参数、值、环境变量）"),
    (re.compile(r"机密"), "secret（参数、值、环境变量）"),
)
# 不查的路径前缀和文件。
SKIPPED_PREFIXES = ("docs/adr/", "docs/research/", "docs/prototype/", "docs/perf/")
SKIPPED_FILES = {
    "GLOSSARY.md",
    "scripts/check_terms.py",
    "scripts/tests/test_check_terms.py",
    ALLOW_FILE,
}


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    text: str
    word: str
    use: str


def find_deprecated(files: Mapping[str, str]) -> list[Finding]:
    """`files`（仓库路径 → 内容）里出现的不用的说法，按路径、行号排序。"""
    found: list[Finding] = []
    for path in sorted(files):
        if path in SKIPPED_FILES or path.startswith(SKIPPED_PREFIXES):
            continue
        for number, line in enumerate(files[path].splitlines(), start=1):
            for pattern, use in DEPRECATED:
                for match in pattern.finditer(line):
                    found.append(Finding(path, number, line.strip(), match.group(0), use))
    return found


def parse_allow(text: str) -> tuple[list[tuple[str, str]], list[str]]:
    """放行名单：（文件，原文）的列表，和写法不对的行的说明。"""
    entries: list[tuple[str, str]] = []
    problems: list[str] = []
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [part.strip() for part in line.split("|")]
        if len(parts) != 3 or not all(parts):
            problems.append(f"{ALLOW_FILE}:{number}：要写成「文件 | 原文 | 原因」，三项都不能空")
            continue
        entries.append((parts[0], parts[1]))
    return entries, problems


def check(files: Mapping[str, str], allow_text: str) -> list[str]:
    """检查，返回要报的问题（空表示通过）。"""
    allowed, problems = parse_allow(allow_text)
    used: set[tuple[str, str]] = set()
    for finding in find_deprecated(files):
        key = next(
            (
                (path, quote)
                for path, quote in allowed
                if path == finding.path and quote in finding.text
            ),
            None,
        )
        if key is not None:
            used.add(key)
            continue
        problems.append(
            f"{finding.path}:{finding.line}：「{finding.word}」是不用的说法，写成 {finding.use}"
            f"（GLOSSARY.md「secret 参数」）：{finding.text[:100]}"
        )
    for path, quote in allowed:
        if (path, quote) not in used:
            problems.append(
                f"{ALLOW_FILE}：放行的「{path} | {quote}」已经没有对应的内容，删掉这一行"
            )
    return problems


def tracked_files(root: Path) -> dict[str, str]:
    names = subprocess.run(
        ["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True
    ).stdout.decode("utf-8")
    files: dict[str, str] = {}
    for name in filter(None, names.split("\0")):
        path = root / name
        try:
            files[name] = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
    return files


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT
    try:
        files = tracked_files(root)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("术语检查：不是 git 工作区（或没有 git），跳过", file=sys.stderr)
        return 0
    allow = root / ALLOW_FILE
    problems = check(files, allow.read_text(encoding="utf-8") if allow.exists() else "")
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        print(f"术语检查：{len(problems)} 处不通过", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
