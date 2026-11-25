"""术语检查（scripts/check_terms.py）：secret 参数的旧说法（敏感、保密、机密）出现在仓库里要报，
「大小写不敏感」这类固定搭配不算；GLOSSARY、历史文档不查；放行名单只放过写明的那一处，不再需要的行也要报；
脚本本身在有问题时退出码 1、没问题时 0，各种文件都查。"""

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

ALLOW = "docs/guide/x.md | 对时延敏感的节点 | 别的意思：对时延敏感，和参数无关\n"


def problems(files: dict[str, str], allow: str = "") -> list[str]:
    found: list[str] = check_terms.check(files, allow)
    return found


# ---- 查什么：旧说法 ----


@pytest.mark.parametrize(
    "text",
    [
        "参数面板上这个开关叫「敏感」",
        "敏感参数的默认值读不回来",
        "保密参数的值会被打码",
        "要保密的短值",
        "这是机密信息",
        "是否敏感",
        # 「不敏感」只有固定搭配（大小写……）才不算，别的照报
        "不敏感参数照常显示",
        "这个参数不敏感",
        "非敏感的默认值",
    ],
)
def test_deprecated_words_are_reported(text: str) -> None:
    found = problems({"apps/web/src/a.ts": f"// 第一行\n{text}\n"})
    assert len(found) == 1
    assert found[0].startswith("apps/web/src/a.ts:2：")
    assert "secret" in found[0]


@pytest.mark.parametrize("phrase", list(check_terms.INSENSITIVE_PHRASES))
def test_the_fixed_phrases_about_case_and_blanks_are_not_the_deprecated_word(phrase: str) -> None:
    assert problems({"agent/src/x.rs": f"比较时{phrase}；另一行"}) == []
    # 固定搭配只放过它自己：同一行里别的旧说法、别的「不敏感」照报
    found = problems({"agent/src/x.rs": f"{phrase}，保密参数，不敏感参数，{phrase}"})
    assert [f.split("：")[1].split("」")[0] for f in found] == ["「保密", "「敏感"]


def test_every_occurrence_on_a_line_is_reported() -> None:
    found = problems({"docs/guide/x.md": "敏感参数和保密参数"})
    assert [f.split("：")[1].split("」")[0] for f in found] == ["「敏感", "「保密"]


def test_the_same_word_twice_on_a_line_is_reported_twice() -> None:
    assert len(problems({"docs/guide/x.md": "敏感参数的默认值、敏感参数的值"})) == 2


# 仓库里各种文件都查：每一类各一个。
FILE_KINDS = [
    "agent/src/lib.rs",
    "apps/server/src/a.ts",
    "apps/web/src/Form.tsx",
    "sdk/python/src/sfly/a.py",
    "packages/schema/testdata/cases.json",
    "scripts/run.sh",
    "docs/guide/run-scenario.md",
    "README.md",
    "CODING_STANDARDS.md",
    "apps/web/e2e/a.spec.ts",
    ".github/workflows/ci.yml",
    "evals/assistant/aeval/docker.py",
]


@pytest.mark.parametrize("path", FILE_KINDS)
def test_every_kind_of_file_is_checked(path: str) -> None:
    found = problems({path: "第一行\n保密参数\n"})
    assert len(found) == 1
    assert found[0].startswith(f"{path}:2：")


@pytest.mark.parametrize(
    "path",
    [
        "GLOSSARY.md",
        "docs/adr/0001-x.md",
        "docs/research/a.md",
        "docs/prototype/a.html",
        "docs/perf/0.1.0/report.md",
        "docs/perf/notes.md",
        "scripts/check_terms.py",
        "scripts/tests/test_check_terms.py",
    ],
)
def test_skipped_paths_are_not_checked(path: str) -> None:
    assert problems({path: "敏感参数、保密参数"}) == []


# ---- 放行名单 ----


def test_allowed_lines_pass_and_stale_allow_entries_are_reported() -> None:
    files = {"docs/guide/x.md": "对时延敏感的节点\n别的行"}
    assert problems(files, ALLOW) == []
    # 内容改掉之后，这一行不再需要
    stale = problems({"docs/guide/x.md": "别的行"}, ALLOW)
    assert len(stale) == 1
    assert stale[0].startswith("scripts/terms.allow：放行的")


def test_an_allow_entry_matches_a_part_of_the_line_and_only_in_its_own_file() -> None:
    line = "这一行里有一句对时延敏感的节点的话，别的内容"
    files = {"docs/guide/x.md": line, "docs/guide/y.md": line}
    # 原文是那一行的一段话就行；只放行写了的那个文件，别的文件里同样的话照报
    found = problems(files, ALLOW)
    assert len(found) == 1
    assert found[0].startswith("docs/guide/y.md:1：")


