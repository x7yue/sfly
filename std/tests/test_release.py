"""sfly-std 的发布打包（scripts/release/std.sh pack）：`std-vX.Y.Z` tag 触发的发布流程
（.github/workflows/std-release.yml）用它生成 Release 附件和发布说明，这里在本地按原样运行一遍。"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "release" / "std.sh"
PYPROJECT = tomllib.loads((REPO / "std" / "pyproject.toml").read_text(encoding="utf-8"))
VERSION: str = PYPROJECT["project"]["version"]
REQUIRES_SDK: str = PYPROJECT["tool"]["sfly"]["requires-sdk"]


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
    # 发布说明写明需要的最低 Agent 版本（即 requires-sdk）。
    assert f"最低 Agent 版本：{REQUIRES_SDK.removeprefix('>=')}" in notes
    for node in nodes:
        assert f"`{node['name']}`" in notes
        assert node["title"] in notes


def test_pack_rejects_a_tag_that_does_not_match_the_version(tmp_path: Path) -> None:
    result = pack("std-v99.0.0", tmp_path)

    assert result.returncode != 0
    assert f"std/pyproject.toml 的版本号是 {VERSION}，与 tag std-v99.0.0 不一致" in result.stderr
    assert list(tmp_path.iterdir()) == []


def test_pack_rejects_a_platform_tag(tmp_path: Path) -> None:
    result = pack(f"v{VERSION}", tmp_path)

    assert result.returncode != 0
    assert "tag 必须是 std-vX.Y.Z" in result.stderr
