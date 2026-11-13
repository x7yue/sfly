"""统一版本号脚本（scripts/release/version.sh）的测试。

脚本按自己所在位置找仓库根目录，所以这里把它和它管理的文件复制进临时目录运行，不碰真实文件。
`set` 末尾刷新 Cargo.lock 和 uv.lock 要解析整个工作区，用空操作的 cargo、uv 顶替，
只检查版本号的改写。"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MANAGED = [
    "agent/Cargo.toml",
    "sdk/python/pyproject.toml",
    "sdk/python/src/sfly/__init__.py",
    "apps/server/package.json",
    "packages/client/package.json",
    "packages/client/src/version.ts",
]
CLIENT_FILES = ["packages/client/package.json", "packages/client/src/version.ts"]


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    for rel in [*MANAGED, "scripts/release/version.sh"]:
        target = tmp_path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / rel, target)
    tools = tmp_path / "bin"
    tools.mkdir()
    for tool in ("cargo", "uv"):
        stub = tools / tool
        stub.write_text("#!/bin/sh\nexit 0\n")
        stub.chmod(0o755)
    return tmp_path


def version_sh(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "PATH": f"{repo / 'bin'}{os.pathsep}{os.environ['PATH']}"}
    return subprocess.run(
        ["bash", str(repo / "scripts/release/version.sh"), *args],
        capture_output=True,
        text=True,
        env=env,
    )


def versions(repo: Path) -> dict[str, str]:
    result = version_sh(repo, "show")
    assert result.returncode == 0, result.stderr
    return dict(line.split("\t") for line in result.stdout.splitlines())


def rewrite(repo: Path, rel: str, old: str, new: str) -> None:
    file = repo / rel
    text = file.read_text()
    assert old in text
    file.write_text(text.replace(old, new, 1))


def test_show_lists_the_api_client_next_to_the_other_versions(repo: Path) -> None:
    shown = versions(repo)

    assert set(shown) == set(MANAGED)
    assert len(set(shown.values())) == 1


def test_check_passes_when_every_file_has_the_same_version(repo: Path) -> None:
    result = version_sh(repo, "check")

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == versions(repo)["apps/server/package.json"]


@pytest.mark.parametrize("rel", CLIENT_FILES)
def test_check_fails_when_the_api_client_version_differs(repo: Path, rel: str) -> None:
    current = versions(repo)[rel]
    rewrite(repo, rel, current, "9.9.9")

    result = version_sh(repo, "check")

    assert result.returncode == 1
    assert f"{rel} 的版本号是 '9.9.9'" in result.stderr
    assert versions(repo)[rel] == "9.9.9"


@pytest.mark.parametrize("rel", CLIENT_FILES)
def test_set_rewrites_the_api_client_version_too(repo: Path, rel: str) -> None:
    rewrite(repo, rel, versions(repo)[rel], "9.9.9")

    result = version_sh(repo, "set", "1.2.3")

    assert result.returncode == 0, result.stderr
    assert set(versions(repo).values()) == {"1.2.3"}
    assert version_sh(repo, "check").returncode == 0
    assert '"name": "@sfly/client"' in (repo / "packages/client/package.json").read_text()
    assert "CLIENT_VERSION" in (repo / "packages/client/src/version.ts").read_text()
