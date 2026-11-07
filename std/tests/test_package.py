"""构建出的 sfly-std 节点包：元信息合法、声明了最低 SDK 版本、依赖只写下限、每个节点都有文档。

发布流程（.github/workflows/std-release.yml）发布前也做同样的检查（scripts/release/std.sh）。
"""

from __future__ import annotations

import json
import re
import sys
import zipfile
from email.parser import Parser
from pathlib import Path
from typing import Any

import pytest

from sfly.cli.build import build

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

REPO = Path(__file__).resolve().parents[2]
STD = REPO / "std"
DOC = REPO / "docs" / "guide" / "standard-nodes.md"


@pytest.fixture(scope="module")
def archive(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return build(STD, tmp_path_factory.mktemp("sfly-std"))


@pytest.fixture(scope="module")
def metadata(archive: Path) -> dict[str, Any]:
    with zipfile.ZipFile(archive) as zf:
        result: dict[str, Any] = json.loads(zf.read("sfly-package.json"))
    return result


def test_archive_is_named_after_the_package_version(archive: Path) -> None:
    project = tomllib.loads((STD / "pyproject.toml").read_text(encoding="utf-8"))["project"]

    assert archive.name == f"sfly-std-{project['version']}.sflypkg"


def test_declares_the_minimum_sdk_version_explicitly(metadata: dict[str, Any]) -> None:
    # 不写时 sfly build 用构建时 SDK 的版本，会随平台版本上涨、无谓地拒绝旧 Agent（#79）。
    pyproject = tomllib.loads((STD / "pyproject.toml").read_text(encoding="utf-8"))
    declared = pyproject.get("tool", {}).get("sfly", {}).get("requires-sdk")

    assert declared, "std/pyproject.toml 必须声明 [tool.sfly] requires-sdk"
    assert metadata["requires_sdk"] == declared


def test_dependencies_only_have_lower_bounds(archive: Path) -> None:
    with zipfile.ZipFile(archive) as outer:
        wheel_name = next(n for n in outer.namelist() if n.endswith(".whl"))
        wheel = outer.extract(wheel_name, archive.parent / "wheel")
    with zipfile.ZipFile(wheel) as zf:
        meta_name = next(n for n in zf.namelist() if n.endswith(".dist-info/METADATA"))
        requires = Parser().parsestr(zf.read(meta_name).decode()).get_all("Requires-Dist") or []

    assert requires, "sfly-std 至少依赖 psutil 和 httpx"
    for requirement in requires:
        assert re.fullmatch(r"[A-Za-z0-9._-]+>=[0-9][0-9.]*", requirement.replace(" ", "")), (
            f"依赖只写宽松的下限（name>=X.Y），实际为 {requirement!r}"
        )


def test_every_node_has_a_chinese_title(metadata: dict[str, Any]) -> None:
    for node in metadata["nodes"]:
        assert re.search(r"[一-鿿]", node["title"]), node["name"]


def test_every_node_has_its_own_section_on_the_standard_nodes_page(
    metadata: dict[str, Any],
) -> None:
    sections = re.findall(r"^## `([a-z_][a-z0-9_]*)`", DOC.read_text(encoding="utf-8"), re.M)

    assert sorted(sections) == sorted(node["name"] for node in metadata["nodes"])
