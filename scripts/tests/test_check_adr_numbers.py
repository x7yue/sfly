"""ADR 检查（scripts/check-adr-numbers.sh）：新增 ADR 的编号被 origin/main 占了、
改了已接受 ADR 的正文，都要报错；末尾追加指向新 ADR 的一行、没动 ADR 的分支要通过。
每个用例在临时目录里建一个「origin」仓库和它的克隆，不碰真实仓库的引用。"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check-adr-numbers.sh"
ENV = {
    **{k: v for k, v in os.environ.items() if not k.startswith("GIT_")},
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.com",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
}
DECISION = "# 决定\n\n第一段。\n\n第二段。\n"


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], env=ENV, check=True, capture_output=True)


def commit(repo: Path, message: str) -> None:
    git(repo, "add", "-A")
    git(repo, "commit", "-m", message)


def write(repo: Path, name: str, text: str = DECISION) -> None:
    (repo / "docs" / "adr" / name).write_text(text, encoding="utf-8")


def check(repo: Path, base_ref: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(repo / "scripts" / "check-adr-numbers.sh")],
        env=ENV if base_ref is None else {**ENV, "ADR_BASE_REF": base_ref},
        capture_output=True,
        text=True,
    )


@pytest.fixture
def origin(tmp_path: Path) -> Path:
    repo = tmp_path / "origin"
    (repo / "docs" / "adr").mkdir(parents=True)
    (repo / "scripts").mkdir()
    shutil.copy(SCRIPT, repo / "scripts" / "check-adr-numbers.sh")
    write(repo, "0001-first.md")
    write(repo, "0002-second.md")
    git(repo, "init", "-b", "main")
    commit(repo, "init")
    return repo


@pytest.fixture
def work(origin: Path, tmp_path: Path) -> Path:
    clone = tmp_path / "work"
    subprocess.run(
        ["git", "clone", str(origin), str(clone)], env=ENV, check=True, capture_output=True
    )
    git(clone, "checkout", "-b", "feature")
    return clone


def test_branch_that_touches_no_adr_passes(work: Path) -> None:
    assert check(work).returncode == 0


def test_new_adr_with_a_free_number_passes(work: Path) -> None:
    write(work, "0003-third.md")
    commit(work, "add")

    assert check(work).returncode == 0


def test_new_adr_whose_number_was_taken_on_main_meanwhile_fails(origin: Path, work: Path) -> None:
    write(work, "0003-mine.md")
    commit(work, "add mine")
    write(origin, "0003-theirs.md")
    write(origin, "0004-also.md")
    commit(origin, "add theirs")
    git(work, "fetch", "origin")

    result = check(work)

    assert result.returncode == 1
    assert "0003" in result.stderr
    assert "docs/adr/0003-theirs.md" in result.stderr
    assert "docs/adr/0003-mine.md" in result.stderr
    assert "0005" in result.stderr


def test_number_taken_on_the_integration_branch_is_caught_when_it_is_the_base(
    origin: Path, work: Path
) -> None:
    git(origin, "checkout", "-b", "dev")
    write(origin, "0003-theirs.md")
    commit(origin, "add theirs on dev")
    git(origin, "checkout", "main")
    write(work, "0003-mine.md")
    commit(work, "add mine")
    git(work, "fetch", "origin")

    assert check(work).returncode == 0
    result = check(work, base_ref="origin/dev")

    assert result.returncode == 1
    assert "origin/dev" in result.stderr
    assert "docs/adr/0003-theirs.md" in result.stderr
    assert "docs/adr/0003-mine.md" in result.stderr


def test_adr_accepted_on_the_integration_branch_keeps_its_body_when_it_is_the_base(
    origin: Path, work: Path
) -> None:
    git(origin, "checkout", "-b", "dev")
    write(origin, "0003-on-dev.md")
    commit(origin, "accept on dev")
    git(origin, "checkout", "main")
    git(work, "fetch", "origin")
    git(work, "checkout", "-b", "feature-on-dev", "origin/dev")
    write(work, "0003-on-dev.md", "# 决定\n\n第一段改了。\n\n第二段。\n")
    commit(work, "edit")

    assert check(work).returncode == 0
    result = check(work, base_ref="origin/dev")

    assert result.returncode == 1
    assert "docs/adr/0003-on-dev.md" in result.stderr


def test_missing_base_ref_is_named_in_the_notice(work: Path) -> None:
    result = check(work, base_ref="origin/nope")

    assert result.returncode == 0
    assert "没有 origin/nope" in result.stderr


def test_merging_main_in_turns_the_collision_into_one_plain_duplicate_report(
    origin: Path, work: Path
) -> None:
    write(work, "0003-mine.md")
    commit(work, "add mine")
    write(origin, "0003-theirs.md")
    commit(origin, "add theirs")
    git(work, "fetch", "origin")
    git(work, "merge", "origin/main", "-m", "merge main")

    result = check(work)

    assert result.returncode == 1
    assert result.stderr.count("ADR 编号 0003") == 1


def test_editing_the_middle_of_an_accepted_adr_fails(work: Path) -> None:
    write(work, "0002-second.md", "# 决定\n\n第一段改了。\n\n第二段。\n")
    commit(work, "edit")

    result = check(work)

    assert result.returncode == 1
    assert "docs/adr/0002-second.md" in result.stderr
    assert "CODING_STANDARDS.md「文档」" in result.stderr
    assert "追加一行" in result.stderr


def test_uncommitted_edit_of_an_accepted_adr_fails(work: Path) -> None:
    write(work, "0001-first.md", "# 另一个决定\n")

    assert check(work).returncode == 1


def test_deleting_or_renaming_an_accepted_adr_fails(work: Path) -> None:
    git(work, "mv", "docs/adr/0002-second.md", "docs/adr/0002-renamed.md")
    commit(work, "rename")

    result = check(work)

    assert result.returncode == 1
    assert "docs/adr/0002-second.md" in result.stderr


def test_appending_a_pointer_line_to_an_accepted_adr_passes(work: Path) -> None:
    write(work, "0002-second.md", DECISION + "\n已被 ADR 0003 取代。\n")
    write(work, "0003-third.md")
    commit(work, "supersede")

    assert check(work).returncode == 0


def test_appending_to_an_adr_without_a_final_newline_fails(origin: Path, tmp_path: Path) -> None:
    write(origin, "0001-first.md", "# 决定\n\n没有结尾换行")
    commit(origin, "no newline")
    clone = tmp_path / "work2"
    subprocess.run(
        ["git", "clone", str(origin), str(clone)], env=ENV, check=True, capture_output=True
    )
    write(clone, "0001-first.md", "# 决定\n\n没有结尾换行，接着写\n")

    assert check(clone).returncode == 1


def test_adr_that_main_edited_after_the_merge_base_is_not_blamed_on_the_branch(
    origin: Path, work: Path
) -> None:
    write(origin, "0002-second.md", DECISION + "\n已被 ADR 0003 取代。\n")
    write(origin, "0003-third.md")
    commit(origin, "supersede on main")
    git(work, "fetch", "origin")

    assert check(work).returncode == 0


def test_without_origin_main_it_says_so_and_still_checks_duplicates(work: Path) -> None:
    git(work, "remote", "remove", "origin")
    write(work, "0002-other.md")
    commit(work, "dup")

    result = check(work)

    assert result.returncode == 1
    assert "没有 origin/main" in result.stderr
    assert "docs/adr/0002-other.md" in result.stderr


def test_without_origin_main_clean_tree_passes_with_one_line_notice(work: Path) -> None:
    git(work, "remote", "remove", "origin")
    write(work, "0002-second.md", "# 改了\n")

    result = check(work)

    assert result.returncode == 0
    assert result.stderr.count("\n") == 1
