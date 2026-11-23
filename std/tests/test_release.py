"""sfly-std 的发布打包（scripts/release/std.sh pack）：`std-vX.Y.Z` tag 触发的发布流程
（.github/workflows/std-release.yml）用它生成 Release 附件和发布说明，这里在本地按原样运行一遍。"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

from packaging.version import Version

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "release" / "std.sh"
PYPROJECT = tomllib.loads((REPO / "std" / "pyproject.toml").read_text(encoding="utf-8"))
VERSION: str = PYPROJECT["project"]["version"]
REQUIRES_SDK: str = PYPROJECT["tool"]["sfly"]["requires-sdk"]
REQUIRES_AGENT: str = PYPROJECT["tool"]["sfly"]["requires-agent"]


def minimum(requirement: str) -> Version:
    return Version(requirement.removeprefix(">="))


def pack(tag: str, out: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT), "pack", tag, str(out)], capture_output=True, text=True, cwd=REPO
    )


def test_pack_produces_the_package_checksums_and_release_notes(tmp_path: Path) -> None:
    result = pack(f"std-v{VERSION}", tmp_path)

    assert result.returncode == 0, result.stderr
    archive = tmp_path / f"sfly-std-{VERSION}.sflypkg"
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(
        [archive.name, "SHA256SUMS", "notes.md"]
    )
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert (tmp_path / "SHA256SUMS").read_text() == f"{digest}  {archive.name}\n"

    with zipfile.ZipFile(archive) as zf:
        nodes = json.loads(zf.read("sfly-package.json"))["nodes"]
    notes = (tmp_path / "notes.md").read_text(encoding="utf-8")
    assert f"sfly-std {VERSION}" in notes
    # 发布说明写明需要的最低 Agent 版本：requires-sdk（SDK 运行时随 Agent 安装）和 requires-agent
    # 里较高的那个，并列出这两项要求。
    lowest = max(minimum(REQUIRES_SDK), minimum(REQUIRES_AGENT))
    assert f"最低 Agent 版本：{lowest}**" in notes
    assert f"SDK 版本要求 `{REQUIRES_SDK}`" in notes
    assert f"Agent 版本要求 `{REQUIRES_AGENT}`" in notes
    for node in nodes:
        assert f"`{node['name']}`" in notes
        assert node["title"] in notes


#: 0.4.0 删掉的 14 个节点（ADR 0030）：发布说明和「标准节点」页都要逐个写明怎么替换。
REMOVED_IN_0_4_0 = [
    "system_monitor",
    "process_monitor",
    "wait_port",
    "wait_file",
    "wait_log_line",
    "follow_log",
    "collect_artifacts",
    "pull_files",
    "watch_files",
    "http_request",
    "assert",
    "file_assert",
    "process_assert",
    "port_assert",
]
CHANGES = REPO / "std" / "release-notes"


def test_the_release_notes_of_0_4_0_say_how_to_replace_every_removed_node() -> None:
    text = (CHANGES / "0.4.0.md").read_text(encoding="utf-8")
    rows = {
        cells[0].strip("` "): cells[1]
        for line in text.splitlines()
        if line.startswith("| `")
        for cells in [[c.strip() for c in line.strip("|").split("|", 1)]]
    }

    assert sorted(rows) == sorted(REMOVED_IN_0_4_0)
    assert all(replacement for replacement in rows.values())
    # 保留的三个节点没有被删。
    assert not {"shell", "start_process", "stop_process"} & set(rows)


def test_the_standard_nodes_page_has_the_same_upgrade_table_as_the_release_notes() -> None:
    # 「从 0.3.0 升级」一节的表和 Release 说明里的表是同一份：行一字不差。
    def rows(path: Path) -> list[str]:
        return [
            line
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.startswith("| `") or line.startswith("|---")
        ]

    page = REPO / "docs" / "guide" / "standard-nodes.md"
    page_rows = rows(page)
    notes_rows = rows(CHANGES / "0.4.0.md")

    assert notes_rows
    assert page_rows[-len(notes_rows) :] == notes_rows


def test_the_release_notes_of_the_version_are_appended_to_the_generated_notes(
    tmp_path: Path,
) -> None:
    result = pack(f"std-v{VERSION}", tmp_path)

    assert result.returncode == 0, result.stderr
    changes = CHANGES / f"{VERSION}.md"
    if changes.is_file():
        notes = (tmp_path / "notes.md").read_text(encoding="utf-8")
        assert changes.read_text(encoding="utf-8").rstrip("\n") in notes


def test_pack_rejects_a_tag_that_does_not_match_the_version(tmp_path: Path) -> None:
    result = pack("std-v99.0.0", tmp_path)

    assert result.returncode != 0
    assert f"std/pyproject.toml 的版本号是 {VERSION}，与 tag std-v99.0.0 不一致" in result.stderr
    assert list(tmp_path.iterdir()) == []


def test_pack_rejects_a_platform_tag(tmp_path: Path) -> None:
    result = pack(f"v{VERSION}", tmp_path)

    assert result.returncode != 0
    assert "tag 必须是 std-vX.Y.Z" in result.stderr
