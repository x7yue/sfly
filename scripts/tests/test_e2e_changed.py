"""PR 上重复运行改动的 e2e spec（scripts/e2e-changed.sh）：选错了
（漏掉改动的 spec、选上删掉的文件或公共文件），这一步要么白跑、要么形同虚设，而且没有任何报错。
这里在临时 git 仓库里造出各种改动，只验证选出的列表；重复运行本身由 CI 的 `e2e` job 验证。"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "e2e-changed.sh"
E2E = "apps/web/e2e"


def git(repo: Path, *args: str) -> str:
    # 去掉继承来的 GIT_* 变量（例如推送前钩子里的 GIT_DIR），否则命令作用到本仓库而不是临时仓库。
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    return subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", *args],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    ).stdout


def write(repo: Path, path: str, text: str) -> None:
    file = repo / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    # 脚本按自己所在位置找仓库根目录，所以把它放进临时仓库的 scripts/ 里运行。
    (tmp_path / "scripts").mkdir()
    shutil.copy(SCRIPT, tmp_path / "scripts" / SCRIPT.name)
    git(tmp_path, "init", "-b", "main")
    write(tmp_path, f"{E2E}/kept.spec.ts", "kept\n" * 20)
    write(tmp_path, f"{E2E}/gone.spec.ts", "gone\n" * 20)
    write(tmp_path, f"{E2E}/moved.spec.ts", "moved\n" * 20)
    write(tmp_path, f"{E2E}/edited.spec.ts", "edited\n")
    git(tmp_path, "add", "-A")
    git(tmp_path, "commit", "-m", "base")
    git(tmp_path, "tag", "base")
    return tmp_path


def run(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(repo / "scripts" / SCRIPT.name), *args],
        capture_output=True,
        text=True,
        cwd=repo,
    )


def listed(repo: Path, *refs: str) -> list[str]:
    result = run(repo, "--list", *refs)
    assert result.returncode == 0, result.stderr
    return result.stdout.splitlines()


def test_lists_added_modified_and_renamed_specs_relative_to_the_web_app(repo: Path) -> None:
    write(repo, f"{E2E}/edited.spec.ts", "edited again\n")
    write(repo, f"{E2E}/added.spec.ts", "added\n")
    write(repo, f"{E2E}/nested/deep.spec.ts", "deep\n")
    git(repo, "mv", f"{E2E}/moved.spec.ts", f"{E2E}/renamed.spec.ts")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "branch")

    assert sorted(listed(repo, "base")) == [
        "e2e/added.spec.ts",
        "e2e/edited.spec.ts",
        "e2e/nested/deep.spec.ts",
        "e2e/renamed.spec.ts",
    ]


def test_ignores_deleted_specs_and_files_that_are_not_e2e_specs(repo: Path) -> None:
    git(repo, "rm", "-q", f"{E2E}/gone.spec.ts")
    write(repo, f"{E2E}/support.ts", "shared helper\n")
    write(repo, "apps/web/src/unit.spec.ts", "not e2e\n")
    write(repo, f"{E2E}/notes.md", "doc\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "branch")

    assert listed(repo, "base") == []


def test_commits_added_to_the_base_after_the_branch_point_do_not_count(repo: Path) -> None:
    git(repo, "switch", "-c", "feature")
    write(repo, f"{E2E}/feature.spec.ts", "feature\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "feature")
    git(repo, "switch", "main")
    write(repo, f"{E2E}/other.spec.ts", "other\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "someone else merged")

    assert listed(repo, "main", "feature") == ["e2e/feature.spec.ts"]


def test_without_changed_specs_the_run_is_skipped_with_the_reason(repo: Path) -> None:
    result = run(repo, "base")

    assert result.returncode == 0, result.stderr
    assert "没有新增或改动的 e2e spec，跳过" in result.stdout


def test_without_a_base_the_nearer_of_origin_dev_and_origin_main_is_used(repo: Path) -> None:
    git(repo, "update-ref", "refs/remotes/origin/main", "base")
    git(repo, "switch", "-c", "dev")
    write(repo, f"{E2E}/on-dev.spec.ts", "on dev\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "merged into dev")
    git(repo, "update-ref", "refs/remotes/origin/dev", "HEAD")
    git(repo, "switch", "-c", "feature")
    write(repo, f"{E2E}/feature.spec.ts", "feature\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "feature")

    # 从 dev 拉出来的分支和 dev 比：dev 上已经有的 spec 不算这个分支的改动。
    assert listed(repo) == ["e2e/feature.spec.ts"]
    result = run(repo)
    assert "基准：origin/dev" in result.stdout

    # 从 main 拉出来的分支和 main 比：main 上有、dev 上还没有的 spec 不算这个分支的改动。
    git(repo, "switch", "-c", "main-ahead", "base")
    write(repo, f"{E2E}/on-main.spec.ts", "on main\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "merged into main")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(repo, "switch", "-c", "hotfix")
    write(repo, f"{E2E}/hotfix.spec.ts", "hotfix\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "hotfix")
    assert listed(repo) == ["e2e/hotfix.spec.ts"]


def test_without_origin_dev_the_base_is_origin_main(repo: Path) -> None:
    git(repo, "update-ref", "refs/remotes/origin/main", "base")
    write(repo, f"{E2E}/added.spec.ts", "added\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "branch")
    assert listed(repo) == ["e2e/added.spec.ts"]
