#!/usr/bin/env python3
"""文档里的引用有没有失效（`pnpm lint:docs` 的一部分，规则见 CODING_STANDARDS.md「文档」）。拦三类：

1. Markdown 里反引号写的仓库路径不存在。只有以仓库顶层目录名或根目录文件名开头的才算仓库路径
   （`apps/web/src/lib/api.ts`、`README.md`）；`task.json`、`out/…`、`~/.sfly/…` 这类运行时才有的
   不查，带 `*`、`<…>`、`{a,b}`、`…`、`X.Y.Z` 的占位写法不查，被 .gitignore 忽略的（构建产物）不查，
   代码块里的不查。可以带 `:行号` 或 `#符号`。
2. 章节引用（`docs/SEMANTICS.md §3.4`）指向的标题不存在。写法只有一种：文档的仓库路径、空格、
   `§`、章节号；一组沿用前面的文档（`docs/SEMANTICS.md §1.2、§2.4`）；章节里的某一条写在后面
   （`§4 第 6 条`）。SEMANTICS、ARCHITECTURE、DESIGN-SYSTEM 三份文档自己里面，裸的 `§4.1` 指本文档。
   源码注释里的也查。
3. Markdown 相对链接指向的文件或标题（锚点）不存在。

不查：`docs/adr`、`docs/research`（旧名照旧保留）、`docs/perf/<版本>/`（历史报告）、生成的代码、
测试夹具；符号链接的 .md 只查链接指向的那份。已知查不出的：章节号存在但指错了节；顶层目录整个改名后
旧名开头的路径（顶层名取自现在的仓库）。确实要写一个不存在的引用时，在
`scripts/doc-references.allow` 加一行 `文件 | 引用原文 | 原因`（原因必填；引用不再需要放行时，
这一行也会报错，要删掉）。每处失效的引用报：文件和行、引用原文、能猜出来的正确写法。失败时退出码 1。
"""

from __future__ import annotations

import difflib
import os
import posixpath
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
ALLOW_FILE = "scripts/doc-references.allow"
CHECKER_FILES = (
    "scripts/check_doc_references.py",
    "scripts/tests/test_check_doc_references.py",
    ALLOW_FILE,
)
# 章节号标题检查的三份文档（标题写成 `## 4. …`、`### 4.1 …`）。
NUMBERED_DOCS = ("docs/SEMANTICS.md", "docs/ARCHITECTURE.md", "docs/DESIGN-SYSTEM.md")
# 不检查的位置：历史材料、生成物、测试夹具（以及检查自己和它的测试里故意写错的例子）。
EXCLUDED_PREFIXES = (
    "docs/adr/",
    "docs/research/",
    "apps/web/e2e/docs-fixture/",
    "apps/web/e2e/docs-typography-fixture/",
    "packages/client/src/generated/",
    "packages/proto/src/gen/",
    "sdk/python/src/sfly/schemas/",
)
EXCLUDED_PATTERNS = (re.compile(r"^docs/perf/[^/]+/"),)

