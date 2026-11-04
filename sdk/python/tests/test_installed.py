"""`python -m sfly.installed`：列出当前环境中安装的节点包（供 Agent 生成 Hello、查找入口）。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from sfly.cli import main

SDK_SRC = Path(__file__).resolve().parents[1] / "src"


def build_package(
    root: Path, name: str, version: str, dependencies: list[str] | None = None
) -> Path:
    module = name.replace("-", "_")
    (root / "src" / module).mkdir(parents=True)
    (root / "pyproject.toml").write_text(
        f'[project]\nname = "{name}"\nversion = "{version}"\n'
        f"dependencies = {json.dumps(dependencies or [])}\n",
        encoding="utf-8",
    )
    (root / "src" / module / "__init__.py").write_text(
        "from sfly import node\n\n@node(outputs=['text'])\ndef echo(text: str) -> dict:\n"
        "    return {'text': text}\n",
        encoding="utf-8",
    )
    assert main(["build", str(root)]) == 0
    return root / "dist" / f"{name}-{version}.sflypkg"


def install_wheel(archive: Path, site: Path) -> None:
    """纯 Python wheel 解压到 site 目录即为安装。"""
    with zipfile.ZipFile(archive) as zf:
        wheel = next(n for n in zf.namelist() if n.endswith(".whl"))
        zf.extract(wheel, site.parent)
    with zipfile.ZipFile(site.parent / wheel) as wf:
        wf.extractall(site)


def test_lists_installed_node_packages_with_their_metadata_and_requirements(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    site = tmp_path / "site"
    archive = build_package(
        tmp_path / "proj", "demo-echo", "0.3.0", ["requests>=2", "rich==13.0; python_version>'3'"]
    )
    capsys.readouterr()
    install_wheel(archive, site)

    out = subprocess.run(
        [sys.executable, "-m", "sfly.installed"],
        env={**os.environ, "PYTHONPATH": os.pathsep.join([str(SDK_SRC), str(site)])},
        check=True,
        capture_output=True,
        text=True,
    ).stdout

    with zipfile.ZipFile(archive) as zf:
        metadata = json.loads(zf.read("sfly-package.json"))
    # requires：每个节点包 wheel 的 Requires-Dist（Agent 安装其他包时据此检查依赖冲突）。
    assert json.loads(out) == {
        "packages": [metadata],
        "requires": {"demo-echo": ["requests>=2", "rich==13.0; python_version>'3'"]},
    }
    assert metadata["nodes"][0]["entry"] == "demo_echo:echo"
