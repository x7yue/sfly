"""发版说明的起点 tag（scripts/release/previous-tag.sh）：release.yml / std-release.yml 生成
变更列表时，平台的 vX.Y.Z 只与上一个平台版本比较，sfly-std 的 std-vX.Y.Z 只与上一个 std-vX.Y.Z
比较（#121）。
这里在临时 git 仓库里造 tag，验证选出的起点。"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "release" / "previous-tag.sh"


# 去掉继承来的 GIT_* 变量：在 pre-push 钩子里跑测试时 git 会设置 GIT_DIR 等，
# 不去掉的话下面的 git 命令会作用到真正的仓库上（提交、打 tag、改配置）。
ENV = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")} | {
    "GIT_AUTHOR_NAME": "test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": os.devnull,
}


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, env=ENV)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    git(tmp_path, "init", "--quiet")
    return tmp_path


def tag(repo: Path, *names: str) -> None:
    """按顺序每个 tag 打在一个新提交上（后打的更新）。"""
    for name in names:
        git(repo, "commit", "--quiet", "--allow-empty", "-m", name)
        git(repo, "tag", name)


def previous(repo: Path, current: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT), current], capture_output=True, text=True, cwd=repo, env=ENV
    )


def test_platform_release_starts_from_the_previous_platform_version(repo: Path) -> None:
    # std-v* 打在最近的提交上，按时间选会选错；按语义版本 0.0.10 > 0.0.9，按字典序会选错。
    tag(repo, "v0.0.2", "v0.0.3", "v0.0.9", "std-v0.1.0", "std-v0.2.0", "v0.0.10")

    result = previous(repo, "v0.0.10")

    assert result.returncode == 0, result.stderr
    assert result.stdout == "v0.0.9\n"


def test_platform_release_picks_the_highest_lower_version(repo: Path) -> None:
    tag(repo, "v0.0.2", "v0.0.10", "std-v0.1.0", "v0.0.3")

    assert previous(repo, "v0.0.3").stdout == "v0.0.2\n"
    assert previous(repo, "v0.1.0").stdout == "v0.0.10\n"


def test_first_platform_release_has_no_start_tag(repo: Path) -> None:
    tag(repo, "std-v0.1.0", "v0.0.1")

    result = previous(repo, "v0.0.1")

    assert result.returncode == 0, result.stderr
    assert result.stdout == ""


def test_std_release_starts_from_the_previous_std_version(repo: Path) -> None:
    tag(repo, "std-v0.1.0", "v0.0.3", "std-v0.1.10", "v0.0.4", "std-v0.2.0")

    result = previous(repo, "std-v0.2.0")

    assert result.returncode == 0, result.stderr
    assert result.stdout == "std-v0.1.10\n"


def test_first_std_release_has_no_start_tag(repo: Path) -> None:
    tag(repo, "v0.0.2", "v0.0.3", "std-v0.1.0")

    result = previous(repo, "std-v0.1.0")

    assert result.returncode == 0, result.stderr
    assert result.stdout == ""


def test_tags_that_are_not_x_y_z_are_ignored(repo: Path) -> None:
    tag(repo, "v0.0.2", "v0.0.3-rc.1", "vnext", "std-v0.1.0-rc.1", "release-0.0.9", "v0.0.4")

    assert previous(repo, "v0.0.4").stdout == "v0.0.2\n"
    assert previous(repo, "std-v0.1.0").stdout == ""


def test_accepts_a_full_ref(repo: Path) -> None:
    tag(repo, "v0.0.2", "v0.0.3")

    assert previous(repo, "refs/tags/v0.0.3").stdout == "v0.0.2\n"


@pytest.mark.parametrize("current", ["0.0.3", "v0.0.3-rc.1", "std-0.1.0", "x-v0.0.3", ""])
def test_rejects_a_tag_that_is_not_a_release_tag(repo: Path, current: str) -> None:
    result = previous(repo, current)

    assert result.returncode != 0
    assert "vX.Y.Z 或 std-vX.Y.Z" in result.stderr
