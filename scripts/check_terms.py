#!/usr/bin/env python3
"""术语检查（`pnpm lint:docs` 的一部分）：secret 参数的旧说法（敏感、保密、机密）不再出现在仓库里。

只查这一个概念（GLOSSARY.md「secret 参数」，旧说法列在它的 `_Avoid_` 行）。界面、命令行、文档、
报错、代码注释和测试里，这个概念只写「secret」（参数、值、环境变量），
不写「敏感」「保密」「机密」：

- 「敏感」：只有 `INSENSITIVE_PHRASES` 里的固定搭配（`大小写不敏感` 这类，说的是大小写、空白，不
  是参数）不算；别的「不敏感」（「不敏感参数」「这个参数不敏感」）照报。
- 「保密」「机密」：一律不用。

词表（`DEPRECATED`）写在本脚本里，不读 GLOSSARY.md：GLOSSARY.md 里别的 `_Avoid_`（「子任务」「派
发节点」……）不查，以后 GLOSSARY.md 加的 `_Avoid_` 也不会自动被查。要再守一个概念：在
`DEPRECATED` 里加一项（旧说法的正则、替代它的写法），在 `scripts/tests/test_check_terms.py` 里加
它的用例，GLOSSARY.md 对应的条目写上 `_Avoid_`。

查 `git ls-files` 列出的文件（工作区里的内容）：新建、还没 `git add` 的文件本机查不到，推送前钩
子和 CI 里会查。不查：`GLOSSARY.md`（旧说法就写在那里）、`docs/adr/`（历史决定，不改写）、
`docs/research/`、`docs/prototype/`、`docs/perf/`（历史材料）、本脚本和它的测试；二进制文件、读
不出 UTF-8 的文件。

确实要写这几个词（别的意思）时，在 `scripts/terms.allow` 加一行 `文件 | 原文 | 原因`：原文是那一
行里的一段话，必须含被报的那个词，只放过落在这段话里的那一处（同一行里别的旧说法照报）；原文里不
能有 `|`（表格行取不含 `|` 的一段）；原因必填。不再需要放行时这一行也会报错，要删掉。能改写的先
改写。失败时退出码 1。
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
USE = "secret（参数、值、环境变量）"


@dataclass(frozen=True)
class Deprecated:
    """一个旧说法：正则，和不算的固定搭配（这个词在这些搭配里是别的意思）。"""

    pattern: re.Pattern[str]
    fixed: tuple[str, ...] = ()


# 「敏感」在这些固定搭配里说的是大小写、空白，不是参数。新加一种写法要在这里列出来，
# 别的「不敏感」照报。
INSENSITIVE_PHRASES = ("大小写不敏感", "大小写、连字符、空白不敏感")
DEPRECATED: tuple[Deprecated, ...] = (
    Deprecated(re.compile("敏感"), INSENSITIVE_PHRASES),
    Deprecated(re.compile("保密")),
    Deprecated(re.compile("机密")),
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
    column: int
    raw: str


def matches(line: str) -> list[tuple[int, str]]:
    """一行里出现的旧说法：（起点，原文），固定搭配里的不算。"""
    found: list[tuple[int, str]] = []
    for deprecated in DEPRECATED:
        excused = [
            (m.start(), m.end())
            for phrase in deprecated.fixed
            for m in re.finditer(re.escape(phrase), line)
        ]
        for match in deprecated.pattern.finditer(line):
            if not any(start <= match.start() and match.end() <= end for start, end in excused):
                found.append((match.start(), match.group(0)))
    return sorted(found)


def find_deprecated(files: Mapping[str, str]) -> list[Finding]:
    """`files`（仓库路径 → 内容）里出现的旧说法，按路径、行号、位置排序。"""
    found: list[Finding] = []
    for path in sorted(files):
        if path in SKIPPED_FILES or path.startswith(SKIPPED_PREFIXES):
            continue
        for number, line in enumerate(files[path].splitlines(), start=1):
            for column, word in matches(line):
                found.append(Finding(path, number, line.strip(), word, column, line))
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
        if not matches(parts[1]):
            problems.append(
                f"{ALLOW_FILE}:{number}：原文「{parts[1]}」里没有不用的说法，不需要放行，删掉这一行"
            )
            continue
        entries.append((parts[0], parts[1]))
    return entries, problems


def is_allowed(finding: Finding, quote: str) -> bool:
    """这一处是不是落在这一行里的 `quote` 那一段话里。"""
    start = finding.raw.find(quote)
    while start != -1:
        if start <= finding.column and finding.column + len(finding.word) <= start + len(quote):
            return True
        start = finding.raw.find(quote, start + 1)
    return False


def check(files: Mapping[str, str], allow_text: str) -> list[str]:
    """检查，返回要报的问题（空表示通过）。"""
    allowed, problems = parse_allow(allow_text)
    used: set[tuple[str, str]] = set()
    for finding in find_deprecated(files):
        key = next(
            (
                (path, quote)
                for path, quote in allowed
                if path == finding.path and is_allowed(finding, quote)
            ),
            None,
        )
        if key is not None:
            used.add(key)
            continue
        problems.append(
            f"{finding.path}:{finding.line}：「{finding.word}」是不用的说法，写成 {USE}"
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
