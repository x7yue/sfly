"""文档里写的 `pnpm <名字>` 要真的能运行（#801，`check_doc_references.py` 的第 5 类）。

Markdown 正文和代码块里每一处 `pnpm`，跳过它的选项，取后面的名字
（`pnpm run <名字>` 取 run 后面的）。名字要是 pnpm 自带的命令、根目录 `package.json` 的 script、
文件所在包（最近的有 `package.json` 的上级目录）的 script；写了 `--filter <包>`（`-F`）时查那个包。
名字只认字母开头的词：`pnpm 10`、`用 pnpm 安装` 不算命令。
`--filter` 写的不是包名（通配、路径）时查不了，不报。
"""

from __future__ import annotations

import difflib
import json
import posixpath
import re
from collections.abc import Callable, Iterable

# pnpm 自带的命令（pnpm 10，`pnpm help --all`）和它们的别名。
BUILTINS = frozenset(
    """
    add audit bin cache cat-file cat-index config create dedupe deploy dlx doctor env exec fetch
    find-hash help i import init install install-test it licenses link list ln ls outdated pack
    patch patch-commit patch-remove peers prune publish rb rebuild remove recursive restart rm root
    run self-update server setup start store t test un uninstall unlink up update upgrade why
    """.split()
)
# 后面跟着一个值的选项。
VALUE_OPTIONS = frozenset({"--filter", "-F", "--dir", "-C", "--workspace-dir", "--reporter"})
PNPM = re.compile(r"(?<![\w@/.-])pnpm(?=[ \t])")
TOKEN = re.compile(r"[^\s`'\"]+")
NAME = re.compile(r"^[A-Za-z][\w:.-]*")


class Packages:
    """仓库里的 package.json：目录 → scripts，包名 → 目录。"""

    def __init__(self, files: Iterable[str], read: Callable[[str], str]) -> None:
        self.scripts: dict[str, set[str]] = {}
        self.dirs: dict[str, str] = {}
        for path in files:
            if posixpath.basename(path) != "package.json" or "node_modules/" in path:
                continue
            try:
                data = json.loads(read(path))
            except ValueError:
                continue
            directory = posixpath.dirname(path)
            self.scripts[directory] = set(data.get("scripts", {}))
            if isinstance(data.get("name"), str):
                self.dirs[data["name"]] = directory

    def package_of(self, path: str) -> str | None:
        directory = posixpath.dirname(path)
        while directory:
            if directory in self.scripts:
                return directory
            directory = posixpath.dirname(directory)
        return None


def commands(line: str) -> Iterable[tuple[str, str | None, str]]:
    """一行里的每一处 pnpm：（名字，`--filter` 写的包，命令原文）。"""
    for match in PNPM.finditer(line):
        tokens = TOKEN.findall(line[match.end() :])
        package: str | None = None
        i = 0
        while i < len(tokens) and tokens[i].startswith("-"):
            option = tokens[i].split("=", 1)[0]
            if option in VALUE_OPTIONS and "=" not in tokens[i]:
                if option in ("--filter", "-F") and i + 1 < len(tokens):
                    package = tokens[i + 1]
                i += 2
            else:
                if option in ("--filter", "-F"):
                    package = tokens[i].split("=", 1)[1]
                i += 1
        if i >= len(tokens):
            continue
        name = NAME.match(tokens[i])
        if not name or tokens[i][name.end() :][:1] not in (
            "",
            ")",
            "、",
            "，",
            "。",
            "；",
            "）",
            "|",
        ):
            continue
        if name.group(0) == "run" and i + 1 < len(tokens) and (script := NAME.match(tokens[i + 1])):
            name = script
        shown = " ".join(["pnpm", *tokens[:i], name.group(0)])
        yield name.group(0), package, shown


def check_line(packages: Packages, path: str, line: str) -> Iterable[tuple[str, str, list[str]]]:
    """这一行里对不上的命令：（命令原文，说明，猜的写法）。"""
    root = packages.scripts.get("", set())
    for name, package, shown in commands(line):
        if name in BUILTINS:
            continue
        if package is not None:
            directory = packages.dirs.get(package)
            if directory is None:
                continue
            known, where = packages.scripts[directory], f"{package} 的 package.json"
        else:
            own = packages.package_of(path)
            known = root | (packages.scripts.get(own, set()) if own else set())
            where = f"根目录和 {own}/ 的 package.json" if own else "根目录的 package.json"
        if name in known:
            continue
        hints = [
            f"是不是 pnpm {g}？" for g in difflib.get_close_matches(name, sorted(known), 3, 0.6)
        ]
        yield shown, f"`{shown}`：{name} 不是 pnpm 的命令，也不在{where}的 scripts 里", hints
