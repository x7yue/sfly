"""平台命令的输出约定：默认精简文本，`--json` 输出 JSON；错误写到 stderr；列表有条数上限。

- 结果写到 stdout：文本，或（`--json`）一行精简 JSON，列表类是数组、单个对象是对象；
- 错误写到 stderr：文本是「错误：原因」加可选的「下一步：命令」，`--json` 时是一行
  `{"error": {"code", "message", "next"}}`（没有下一步时 `next` 为 null）；
- 提示（例如列表被截断）：文本时是 stdout 的最后一行，`--json` 时写到 stderr，stdout 保持纯 JSON。
"""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from collections.abc import Sequence
from typing import IO, Any, TypeVar

from sfly.cli.errors import CliError

T = TypeVar("T")

# 列表类命令默认最多输出的条数（`--limit` 可调）。
DEFAULT_LIMIT = 50


class Output:
    def __init__(
        self, *, json_mode: bool, stdout: IO[str] | None = None, stderr: IO[str] | None = None
    ) -> None:
        self.json_mode = json_mode
        self._stdout = stdout
        self._stderr = stderr

    @property
    def stdout(self) -> IO[str]:
        return self._stdout or sys.stdout

    @property
    def stderr(self) -> IO[str]:
        return self._stderr or sys.stderr

    def emit(self, value: Any, text: str, *, note: str | None = None) -> None:
        """输出结果：`--json` 时是 `value` 的 JSON，否则是 `text`。`note` 是一行提示：
        文本时接在最后，`--json` 时写到 stderr。"""
        if self.json_mode:
            print(dump_json(value), file=self.stdout)
            if note:
                print(note, file=self.stderr)
            return
        print(text if note is None else f"{text}\n{note}", file=self.stdout)

    def error(self, error: CliError) -> None:
        """输出错误（写到 stderr）。"""
        if self.json_mode:
            body = {"code": error.code, "message": error.message, "next": error.next}
            print(dump_json({"error": body}), file=self.stderr)
            return
        print(f"错误：{error.message}", file=self.stderr)
        if error.next:
            print(f"下一步：{error.next}", file=self.stderr)


def dump_json(value: Any) -> str:
    """精简 JSON：一行，不转义中文。"""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


_VIA_LABELS = {"claude-code": "Claude Code", "codex": "Codex"}


def via_label(name: str | None) -> str | None:
    """「经哪个 AI 编程助手」的显示名：`claude-code` → Claude Code，`codex` → Codex，其他原样；
    没有（None）时为 None。界面上的显示和这里一致。"""
    if name is None:
        return None
    return _VIA_LABELS.get(name, name)


def actor_label(name: str, via: str | None) -> str:
    """`昵称`，经 AI 编程助手时是 `昵称 经 Claude Code`。"""
    return f"{name} 经 {via_label(via)}" if via else name


def positive_int(text: str) -> int:
    """argparse 的 `type=`：正整数。"""
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"需要正整数，收到 {text!r}") from None
    if value < 1:
        raise argparse.ArgumentTypeError(f"需要正整数，收到 {text!r}")
    return value


def add_limit_option(parser: argparse.ArgumentParser, default: int = DEFAULT_LIMIT) -> None:
    """列表类命令的 `--limit`。"""
    parser.add_argument(
        "--limit",
        type=positive_int,
        default=default,
        help=f"最多输出多少条（默认 {default}）",
    )


def apply_limit(items: Sequence[T], limit: int) -> tuple[list[T], int]:
    """取前 `limit` 条，返回（要输出的条目，没有输出的条数）。"""
    return list(items[:limit]), max(len(items) - limit, 0)


def more_note(
    hidden: int, total: int, noun: str, *, max_limit: int | None = None, narrow: str = ""
) -> str | None:
    """被截断时的提示：还有多少条、怎么看更多；没有被截断时为 None。
    接口一次最多返回 `max_limit` 条、而总数超过它时，`--limit` 再大也看不全，
    提示 `narrow`（缩小范围的办法）。"""
    if hidden <= 0:
        return None
    base = f"还有 {hidden} {noun}没有显示（共 {total} {noun}）"
    if max_limit is not None and total > max_limit:
        return f"{base}，--limit 最大 {max_limit}，更早的{narrow}"
    return f"{base}，加 --limit {total} 查看全部"


# 候选列表（节点、任务……）最多列出多少个。
_MAX_CANDIDATES = 30


def candidate_list(items: Sequence[str]) -> str:
    """错误信息里的候选列表：每个缩进两格，去重，超过 30 个时写还有多少个；没有时写（没有）。"""
    unique = list(dict.fromkeys(items))
    if not unique:
        return "  （没有）"
    shown = "\n".join(f"  {item}" for item in unique[:_MAX_CANDIDATES])
    more = len(unique) - _MAX_CANDIDATES
    return shown + (f"\n  ……还有 {more} 个" if more > 0 else "")


def format_table(headers: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    """对齐的文本表格：列之间两个空格，按显示宽度对齐（中文占两格），行尾不留空白。"""
    table = [list(headers), *map(list, rows)]
    widths = [max(display_width(row[i]) for row in table) for i in range(len(headers))]
    lines = []
    for row in table:
        cells = [
            cell + " " * (width - display_width(cell))
            for cell, width in zip(row, widths, strict=True)
        ]
        lines.append("  ".join(cells).rstrip())
    return "\n".join(lines)


def display_width(text: str) -> int:
    """终端里的显示宽度：中文等全角字符占两格。"""
    return sum(2 if unicodedata.east_asian_width(char) in "WF" else 1 for char in text)
