"""术语检查（scripts/check_terms.py）：不用的说法（敏感、保密、机密）出现在仓库里要报，
「大小写不敏感」不算；GLOSSARY、历史文档和放行名单里的不报；放行名单里不再需要的行也要报。"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check_terms.py"
spec = importlib.util.spec_from_file_location("check_terms", SCRIPT)
assert spec and spec.loader
check_terms = importlib.util.module_from_spec(spec)
sys.modules["check_terms"] = check_terms
spec.loader.exec_module(check_terms)


def problems(files: dict[str, str], allow: str = "") -> list[str]:
    found: list[str] = check_terms.check(files, allow)
    return found


@pytest.mark.parametrize(
    "text",
    [
        "参数面板上这个开关叫「敏感」",
        "敏感参数的默认值读不回来",
        "保密参数的值会被打码",
        "要保密的短值",
        "这是机密信息",
        "是否敏感",
    ],
)
def test_deprecated_words_are_reported(text: str) -> None:
    found = problems({"apps/web/src/a.ts": f"// 第一行\n{text}\n"})
    assert len(found) == 1
    assert found[0].startswith("apps/web/src/a.ts:2：")
    assert "secret" in found[0]


def test_case_insensitive_is_not_the_deprecated_word() -> None:
    assert problems({"agent/src/x.rs": "大小写不敏感；不敏感也一样"}) == []


def test_every_occurrence_on_a_line_is_reported() -> None:
    found = problems({"docs/guide/x.md": "敏感参数和保密参数"})
    assert [f.split("：")[1].split("」")[0] for f in found] == ["「敏感", "「保密"]


@pytest.mark.parametrize(
    "path",
    [
        "GLOSSARY.md",
        "docs/adr/0001-x.md",
        "docs/research/a.md",
        "docs/prototype/a.html",
        "docs/perf/0.1.0/report.md",
        "scripts/check_terms.py",
        "scripts/tests/test_check_terms.py",
    ],
)
def test_skipped_paths_are_not_checked(path: str) -> None:
    assert problems({path: "敏感参数、保密参数"}) == []


def test_allowed_lines_pass_and_stale_allow_entries_are_reported() -> None:
    files = {"docs/guide/x.md": "对时延敏感的节点\n别的行"}
    allow = "docs/guide/x.md | 对时延敏感的节点 | 别的意思：对时延敏感，和参数无关\n"
    assert problems(files, allow) == []
    # 内容改掉之后，这一行不再需要
    stale = problems({"docs/guide/x.md": "别的行"}, allow)
    assert len(stale) == 1
    assert stale[0].startswith("scripts/terms.allow：放行的")


def test_the_same_word_twice_on_a_line_is_reported_twice() -> None:
    found = problems({"docs/guide/x.md": "敏感参数的默认值、敏感参数的值"})
    assert len(found) == 2


def test_an_allow_entry_matches_a_part_of_the_line_and_only_in_its_own_file() -> None:
    line = "这一行里有一句对时延敏感的节点的话，别的内容"
    files = {"docs/guide/x.md": line, "docs/guide/y.md": line}
    allow = "docs/guide/x.md | 对时延敏感的节点 | 别的意思：对时延敏感，和参数无关\n"
    # 原文是那一行的一段话就行；只放行写了的那个文件，别的文件里同样的话照报
    found = problems(files, allow)
    assert len(found) == 1
    assert found[0].startswith("docs/guide/y.md:1：")


def test_allow_entry_needs_three_fields() -> None:
    found = problems({"a.md": "x"}, "a.md | 原文\n")
    assert len(found) == 1
    assert "三项都不能空" in found[0]


def test_the_repository_itself_passes() -> None:
    result = subprocess.run(
        [sys.executable, str(SCRIPT)], capture_output=True, text=True, cwd=SCRIPT.parents[1]
    )
    assert result.returncode == 0, result.stderr