DOC_NAMES = "SEMANTICS|ARCHITECTURE|DESIGN-SYSTEM"
SECTION_NUMBER = r"\d+(?:\.\d+)*"
SECTION_SIGN = re.compile(rf"§ ?({SECTION_NUMBER})")
CANONICAL_BEFORE = re.compile(rf"(docs/(?:{DOC_NAMES})\.md) $")
LOOSE_BEFORE = re.compile(rf"((?:docs/)?(?P<stem>{DOC_NAMES})(?:\.md)?`?\s*(?:的\s*)?)$")
LIST_SEPARATOR = re.compile(r"(?:「[^」]*」)?[、，,]\s?$")
# `第 4.1 节`、`第 3.3、3.4 节`、`见 7.4 节`；「4.2 节点包格式」里的「节点」不算。
SECTION_WORD = re.compile(
    rf"第\s?{SECTION_NUMBER}(?:[、,]\s?{SECTION_NUMBER})*\s?节(?!点)"
    rf"|(?<![\w.])\d+\.\d+\s?节(?!点)"
)
SECTION_WORD_AFTER_DOC = re.compile(
    rf"(?:docs/)?(?P<stem>{DOC_NAMES})(?:\.md)?`?\s?(?:的\s?)?(?P<word>{SECTION_WORD.pattern})"
)
HEADING_NUMBER = re.compile(r"^#{2,6}\s+(\d+(?:\.\d+)*)\.?\s")
HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*#*\s*$")
FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
CODE_SPAN = re.compile(r"(`+)(.+?)(?<!`)\1(?!`)")
INLINE_LINK = re.compile(
    r"!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:\"[^\"]*\"|'[^']*'))?\s*\)"
)
LINK_DEFINITION = re.compile(r"^\s{0,3}\[(?!\^)[^\]]+\]:\s*(<[^>]*>|\S+)")
PATH_SPAN = re.compile(r"[A-Za-z0-9_.@+\-/]+(?::\d+(?:-\d+)*)*(?:#\S*)?")
PLACEHOLDERS = ("...", "X.Y.Z")
URL_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.\-]*:")


@dataclass
class Finding:
    path: str
    line: int
    ref: str  # 放行时写的引用原文
    message: str
    hints: list[str] = field(default_factory=list)


