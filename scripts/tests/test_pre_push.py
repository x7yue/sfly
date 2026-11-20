"""推送前钩子（.githooks/pre-push）的分支名检查：推送的目标引用（remote_ref）要用约定的前缀。

团队成员都在名叫 cindy/<名字> 的本地分支上推送：`git push origin HEAD:<前缀>/<描述>`，
钩子看的是目标引用，不是本地分支名。
允许的前缀由 docs/agents/branching-and-release.md「分支命名」表的第一列定义，
钩子读这张表（不另写一份），另加 main 和 dev。
钩子后面的检查（依赖、生成代码、lint、类型检查）这里不跑：临时仓库里没有 node_modules，
通过分支名检查的推送会在「还没装依赖」那一步停下，以此区分「分支名通过」和「分支名被拒绝」。"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
HOOK = ".githooks/pre-push"
DOC = "docs/agents/branching-and-release.md"
ZERO = "0" * 40
SHA = "1" * 40
PASSED = "还没装依赖"  # 钩子里分支名检查之后的第一个检查，临时仓库里一定在这里停下。
REJECTED = "不合约定的前缀"


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    subprocess.run(["git", "init", "-q", "-b", "main", str(tmp_path)], check=True, env=env)
    for rel in (HOOK, DOC):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / rel, tmp_path / rel)
    return tmp_path


def push(
    repo: Path, *refs: str, local: str = "refs/heads/cindy/work"
) -> subprocess.CompletedProcess[str]:
    """按 git 给钩子的格式喂标准输入：`<本地引用> <本地提交> <远端引用> <远端提交>`。"""
    lines = "".join(f"{local} {SHA} {ref} {ZERO}\n" for ref in refs)
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    return subprocess.run(
        ["bash", str(repo / HOOK), "origin", "git@example.com:x/y.git"],
        input=lines,
        capture_output=True,
        text=True,
        cwd=repo,
        env=env,
    )


def prefixes_in_doc() -> list[str]:
    """文档表格第一列的前缀，和钩子无关地再读一遍，只用来写期望值。"""
    text = (ROOT / DOC).read_text(encoding="utf-8")
    section = text.split("## 分支命名", 1)[1].split("\n## ", 1)[0]
    return re.findall(r"^\| `([a-z]+/)[^`]*` \|", section, flags=re.MULTILINE)


def test_the_doc_table_still_has_prefixes_the_hook_can_read() -> None:
    # 前缀本身以表为准，这里只保证表的格式没变：至少有一行，每个都以 / 结尾。
    prefixes = prefixes_in_doc()

    assert prefixes
    assert all(prefix.endswith("/") for prefix in prefixes)
    assert {"fix/", "chore/", "release/"} <= set(prefixes)


@pytest.mark.parametrize(
    "branch",
    [
        "spec/430-small-checks",
        "impl/small-checks",
        "design/branch-names",
        "fix/430-typo",
        "chore/small-checks",
        "release/0.6.0",
        "release/std-0.2.0",
        "main",
        "dev",
    ],
)
def test_branch_names_with_an_agreed_prefix_pass(repo: Path, branch: str) -> None:
    result = push(repo, f"refs/heads/{branch}")

    assert REJECTED not in result.stderr
    assert PASSED in result.stderr


def test_pushing_from_a_cindy_branch_to_an_agreed_name_is_fine(repo: Path) -> None:
    # 本地分支叫 cindy/x，推到 chore/x：看的是目标引用。
    result = push(repo, "refs/heads/chore/x", local="refs/heads/cindy/x")

    assert REJECTED not in result.stderr
    assert PASSED in result.stderr


@pytest.mark.parametrize(
    "branch",
    [
        "cindy/optimistic-dijkstra",  # 推送时没有改名：git push origin HEAD
        "docs/typo",
        "feature",
        "Chore/small-checks",
        "chore/",
        "hotfix/x",
        "main2",
        "dev-x",
        "release",
    ],
)
def test_branch_names_without_an_agreed_prefix_are_rejected(repo: Path, branch: str) -> None:
    result = push(repo, f"refs/heads/{branch}")

    assert result.returncode == 1
    assert REJECTED in result.stderr
    assert f"分支名 {branch} " in result.stderr
    # 报错里列出允许的前缀和改法。
    for prefix in prefixes_in_doc():
        assert prefix in result.stderr
    assert "main" in result.stderr
    assert "dev" in result.stderr
    assert "git push -u origin HEAD:<前缀>/<描述>" in result.stderr
    assert "--no-verify" in result.stderr
    assert PASSED not in result.stderr


def test_every_bad_name_of_one_push_is_reported(repo: Path) -> None:
    result = push(repo, "refs/heads/cindy/a", "refs/heads/chore/ok", "refs/heads/docs/b")

    assert result.returncode == 1
    assert "分支名 cindy/a " in result.stderr
    assert "分支名 docs/b " in result.stderr
    assert "分支名 chore/ok " not in result.stderr


def test_tags_and_deleting_a_remote_branch_are_skipped(repo: Path) -> None:
    tag = push(repo, "refs/tags/v0.6.0")
    delete = subprocess.run(
        ["bash", str(repo / HOOK), "origin", "url"],
        input=f"(delete) {ZERO} refs/heads/cindy/old {SHA}\n",
        capture_output=True,
        text=True,
        cwd=repo,
        env={k: v for k, v in os.environ.items() if not k.startswith("GIT_")},
    )

    assert (tag.returncode, tag.stderr) == (0, "")
    assert (delete.returncode, delete.stderr) == (0, "")


def test_only_branches_have_names_to_check(repo: Path) -> None:
    result = push(repo, "refs/notes/commits")

    assert REJECTED not in result.stderr


def test_the_prefixes_come_from_the_doc_table(repo: Path) -> None:
    doc = repo / DOC
    text = doc.read_text(encoding="utf-8")
    doc.write_text(
        text.replace("| `chore/<描述>` |", "| `hotfix/<描述>` | 紧急修复 |\n| `chore/<描述>` |"),
        encoding="utf-8",
    )

    assert REJECTED not in push(repo, "refs/heads/hotfix/x").stderr

    doc.write_text(text.replace("| `chore/<描述>` |", "| `deleted/<描述>` |"), encoding="utf-8")

    assert REJECTED in push(repo, "refs/heads/chore/x").stderr


def test_an_unreadable_table_stops_the_push_instead_of_letting_everything_through(
    repo: Path,
) -> None:
    (repo / DOC).write_text("# 分支、PR 与发版\n\n## 分支命名\n\n没有表格了。\n", encoding="utf-8")

    result = push(repo, "refs/heads/chore/x")

    assert result.returncode == 1
    assert DOC in result.stderr
    assert "分支命名" in result.stderr
    assert PASSED not in result.stderr


def test_a_missing_table_file_says_so_instead_of_exiting_silently(repo: Path) -> None:
    (repo / DOC).unlink()

    result = push(repo, "refs/heads/chore/x")

    assert result.returncode == 1
    assert DOC in result.stderr
    assert PASSED not in result.stderr
