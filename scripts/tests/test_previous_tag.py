"""发版说明的起点 tag（scripts/release/previous-tag.sh）：release.yml / std-release.yml 生成
变更列表时，平台的 vX.Y.Z 只与上一个已发布的平台版本比较，sfly-std 的 std-vX.Y.Z 只与上一个
已发布的 std-vX.Y.Z 比较（#121）。
脚本从标准输入读候选 tag（工作流里是已发布 Release 的 tag 列表），
这里直接喂候选列表验证选出的起点。"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "release" / "previous-tag.sh"


def previous(current: str, *candidates: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT), current],
        input="".join(f"{tag}\n" for tag in candidates),
        capture_output=True,
        text=True,
    )


def test_platform_release_starts_from_the_previous_platform_version() -> None:
    # 按语义版本 0.0.10 > 0.0.9，按字典序会选错；std-v* 是另一个系列。
    result = previous("v0.0.10", "std-v0.2.0", "std-v0.1.0", "v0.0.9", "v0.0.3", "v0.0.2")

    assert result.returncode == 0, result.stderr
    assert result.stdout == "v0.0.9\n"


def test_platform_release_picks_the_highest_lower_version() -> None:
    candidates = ("v0.0.3", "std-v0.1.0", "v0.0.10", "v0.0.2")

    assert previous("v0.0.3", *candidates).stdout == "v0.0.2\n"
    assert previous("v0.1.0", *candidates).stdout == "v0.0.10\n"


def test_versions_not_lower_than_the_current_one_are_ignored() -> None:
    # 重新运行发版工作流时当前版本可能已在列表里；更高的版本也不能当起点。
    assert previous("v0.0.3", "v0.0.4", "v0.0.3", "v0.0.2").stdout == "v0.0.2\n"


def test_first_platform_release_has_no_start_tag() -> None:
    result = previous("v0.0.1", "std-v0.1.0")

    assert result.returncode == 0, result.stderr
    assert result.stdout == ""


def test_no_candidates_means_no_start_tag() -> None:
    result = previous("v0.0.1")

    assert result.returncode == 0, result.stderr
    assert result.stdout == ""


def test_std_release_starts_from_the_previous_std_version() -> None:
    result = previous("std-v0.2.0", "std-v0.1.10", "v0.0.4", "v0.0.3", "std-v0.1.0")

    assert result.returncode == 0, result.stderr
    assert result.stdout == "std-v0.1.10\n"


def test_first_std_release_has_no_start_tag() -> None:
    result = previous("std-v0.1.0", "v0.0.3", "v0.0.2")

    assert result.returncode == 0, result.stderr
    assert result.stdout == ""


def test_tags_that_are_not_x_y_z_are_ignored() -> None:
    candidates = ("v0.0.3-rc.1", "vnext", "std-v0.1.0-rc.1", "release-0.0.9", "v0.0.2")

    assert previous("v0.0.4", *candidates).stdout == "v0.0.2\n"
    assert previous("std-v0.1.0", *candidates).stdout == ""


def test_accepts_a_full_ref() -> None:
    assert previous("refs/tags/v0.0.3", "v0.0.2").stdout == "v0.0.2\n"


@pytest.mark.parametrize("current", ["0.0.3", "v0.0.3-rc.1", "std-0.1.0", "x-v0.0.3", ""])
def test_rejects_a_tag_that_is_not_a_release_tag(current: str) -> None:
    result = previous(current, "v0.0.2")

    assert result.returncode != 0
    assert "vX.Y.Z 或 std-vX.Y.Z" in result.stderr
