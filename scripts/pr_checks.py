#!/usr/bin/env python3
"""PR 信息的检查（CI 的「PR 信息」，.github/workflows/pr-checks.yml）。

规则见 docs/agents/branching-and-release.md「PR」。只读 PR 改了哪些文件、带了哪些标签，不看代码：

1. 改了 API 客户端生成的类型（`packages/client/src/generated/`）：要带 `breaking-change`
   （不兼容）或 `client-compatible`（兼容）里的一个，没带或两个都带时失败（退出码 1）。
   兼容不兼容要读 diff 判断，所以由人选标签。
2. 改了性能关键路径（docs/agents/perf-critical-paths.json）：提醒贴 `pnpm perf` 的结论。
   只警告：只改注释也会命中。

用法：`pr_checks.py <改动的文件列表> <标签列表>`，两个都是每行一个的文本文件。
结果按 GitHub Actions 的注解格式（`::error::`、`::warning::`）写到标准输出。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import TypedDict

REPO = Path(__file__).resolve().parents[1]
CRITICAL_PATHS = REPO / "docs" / "agents" / "perf-critical-paths.json"
GENERATED = "packages/client/src/generated/"
BREAKING = "breaking-change"
COMPATIBLE = "client-compatible"
RULES = "docs/agents/branching-and-release.md"


class CriticalPath(TypedDict):
    name: str
    detail: str
    paths: list[str]


def critical_paths() -> list[CriticalPath]:
    paths: list[CriticalPath] = json.loads(CRITICAL_PATHS.read_text(encoding="utf-8"))["paths"]
    return paths


def matches(path: str, pattern: str) -> bool:
    return path.startswith(pattern) if pattern.endswith("/") else path == pattern


def check(
    files: list[str], labels: set[str], critical: list[CriticalPath]
) -> tuple[list[str], list[str]]:
    """返回（错误，警告）。"""
    errors: list[str] = []
    generated = [f for f in files if f.startswith(GENERATED)]
    chosen = labels & {BREAKING, COMPATIBLE}
    if generated and len(chosen) != 1:
        what = "两个都带了，只能留一个" if chosen else "没有标明"
        errors.append(
            f"改了 API 客户端生成的类型（{', '.join(generated)}），兼容性{what}："
            f"不兼容加标签 {BREAKING}（描述里写明变了什么、自建页面要怎么改），"
            f"兼容加 {COMPATIBLE}。怎么判断见 {RULES}「PR」"
        )
    warnings: list[str] = []
    for entry in critical:
        hit = [f for f in files if any(matches(f, p) for p in entry["paths"])]
        if hit:
            warnings.append(
                f"改了性能关键路径「{entry['name']}」（{', '.join(hit)}）："
                f"在描述里贴 pnpm perf 的结论，见 {RULES}「关键路径的改动要贴 pnpm perf 结果」。"
                "只改了注释可以不贴"
            )
    return errors, warnings


def main(argv: list[str]) -> int:
    files = [line for line in Path(argv[1]).read_text(encoding="utf-8").splitlines() if line]
    labels = {line for line in Path(argv[2]).read_text(encoding="utf-8").splitlines() if line}
    errors, warnings = check(files, labels, critical_paths())
    for message in warnings:
        print(f"::warning::{message}")
    for message in errors:
        print(f"::error::{message}")
    if not errors and not warnings:
        print("PR 信息没有问题")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
