"""统一版本号脚本（scripts/release/version.sh）的测试。

脚本按自己所在位置找仓库根目录，所以这里把它和它管理的文件复制进临时目录运行，不碰真实文件。
`set` 末尾刷新 Cargo.lock 和 uv.lock 要解析整个工作区，用空操作的 cargo、uv 顶替，
只检查版本号的改写。"""

from __future__ import annotations

import json
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
    "apps/assistant/package.json",
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


def test_the_assistant_image_reports_the_release_version(repo: Path) -> None:
    # 助手镜像随每个版本发布，/health 报的助手服务版本读 apps/assistant/package.json（#549）：
    # 它和别的版本号一起检查、一起改。
    rel = "apps/assistant/package.json"
    rewrite(repo, rel, versions(repo)[rel], "9.9.9")

    failed = version_sh(repo, "check")
    assert failed.returncode == 1
    assert f"{rel} 的版本号是 '9.9.9'" in failed.stderr

    assert version_sh(repo, "set", "1.2.3").returncode == 0
    assert versions(repo)[rel] == "1.2.3"
    assert '"name": "@sfly/assistant"' in (repo / rel).read_text()


# 带 tag 的发版检查（release.yml 的 prepare job）多一条：
# 发版性能报告 docs/perf/X.Y.Z/report.json 已经提交，版本号与 tag 一致
# （发版前必跑 pnpm perf --release，0.4.0 漏过一次）。不带参数的 check 不看它。


def write_perf_report(repo: Path, directory: str, sfly_version: str | None) -> Path:
    report = repo / "docs/perf" / directory / "report.json"
    report.parent.mkdir(parents=True)
    version = {} if sfly_version is None else {"sfly": sfly_version}
    report.write_text(json.dumps({"schema": 2, "version": version, "ok": True}))
    return report


def test_check_without_a_tag_does_not_look_at_the_perf_report(repo: Path) -> None:
    assert not (repo / "docs/perf").exists()

    assert version_sh(repo, "check").returncode == 0


def test_check_with_the_tag_passes_when_the_perf_report_is_committed(repo: Path) -> None:
    current = versions(repo)["apps/server/package.json"]
    write_perf_report(repo, current, current)

    result = version_sh(repo, "check", f"v{current}")

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == current


def test_check_accepts_the_tag_as_a_full_ref(repo: Path) -> None:
    current = versions(repo)["apps/server/package.json"]
    write_perf_report(repo, current, current)

    assert version_sh(repo, "check", f"refs/tags/v{current}").returncode == 0


def test_check_with_the_tag_fails_when_the_perf_report_is_missing(repo: Path) -> None:
    current = versions(repo)["apps/server/package.json"]

    result = version_sh(repo, "check", f"v{current}")

    assert result.returncode == 1
    assert f"docs/perf/{current}/report.json 不存在" in result.stderr
    assert "pnpm perf --release" in result.stderr
    assert result.stdout == ""


def test_check_with_the_tag_fails_when_the_report_is_for_another_version(repo: Path) -> None:
    current = versions(repo)["apps/server/package.json"]
    write_perf_report(repo, current, "9.9.9")

    result = version_sh(repo, "check", f"v{current}")

    assert result.returncode == 1
    assert f"docs/perf/{current}/report.json" in result.stderr
    assert "'9.9.9'" in result.stderr
    assert f"'{current}'" in result.stderr


def test_check_with_the_tag_fails_when_the_report_has_no_version(repo: Path) -> None:
    current = versions(repo)["apps/server/package.json"]
    write_perf_report(repo, current, None)

    assert version_sh(repo, "check", f"v{current}").returncode == 1


def test_check_with_the_tag_fails_when_the_report_is_not_json(repo: Path) -> None:
    current = versions(repo)["apps/server/package.json"]
    write_perf_report(repo, current, current).write_text("not json")

    result = version_sh(repo, "check", f"v{current}")

    assert result.returncode == 1
    assert f"docs/perf/{current}/report.json" in result.stderr


def test_a_perf_report_of_another_version_does_not_stand_in(repo: Path) -> None:
    current = versions(repo)["apps/server/package.json"]
    write_perf_report(repo, "0.0.1", "0.0.1")

    result = version_sh(repo, "check", f"v{current}")

    assert result.returncode == 1
    assert f"docs/perf/{current}/report.json 不存在" in result.stderr


def test_a_version_mismatch_is_reported_before_the_perf_report(repo: Path) -> None:
    result = version_sh(repo, "check", "v9.9.9")

    assert result.returncode == 1
    assert "版本号是" in result.stderr
    assert "perf" not in result.stderr


def test_an_empty_tag_argument_is_an_error_not_the_plain_check(repo: Path) -> None:
    result = version_sh(repo, "check", "")

    assert result.returncode == 1
    assert "tag 必须是 vX.Y.Z" in result.stderr