def run_git(*args: str, ok: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess[str]:
    """运行 git；退出码不在 ok 里时直接报错退出，免得 git 出了问题却当成「没有任何引用」通过。"""
    result = subprocess.run(
        ["git", "-C", str(ROOT), "-c", "core.quotepath=false", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode not in ok:
        detail = result.stderr.strip() or f"退出码 {result.returncode}"
        sys.exit(f"check_doc_references：git {' '.join(args[:2])} 失败：{detail}")
    return result


class Repo:
    """git 已跟踪的文件（以索引为准，不受本机有没有构建产物影响）。"""

    def __init__(self) -> None:
        self.files: set[str] = set()
        self.symlinks: set[str] = set()
        self.dirs: set[str] = set()
        for entry in run_git("ls-files", "-s", "-z").stdout.split("\0"):
            if entry:
                meta, _, path = entry.partition("\t")
                self.files.add(path)
                if meta.startswith("120000"):
                    self.symlinks.add(path)
        # 新建、还没 git add 的文件也算：提交前跑 `pnpm lint` 就能看到它们。
        for path in run_git("ls-files", "-o", "--exclude-standard", "-z").stdout.split("\0"):
            if path:
                self.files.add(path)
                if (ROOT / path).is_symlink():
                    self.symlinks.add(path)
        for path in self.files:
            parts = path.split("/")
            for i in range(1, len(parts)):
                self.dirs.add("/".join(parts[:i]))
        self.top = {path.split("/")[0] for path in self.files}
        # 符号链接指向的文件 → 指向它的链接路径。
        # 文件里的相对链接，从这些位置读也算数（随 SDK 发布的 skill 就是这样）。
        self.aliases: dict[str, list[str]] = {}
        for link in self.symlinks:
            try:
                destination = os.readlink(ROOT / link)
            except OSError:  # 已经删掉、还没从索引里去掉，或者不是符号链接了
                continue
            target = posixpath.normpath(posixpath.join(posixpath.dirname(link), destination))
            if target in self.files:
                self.aliases.setdefault(target, []).append(link)
        self._headings: dict[str, set[str]] = {}
        self._slugs: dict[str, list[str]] = {}
        self._history: dict[str, tuple[str, str, str]] | None = None

    def exists(self, path: str) -> bool:
        return path in self.files or path in self.dirs

    def is_ignored(self, path: str) -> bool:
        """被 .gitignore 忽略（构建产物、本地目录）：不在仓库里是正常的。"""
        result = run_git(
            "check-ignore", "--no-index", "--", path, path.rstrip("/") + "/", ok=(0, 1, 128)
        )
        return result.returncode == 0

    def is_source(self, path: str) -> bool:
        if path in self.symlinks or path in CHECKER_FILES or path.startswith(EXCLUDED_PREFIXES):
            return False
        return not any(pattern.match(path) for pattern in EXCLUDED_PATTERNS)

    def read_lines(self, path: str) -> list[str]:
        try:
            return (ROOT / path).read_text(encoding="utf-8-sig").split("\n")
        except (OSError, UnicodeDecodeError):
            return []

    def section_numbers(self, doc: str) -> set[str]:
        """文档里有标题的章节号（`## 4. …` → 4，`### 4.1 …` → 4.1）。"""
        if doc not in self._headings:
            numbers: set[str] = set()
            lines = self.read_lines(doc)
            for line, fenced in zip(lines, is_in_fence_state(lines), strict=True):
                if not fenced and (m := HEADING_NUMBER.match(line)):
                    numbers.add(m.group(1))
            self._headings[doc] = numbers
        return self._headings[doc]

    def anchors(self, path: str) -> list[str]:
        """Markdown 文件里标题的锚点（GitHub 的规则：小写、去标点、空格换成 -，重名加 -1、-2）。"""
        if path not in self._slugs:
            slugs: list[str] = []
            seen: dict[str, int] = {}
            lines = self.read_lines(path)
            for line, fenced in zip(lines, is_in_fence_state(lines), strict=True):
                m = None if fenced else HEADING.match(line)
                if not m:
                    continue
                slug = slugify(m.group(1))
                count = seen.get(slug, 0)
                seen[slug] = count + 1
                slugs.append(slug if count == 0 else f"{slug}-{count}")
            self._slugs[path] = slugs
        return self._slugs[path]

    def history(self) -> dict[str, tuple[str, str, str]]:
        """历史里改名或删除过的路径：旧路径 → (R 或 D, 新路径, 提交)，取最近的一次。"""
        if self._history is None:
            self._history = {}
            log = run_git(
                "log", "--diff-filter=RD", "-M", "--name-status", "--format=%x00%h", ok=(0, 128)
            )
            commit = ""
            for line in log.stdout.splitlines():
                if line.startswith("\0"):
                    commit = line[1:]
                    continue
                kind, *paths = line.split("\t")
                if kind.startswith("R") and len(paths) == 2:
                    self._history.setdefault(paths[0], ("R", paths[1], commit))
                elif kind == "D" and len(paths) == 1:
                    self._history.setdefault(paths[0], ("D", "", commit))
        return self._history

    def where_did_it_go(self, path: str) -> list[str]:
        """缺失的路径可能的正确写法：改名之后的位置、被删除的提交、同名的文件。"""
        path = path.rstrip("/")
        hints: list[str] = []
        for old, (kind, new, commit) in self.history().items():
            if old != path and not old.startswith(path + "/"):
                continue
            if kind == "R":
                suffix = old[len(path) :]
                moved = new[: -len(suffix)] if suffix and new.endswith(suffix) else new
                if self.exists(moved):
                    hints.append(f"在 {commit} 改名为 {moved}")
                    break
            elif old == path:
                hints.append(f"在 {commit} 删除了")
                break
        name = PurePosixPath(path).name
        same_name = sorted(
            candidate
            for candidate in self.files | self.dirs
            if candidate.rsplit("/", 1)[-1] == name and candidate != path
        )
        if same_name:
            shown = "、".join(same_name[:3]) + ("……" if len(same_name) > 3 else "")
            hints.append(f"仓库里同名的有：{shown}")
        return hints


def slugify(heading: str) -> str:
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", heading)
    text = re.sub(r"<[^>]+>", "", text).replace("`", "").replace("*", "")
    return re.sub(r"[^\w\- ]", "", text.lower()).replace(" ", "-")


def is_in_fence_state(lines: list[str]) -> list[bool]:
    """每一行是不是在代码块里（围栏行本身也算）。"""
    states: list[bool] = []
    marker = ""
    for line in lines:
        m = FENCE.match(line)
        if marker:
            states.append(True)
            if m and m.group(1)[0] == marker[0] and len(m.group(1)) >= len(marker):
                marker = ""
        elif m:
            states.append(True)
            marker = m.group(1)
        else:
            states.append(False)
    return states


# —— 1 和 3：Markdown 里的反引号路径和相对链接 ——


def check_markdown(repo: Repo, path: str) -> list[Finding]:
    findings: list[Finding] = []
    lines = repo.read_lines(path)
    for number, (line, fenced) in enumerate(zip(lines, is_in_fence_state(lines), strict=True), 1):
        if fenced:
            continue
        for span in CODE_SPAN.finditer(line):
            finding = check_path_span(repo, path, number, span.group(2).strip())
            if finding:
                findings.append(finding)
        masked = CODE_SPAN.sub(lambda m: " " * len(m.group(0)), line)
        targets = [m.group(1) for m in INLINE_LINK.finditer(masked)]
        if definition := LINK_DEFINITION.match(masked):
            targets.append(definition.group(1))
        for target in targets:
            finding = check_link(repo, path, number, target.strip("<>"))
            if finding:
                findings.append(finding)
    return findings


def check_path_span(repo: Repo, path: str, number: int, span: str) -> Finding | None:
    if not PATH_SPAN.fullmatch(span) or any(p in span for p in PLACEHOLDERS):
        return None
    target = re.split(r"[:#]", span, maxsplit=1)[0]
    if target.split("/")[0] not in repo.top or repo.exists(target.rstrip("/")):
        return None
    if repo.is_ignored(target):
        return None
    return Finding(
        path,
        number,
        span,
        f"引用的路径 {span} 不存在。",
        repo.where_did_it_go(target),
    )


def resolve_link(base: str, file_part: str) -> str | None:
    """相对 base 目录解析链接的文件部分；指到仓库外面时是 None。"""
    parts: list[str] = []
    for part in (PurePosixPath(base) / file_part).parts:
        if part == "..":
            if not parts:
                return None
            parts.pop()
        elif part != ".":
            parts.append(part)
    return "/".join(parts)


def check_link(repo: Repo, path: str, number: int, target: str) -> Finding | None:
    if not target or URL_SCHEME.match(target) or target.startswith(("/", "//")):
        return None
    file_part, _, anchor = target.partition("#")
    file_part = unquote(file_part.partition("?")[0])
    anchor = unquote(anchor)
    destination = path
    if file_part:
        bases = [
            posixpath.dirname(path),
            *(posixpath.dirname(a) for a in repo.aliases.get(path, [])),
        ]
        resolved = [d for base in bases if (d := resolve_link(base, file_part)) is not None]
        found = next((d for d in resolved if d and repo.exists(d.rstrip("/"))), None)
        if found is None:
            if not resolved:
                return Finding(path, number, target, f"链接 {target} 指到了仓库外面。")
            if any(not d or repo.is_ignored(d) for d in resolved):
                return None
            return Finding(
                path,
                number,
                target,
                f"链接 {target} 指向的文件不存在。",
                repo.where_did_it_go(resolved[0]),
            )
        destination = found
    if anchor and destination.endswith(".md") and destination in repo.files:
        slugs = repo.anchors(destination)
        if anchor.lower() not in slugs:
            where = "本文件" if destination == path else destination
            hints = []
            if close := difflib.get_close_matches(anchor.lower(), slugs, n=1):
                hints.append(f"也许是 #{close[0]}")
            if slugs:
                hints.append(f"{where} 里的标题有：{'、'.join('#' + s for s in slugs[:12])}")
            return Finding(
                path, number, target, f"链接 {target} 指向的标题不存在：没有 #{anchor}。", hints
            )
    return None


# —— 2：章节引用 ——


def section_hints(repo: Repo, doc: str, num: str) -> list[str]:
    numbers = repo.section_numbers(doc)
    top, _, sub = num.partition(".")
    chapters = sorted((n for n in numbers if "." not in n), key=int)
    if top not in numbers:
        if not chapters:
            return [f"{doc} 里没有带章节号的标题。"]
        return [f"{doc} 有 §{chapters[0]} 到 §{chapters[-1]} 章。"]
    children = sorted(
        (n for n in numbers if n.startswith(top + ".")),
        key=lambda n: tuple(int(part) for part in n.split(".")),
    )
    if not children:
        return [
            f"{doc} 的 §{top} 没有分小节。指里面的第几条时，"
            f"写成 `{doc} §{top} 第 {sub or 'N'} 条`。"
        ]
    listed = "、".join(children)
    return [
        f"§{top} 下的小节是 {listed}。指 §{top} 里的第几条时，写成 `{doc} §{top} 第 {sub} 条`"
        f"（检查不看「第 N 条」）。"
    ]


AGREED_FORM = "文档的仓库路径、空格、§、章节号"


def check_sections_in_line(repo: Repo, path: str, number: int, text: str) -> list[Finding]:
    findings: list[Finding] = []
    local_doc = path if path in NUMBERED_DOCS else None
    prev_end = -1
    chain_doc: str | None = None
    for m in SECTION_SIGN.finditer(text):
        num = m.group(1)
        before = text[: m.start()]
        doc: str | None
        if prev_end >= 0 and LIST_SEPARATOR.fullmatch(text[prev_end : m.start()]):
            doc = chain_doc  # 「docs/SEMANTICS.md §1.2、§2.4」：沿用前面的文档
        elif canonical := CANONICAL_BEFORE.search(before):
            doc = canonical.group(1)
        elif loose := LOOSE_BEFORE.search(before):
            doc = f"docs/{loose.group('stem')}.md"
            written = text[m.start() - len(loose.group(1)) : m.end()]
            findings.append(
                Finding(
                    path,
                    number,
                    written,
                    f"章节引用 {written} 的写法不统一。",
                    [f"写成 `{doc} §{num}`（{AGREED_FORM}）。"],
                )
            )
            chain_doc, prev_end = doc, m.end()
            continue
        elif local_doc:
            doc = local_doc
        else:
            doc = None
            findings.append(
                Finding(
                    path,
                    number,
                    f"§{num}",
                    f"章节引用 §{num} 没有写明是哪份文档，检查不了。",
                    [
                        f"写成 `docs/SEMANTICS.md §{num}`（{AGREED_FORM}；"
                        f"文档是 {'、'.join(NUMBERED_DOCS)} 之一）。"
                    ],
                )
            )
        chain_doc, prev_end = doc, m.end()
        if doc and num not in repo.section_numbers(doc):
            ref = f"{doc} §{num}"
            message = f"{ref} 指向的章节不存在：{doc} 里没有标题 {num}。"
            findings.append(Finding(path, number, ref, message, section_hints(repo, doc, num)))
    findings.extend(check_section_words(path, number, text, local_doc))
    return findings


def check_section_words(path: str, number: int, text: str, local_doc: str | None) -> list[Finding]:
    """`第 4.1 节`、`7.4 节` 这类写法：三份文档自己里面和写了文档路径的地方都统一成 §。"""
    findings: list[Finding] = []
    covered: list[tuple[int, int]] = []
    for m in SECTION_WORD_AFTER_DOC.finditer(text):
        doc = f"docs/{m.group('stem')}.md"
        written = m.group(0)
        fixed = f"{doc} {to_section_sign(m.group('word'))}"
        message = f"章节引用 {written} 的写法不统一。"
        findings.append(
            Finding(path, number, written, message, [f"写成 `{fixed}`（{AGREED_FORM}）。"])
        )
        covered.append(m.span())
    if local_doc:
        for m in SECTION_WORD.finditer(text):
            if any(start <= m.start() < end for start, end in covered):
                continue
            fixed = to_section_sign(m.group(0))
            message = f"文档里的章节引用 {m.group(0)} 的写法不统一。"
            hint = f"写成 `{fixed}`（本文档里的章节引用用 §，不写「第 N 节」）。"
            findings.append(Finding(path, number, m.group(0), message, [hint]))
    return findings


def to_section_sign(word: str) -> str:
    numbers = re.findall(SECTION_NUMBER, word)
    return "、".join(f"§{n}" for n in numbers)


def check_sections(repo: Repo) -> list[Finding]:
    excluded = [f":(exclude){prefix.rstrip('/')}" for prefix in EXCLUDED_PREFIXES]
    excluded += [":(exclude,glob)docs/perf/*/**"]
    excluded += [f":(exclude){path}" for path in CHECKER_FILES]
    grep = run_git(
        "grep",
        "--no-color",
        "--untracked",
        "-n",
        "-I",
        "-E",
        "-e",
        "§",
        "-e",
        r"第 ?[0-9]",
        "-e",
        r"[0-9]\.[0-9]+ ?节",
        "--",
        ".",
        *excluded,
        ok=(0, 1),  # 1 是一处都没找到
    )
    findings: list[Finding] = []
    for entry in grep.stdout.split("\n"):
        path, _, rest = entry.partition(":")
        line, _, text = rest.partition(":")
        if path in repo.symlinks or not line.isdigit():
            continue
        findings.extend(check_sections_in_line(repo, path, int(line), text))
    return findings


# —— 放行 ——


def load_allow(repo: Repo) -> tuple[dict[tuple[str, str], int], list[Finding]]:
    entries: dict[tuple[str, str], int] = {}
    problems: list[Finding] = []
    for number, raw in enumerate(repo.read_lines(ALLOW_FILE), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [part.strip() for part in line.split("|", 2)]
        if len(parts) != 3 or not all(parts):
            problems.append(
                Finding(
                    ALLOW_FILE,
                    number,
                    line,
                    "放行的写法是「文件 | 引用原文 | 原因」，三项都要有，原因不能省。",
                )
            )
            continue
        entries[(parts[0], parts[1])] = number
    return entries, problems


def main() -> int:
    repo = Repo()
    findings: list[Finding] = []
    for path in sorted(repo.files):
        if path.endswith(".md") and repo.is_source(path):
            findings.extend(check_markdown(repo, path))
    findings.extend(check_sections(repo))

    allowed, problems = load_allow(repo)
    used: set[tuple[str, str]] = set()
    remaining: list[Finding] = []
    for finding in findings:
        key = (finding.path, finding.ref)
        if key in allowed:
            used.add(key)
        else:
            remaining.append(finding)
    remaining.extend(problems)
    for (path, ref), number in allowed.items():
        if (path, ref) not in used:
            remaining.append(
                Finding(
                    ALLOW_FILE,
                    number,
                    ref,
                    f"放行的引用 {ref}（{path}）已经没有了，这一行不再需要，删掉。",
                )
            )

    if not remaining:
        return 0
    remaining.sort(key=lambda f: (f.path, f.line, f.ref))
    for finding in remaining:
        print(f"{finding.path}:{finding.line}: {finding.message}", file=sys.stderr)
        for hint in finding.hints:
            print(f"  {hint}", file=sys.stderr)
    example = next((f for f in remaining if f.path != ALLOW_FILE), None)
    print(f"\n共 {len(remaining)} 处文档引用有问题。", file=sys.stderr)
    print(
        "  改写法见 CODING_STANDARDS.md「文档」。确实要这样写（例如描述用户项目里的路径）时，",
        file=sys.stderr,
    )
    entry = (
        f"{example.path} | {example.ref} | <原因>" if example else "<文件> | <引用原文> | <原因>"
    )
    print(f"  在 {ALLOW_FILE} 加一行（原因必填）：{entry}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
