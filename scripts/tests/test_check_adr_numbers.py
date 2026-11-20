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
    **{k: v for k, v in os.environ.items() if not k.startswith("GIT_") and k != "ADR_BASE_REF"},
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


def check(repo: Path, base_ref: str | None = None, **env: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(repo / "scripts" / "check-adr-numbers.sh")],
        env={**ENV, **env} if base_ref is None else {**ENV, **env, "ADR_BASE_REF": base_ref},
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


# 第三条规则：新 ADR 写了取代、推翻、修订某份旧 ADR，旧 ADR 末尾要追加一行指向它。


# Python 会把 C 语言环境改成 UTF-8 再传给子进程；明确设回 C：
# macOS 的 grep 在 C 语言环境里按字节匹配汉字，正则写法不对就匹配不上（或多匹配）。
C_LOCALE = {"LC_ALL": "C", "LC_CTYPE": "C", "LANG": "C"}


def supersede(
    work: Path, body: str, name: str = "0003-third.md", **env: str
) -> subprocess.CompletedProcess[str]:
    write(work, name, f"# 新的决定\n\n{body}\n")
    commit(work, "new adr")
    return check(work, **env)


@pytest.mark.parametrize("verb", ["取代", "取代了", "推翻", "推翻了", "修订", "修订了"])
def test_new_adr_that_replaces_an_old_one_without_a_pointer_fails(work: Path, verb: str) -> None:
    result = supersede(work, f"本决定{verb} ADR 0001 中的做法。")

    assert result.returncode == 1
    # 位置：新 ADR 的文件和行号，旧 ADR 的文件；怎么改：在旧 ADR 末尾追加指向新编号的一行。
    assert "docs/adr/0003-third.md:3" in result.stderr
    assert "docs/adr/0001-first.md" in result.stderr
    assert "ADR 0003" in result.stderr
    assert "末尾追加一行" in result.stderr
    assert "不加指针" in result.stderr


@pytest.mark.parametrize(
    "sentence", ["本决定取代 ADR 0001。", "本决定取代了 ADR 0001 和 ADR 0002。"]
)
def test_the_sentence_is_found_whatever_the_locale(work: Path, sentence: str) -> None:
    write(work, "0003-third.md", f"# 新的决定\n\n{sentence}\n")
    commit(work, "new adr")

    result = check(work, **C_LOCALE)

    assert result.returncode == 1
    assert "docs/adr/0001-first.md" in result.stderr


def test_pointer_appended_to_the_old_adr_makes_it_pass(work: Path) -> None:
    write(work, "0001-first.md", DECISION + "\n已被 ADR 0003 取代。\n")

    assert supersede(work, "本决定取代 ADR 0001 中的做法。").returncode == 0


def test_pointer_may_say_which_part_is_replaced_and_sit_in_any_appended_line(work: Path) -> None:
    write(work, "0001-first.md", DECISION + "\n## 修订\n\n- 其中第二段已被 ADR 0003 取代。\n")

    assert supersede(work, "本决定修订了 ADR 0001 的第二段。").returncode == 0


def test_pointer_to_a_different_adr_does_not_count(work: Path) -> None:
    write(work, "0001-first.md", DECISION + "\n已被 ADR 0002 取代。\n")

    result = supersede(work, "本决定取代 ADR 0001 中的做法。")

    assert result.returncode == 1
    assert "docs/adr/0001-first.md" in result.stderr


@pytest.mark.parametrize(
    "target",
    ["**ADR 0001**", "「ADR 0001」", "[ADR 0001](0001-first.md)", "**[ADR 0001](0001-first.md)**"],
)
def test_the_old_adr_may_be_written_with_markdown_around_it(work: Path, target: str) -> None:
    result = supersede(work, f"本决定取代 {target} 中的做法。")

    assert result.returncode == 1
    assert "docs/adr/0001-first.md" in result.stderr


@pytest.mark.parametrize(
    "body",
    [
        "沿用 ADR 0001 的做法。",
        "见 ADR 0001。",
        "与 ADR 0001 一致，ADR 0002 里的理由不变。",
        "ADR 0001 的结论不受影响，本决定不取代 ADR 0001。",
        "并不推翻 ADR 0001，也没有修订 ADR 0002。",
        "取代了旧的做法，见 ADR 0001。",
    ],
)
def test_plain_references_and_negations_do_not_need_a_pointer(work: Path, body: str) -> None:
    assert supersede(work, body).returncode == 0


def test_every_old_adr_named_in_one_sentence_needs_its_pointer(work: Path) -> None:
    write(work, "0001-first.md", DECISION + "\n已被 ADR 0003 取代。\n")

    result = supersede(work, "本决定取代 ADR 0001 和 ADR 0002 里的做法。")

    assert result.returncode == 1
    assert "docs/adr/0002-second.md" in result.stderr
    assert "docs/adr/0001-first.md" not in result.stderr


def test_new_adr_replacing_another_new_adr_of_the_same_branch_needs_no_pointer(work: Path) -> None:
    write(work, "0003-third.md", "# 先写的决定\n\n第一段。\n")
    commit(work, "first draft")

    assert supersede(work, "本决定取代 ADR 0003 中的做法。", "0004-fourth.md").returncode == 0


def test_a_reason_in_the_new_adr_lets_a_sentence_through(work: Path) -> None:
    reason = "只取代其中一句措辞，旧决定本身仍然有效"
    body = f"本决定取代 ADR 0001 中的做法。\n\n<!-- 不加指针 ADR 0001：{reason} -->"

    assert supersede(work, body).returncode == 0


@pytest.mark.parametrize("env", [{}, C_LOCALE], ids=["utf8", "c-locale"])
def test_the_exception_needs_a_reason_and_names_the_adr(work: Path, env: dict[str, str]) -> None:
    for marker in ("<!-- 不加指针 ADR 0001： -->", "<!-- 不加指针 ADR 0002：别的原因 -->"):
        result = supersede(work, f"本决定取代 ADR 0001 中的做法。\n\n{marker}", **env)

        assert result.returncode == 1, marker
        git(work, "reset", "--hard", "HEAD~1")


def test_adr_that_was_already_accepted_with_such_a_sentence_is_not_checked(
    origin: Path, tmp_path: Path
) -> None:
    write(origin, "0003-old.md", "# 旧决定\n\n本决定取代 ADR 0001 中的做法。\n")
    commit(origin, "accept")
    clone = tmp_path / "work3"
    subprocess.run(
        ["git", "clone", str(origin), str(clone)], env=ENV, check=True, capture_output=True
    )

    assert check(clone).returncode == 0


def test_sentence_naming_an_adr_that_does_not_exist_is_not_this_checks_business(work: Path) -> None:
    assert supersede(work, "本决定取代 ADR 0099 中的做法。").returncode == 0
