"""`sfly init` 生成的项目固定 ruff 的规则集（#472）：ruff 出新版本时，同一份代码不会多出新的报告。

- 模板里写的是一组确切的规则编号，不是前缀：前缀（`F`、`E7`）会自动带上 ruff 以后转正的新规则；
- 用户文档和两份 skill 里完整的示例代码（自己写了 import 的代码块）在这组规则下零报告。
  只写了一段、靠上下文的片段（没有 import）不算：它们本来就引用了上文的名字。
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

from sfly.cli.init import (
    RUFF_GROUPS,
    RUFF_SELECT,
    NewProject,
    PackageDirSettings,
    configure_pyproject,
)

GUIDE = Path(__file__).resolve().parents[3] / "docs" / "guide"
RUFF = str(Path(sys.executable).parent / "ruff")
_BLOCK = re.compile(r"```python\n(.*?)```", re.S)
_COMPLETE = re.compile(r"^(import |from )")


def complete_examples() -> list[tuple[str, str]]:
    found = []
    for md in sorted(GUIDE.rglob("*.md")):
        for index, match in enumerate(_BLOCK.finditer(md.read_text(encoding="utf-8"))):
            code = match.group(1)
            first = next((line for line in code.splitlines() if line.strip()), "")
            if _COMPLETE.match(first):
                found.append((f"{md.relative_to(GUIDE)}#{index}", code))
    return found


def test_select_is_a_list_of_exact_rule_codes() -> None:
    assert RUFF_SELECT, "sfly init 的模板要固定 ruff 的规则集"
    assert all(re.fullmatch(r"[A-Z]+[0-9]{3}", code) for code in RUFF_SELECT), RUFF_SELECT
    assert len(set(RUFF_SELECT)) == len(RUFF_SELECT)


def test_guide_has_complete_examples() -> None:
    # 别让下面的检查因为提取不到代码块而空过。
    assert len(complete_examples()) >= 10


@pytest.mark.parametrize(("where", "code"), complete_examples(), ids=lambda v: str(v)[:40])
def test_complete_examples_in_guide_pass_the_template_rules(
    where: str, code: str, tmp_path: Path
) -> None:
    source = tmp_path / "example.py"
    source.write_text(code, encoding="utf-8")
    result = subprocess.run(
        [
            RUFF,
            "check",
            "--isolated",
            "--select",
            ",".join(RUFF_SELECT),
            "--output-format",
            "concise",
            str(source),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"{where}\n{result.stdout}{result.stderr}"


_SELECT_BLOCK = re.compile(r"\[tool\.ruff\.lint\]\nselect = \[\n.*?\n\]\n", re.S)


def test_guide_shows_the_same_select_for_existing_projects() -> None:
    text = (GUIDE / "init-project.md").read_text(encoding="utf-8")
    block = re.search(r"```toml\n\[tool\.ruff\.lint\]\nselect = \[\n(.*?)\]\n```", text, re.S)
    assert block, "init-project.md 里要有给已有项目抄的 [tool.ruff.lint] select"
    assert tuple(re.findall(r'"([A-Z]+[0-9]+)"', block.group(1))) == RUFF_SELECT


def generated_select(tmp_path: Path) -> str:
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "demo"\n', encoding="utf-8")
    settings = PackageDirSettings("1.0.0", "http://cp.test/simple/", None, None)
    configure_pyproject(NewProject(tmp_path, "demo", "demo", settings))
    found = _SELECT_BLOCK.search((tmp_path / "pyproject.toml").read_text(encoding="utf-8"))
    assert found
    return found.group(0)


def test_select_is_grouped_by_rule_family_with_a_comment_per_group(tmp_path: Path) -> None:
    """生成的 select 按族分行：每组前一行注释说明这组查什么，后面是这组的编号。"""
    assert [family for family, _, _ in RUFF_GROUPS] == ["F", "E4", "E7", "E9"]
    assert tuple(code for _, _, codes in RUFF_GROUPS for code in codes) == RUFF_SELECT
    lines = generated_select(tmp_path).splitlines()[2:-1]
    groups: list[tuple[str, list[str]]] = []
    for line in lines:
        if line.strip().startswith("#"):
            groups.append((line.strip(), []))
        else:
            assert groups, f"第一行要是注释：{line}"
            groups[-1][1].extend(re.findall(r'"([A-Z]+[0-9]+)"', line))
    assert [codes for _, codes in groups] == [list(codes) for _, _, codes in RUFF_GROUPS]
    for (comment, _), (family, _, _) in zip(groups, RUFF_GROUPS, strict=True):
        assert f"（{family}）" in comment, comment


def test_generated_select_explains_why_exact_codes_not_prefixes(tmp_path: Path) -> None:
    generated_select(tmp_path)
    before = (tmp_path / "pyproject.toml").read_text(encoding="utf-8").split("[tool.ruff.lint]")[0]
    comment = before.rstrip("\n").rsplit("\n\n", 1)[-1]
    assert "前缀" in comment, comment


def test_guide_block_is_exactly_what_sfly_init_writes(tmp_path: Path) -> None:
    text = (GUIDE / "init-project.md").read_text(encoding="utf-8")
    block = re.search(r"```toml\n(\[tool\.ruff\.lint\]\nselect = \[\n.*?\n\]\n)```", text, re.S)
    assert block
    assert block.group(1) == generated_select(tmp_path)