def test_an_allow_entry_only_passes_the_one_place_it_quotes() -> None:
    # 同一行里别的旧说法照报（放行「对时延敏感」不放过「保密参数」）
    found = problems({"docs/guide/x.md": "对时延敏感的节点，保密参数"}, ALLOW)
    assert len(found) == 1
    assert "「保密」" in found[0]
    # 原文那一段之外的同一个词也照报
    found = problems({"docs/guide/x.md": "对时延敏感的节点，敏感参数"}, ALLOW)
    assert len(found) == 1
    assert "「敏感」" in found[0]


def test_an_allow_entry_must_quote_a_deprecated_word() -> None:
    # 「参数」不含旧说法：不能用来放过这个文件里所有带「参数」的行
    found = problems({"docs/guide/x.md": "保密参数"}, "docs/guide/x.md | 参数 | 想放过整个文件\n")
    assert len(found) == 2
    assert any("里没有不用的说法" in f for f in found)
    assert any(f.startswith("docs/guide/x.md:1：") for f in found)


@pytest.mark.parametrize(
    "line",
    [
        "docs/guide/x.md | 对时延敏感的节点",  # 少一项
        "docs/guide/x.md | 对时延敏感的节点 | ",  # 原因是空的
        "docs/guide/x.md |  | 别的意思",  # 原文是空的
        " | 对时延敏感的节点 | 别的意思",  # 文件是空的
        "docs/guide/x.md | 对时延敏感的节点 | 原因 | 多一项",
    ],
)
def test_allow_entry_needs_three_filled_fields(line: str) -> None:
    found = problems({"docs/guide/x.md": "对时延敏感的节点"}, line + "\n")
    assert any("三项都不能空" in f for f in found)
    assert any(f.startswith("docs/guide/x.md:1：") for f in found)  # 格式不对的行放不过任何东西


def test_comments_and_blank_lines_in_the_allow_file_are_ignored() -> None:
    allow = "# 注释\n\n" + ALLOW
    assert problems({"docs/guide/x.md": "对时延敏感的节点"}, allow) == []


# ---- 脚本本身：退出码，读哪些文件 ----


def run_script(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(root)], capture_output=True, text=True, cwd=root
    )


def git_repo(root: Path, files: dict[str, str | bytes], *, add: bool = True) -> Path:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")
    if add:
        subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    return root


def test_the_script_fails_with_the_file_and_line_when_a_tracked_file_has_a_deprecated_word(
    tmp_path: Path,
) -> None:
    git_repo(tmp_path, {"docs/guide/a.md": "第一行\n保密参数的值\n", "docs/guide/b.md": "没问题"})
    result = run_script(tmp_path)
    assert result.returncode == 1
    assert "docs/guide/a.md:2：" in result.stderr
    assert "b.md" not in result.stderr
    assert "1 处不通过" in result.stderr


def test_the_script_passes_when_there_is_nothing_to_report(tmp_path: Path) -> None:
    git_repo(tmp_path, {"docs/guide/a.md": "secret 参数的值\n大小写不敏感", "b.py": "x = 1\n"})
    result = run_script(tmp_path)
    assert result.returncode == 0, result.stderr
    assert result.stderr == ""


@pytest.mark.parametrize("path", FILE_KINDS)
def test_the_script_reads_every_kind_of_tracked_file(tmp_path: Path, path: str) -> None:
    git_repo(tmp_path, {path: "第一行\n保密参数\n"})
    result = run_script(tmp_path)
    assert result.returncode == 1, result.stderr
    assert f"{path}:2：" in result.stderr


def test_the_script_does_not_read_files_git_does_not_track(tmp_path: Path) -> None:
    git_repo(tmp_path, {"docs/guide/a.md": "保密参数"}, add=False)
    assert run_script(tmp_path).returncode == 0


def test_the_script_skips_files_that_are_not_utf8(tmp_path: Path) -> None:
    git_repo(tmp_path, {"data.bin": "保密参数".encode("gbk"), "a.md": "没问题"})
    result = run_script(tmp_path)
    assert result.returncode == 0, result.stderr


def test_the_script_reads_the_allow_file_of_the_repository(tmp_path: Path) -> None:
    files: dict[str, str | bytes] = {
        "docs/guide/x.md": "对时延敏感的节点",
        "scripts/terms.allow": ALLOW,
    }
    git_repo(tmp_path, files)
    assert run_script(tmp_path).returncode == 0
    # 放行的内容没有了：这一行要报
    (tmp_path / "docs/guide/x.md").write_text("别的行", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    result = run_script(tmp_path)
    assert result.returncode == 1
    assert "scripts/terms.allow：放行的" in result.stderr


def test_the_script_skips_a_directory_that_is_not_a_git_work_tree(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("保密参数", encoding="utf-8")
    result = run_script(tmp_path)
    assert result.returncode == 0
    assert "不是 git 工作区" in result.stderr


def test_the_repository_itself_passes() -> None:
    result = subprocess.run(
        [sys.executable, str(SCRIPT)], capture_output=True, text=True, cwd=SCRIPT.parents[1]
    )
    assert result.returncode == 0, result.stderr
