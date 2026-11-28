"""手工保持一致的版本号检查（scripts/check-versions.sh，`pnpm lint:versions`）。

脚本最初只管 Node 主版本，现在管所有「手工抄在几处、要保持一致」的版本号：Node 主版本、
Playwright 版本（CI 的镜像标签与 @playwright/test）、Python 版本（三处）、PostgreSQL 镜像（多处）。
每个用例把脚本和它读的文件复制进临时 git 仓库（脚本用 git grep），改一处，
看报错有没有指出是哪两处。"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = "scripts/check-versions.sh"
FILES = [
    SCRIPT,
    ".node-version",
    "package.json",
    ".python-version",
    "agent/src/environment.rs",
    "sdk/python/src/sfly/cli/init.py",
    "apps/web/package.json",
    ".github/workflows/ci.yml",
    "scripts/heavy.sh",
    "scripts/linux/run.sh",
]
ENV = {
    **{k: v for k, v in os.environ.items() if not k.startswith("GIT_")},
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.com",
}
# Python 会把 C 语言环境改成 UTF-8 再传给子进程；明确设回 C：
# macOS 的 grep 和 sed 在 C 语言环境里按字节处理，脚本里的汉字和正则要在那里也能用。
C_LOCALE = {"LC_ALL": "C", "LC_CTYPE": "C", "LANG": "C"}


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    for rel in FILES:
        target = tmp_path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / rel, target)
    subprocess.run(["git", "init", "-q", "-b", "main", str(tmp_path)], env=ENV, check=True)
    subprocess.run(["git", "-C", str(tmp_path), "add", "-A"], env=ENV, check=True)
    return tmp_path


def run(repo: Path, **env: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(repo / SCRIPT)],
        capture_output=True,
        text=True,
        env={**ENV, **env},
    )


def edit(repo: Path, rel: str, old: str, new: str, *, count: int = 1) -> None:
    file = repo / rel
    text = file.read_text(encoding="utf-8")
    assert text.count(old) >= count, f"{rel} 里没有 {old!r}"
    file.write_text(text.replace(old, new, count), encoding="utf-8")


def line_of(rel: str, needle: str) -> int:
    for number, line in enumerate((ROOT / rel).read_text(encoding="utf-8").splitlines(), 1):
        if needle in line:
            return number
    raise AssertionError(f"{rel} 里没有 {needle!r}")


def playwright_version() -> str:
    text = (ROOT / "apps/web/package.json").read_text(encoding="utf-8")
    return text.split('"@playwright/test": "')[1].split('"')[0]


def python_version() -> str:
    return (ROOT / ".python-version").read_text().strip()


def postgres_major() -> str:
    text = (ROOT / "scripts/linux/run.sh").read_text(encoding="utf-8")
    return text.split("pg_image=postgres:")[1].split()[0]


@pytest.mark.parametrize("env", [{}, C_LOCALE], ids=["utf8", "c-locale"])
def test_the_repository_as_it_is_passes(repo: Path, env: dict[str, str]) -> None:
    result = run(repo, **env)

    assert (result.returncode, result.stderr) == (0, "")


# Node 主版本（原有的两条检查）


def test_engines_that_differ_from_the_node_version_file_fail(repo: Path) -> None:
    edit(repo, "package.json", '"node": ">=', '"node": ">=1')

    result = run(repo)

    assert result.returncode == 1
    assert "engines.node" in result.stderr
    assert ".node-version" in result.stderr


def test_a_hard_coded_node_major_fails(repo: Path) -> None:
    # 脚本检查的就是这种写法，测试文件自己不能写出来（脚本也扫 scripts/）。
    (repo / "scripts/x.sh").write_text("FROM node:" + "26-slim\n")
    subprocess.run(["git", "-C", str(repo), "add", "-A"], env=ENV, check=True)

    result = run(repo)

    assert result.returncode == 1
    assert "scripts/x.sh:1" in result.stderr


# Playwright：CI 的镜像标签与 @playwright/test


def test_a_playwright_image_tag_that_differs_from_the_dependency_fails(repo: Path) -> None:
    current = playwright_version()
    edit(repo, ".github/workflows/ci.yml", f"playwright:v{current}-", "playwright:v1.0.0-")

    result = run(repo)

    assert result.returncode == 1
    # 报出是哪两处：各自的文件:行号和取值。
    ci_line = line_of(".github/workflows/ci.yml", "mcr.microsoft.com/playwright:")
    package_line = line_of("apps/web/package.json", '"@playwright/test"')
    assert f".github/workflows/ci.yml:{ci_line} 是 1.0.0" in result.stderr
    assert f"apps/web/package.json:{package_line} 是 {current}" in result.stderr
    assert "Playwright" in result.stderr


def test_a_playwright_upgrade_without_the_image_tag_fails(repo: Path) -> None:
    edit(
        repo,
        "apps/web/package.json",
        f'"@playwright/test": "{playwright_version()}"',
        '"@playwright/test": "9.9.9"',
    )

    result = run(repo)

    assert result.returncode == 1
    assert "是 9.9.9" in result.stderr


# Python：.python-version、Agent 建共享 venv 的默认版本、sfly init 建项目的版本


@pytest.mark.parametrize(
    ("rel", "line"),
    [
        ("agent/src/environment.rs", 'PYTHON_VERSION: &str = "{v}"'),
        ("sdk/python/src/sfly/cli/init.py", '\nPYTHON_VERSION = "{v}"'),
    ],
    ids=["agent", "sfly-init"],
)
def test_a_python_version_that_differs_from_the_version_file_fails(
    repo: Path, rel: str, line: str
) -> None:
    version = python_version()
    edit(repo, rel, line.format(v=version), line.format(v="3.99"))

    result = run(repo)

    assert result.returncode == 1
    assert f"{rel}:" in result.stderr
    assert "是 3.99" in result.stderr
    assert f".python-version:1 是 {version}" in result.stderr


def test_changing_only_the_version_file_names_both_other_places(repo: Path) -> None:
    (repo / ".python-version").write_text("3.99\n")

    result = run(repo)

    assert result.returncode == 1
    assert "agent/src/environment.rs:" in result.stderr
    assert "sdk/python/src/sfly/cli/init.py:" in result.stderr


# PostgreSQL 镜像：CI 的服务容器（三处）、pnpm heavy --pg、pnpm linux


@pytest.mark.parametrize(
    ("rel", "old", "new"),
    [
        ("scripts/heavy.sh", "postgres:{m} -c fsync=off", "postgres:99 -c fsync=off"),
        ("scripts/linux/run.sh", "pg_image=postgres:{m}", "pg_image=postgres:99"),
        (".github/workflows/ci.yml", "image: postgres:{m}", "image: postgres:99"),
    ],
    ids=["heavy", "linux", "ci"],
)
def test_a_postgres_image_that_differs_fails(repo: Path, rel: str, old: str, new: str) -> None:
    major = postgres_major()
    edit(repo, rel, old.format(m=major), new, count=1)

    result = run(repo)

    assert result.returncode == 1
    assert f"{rel}:" in result.stderr
    assert "是 99" in result.stderr
    assert "PostgreSQL" in result.stderr


def test_the_last_of_several_ci_service_images_is_checked_too(repo: Path) -> None:
    ci = repo / ".github/workflows/ci.yml"
    head, _, tail = ci.read_text(encoding="utf-8").rpartition(f"image: postgres:{postgres_major()}")
    ci.write_text(f"{head}image: postgres:99{tail}", encoding="utf-8")
    last_line = head.count("\n") + 1

    result = run(repo)

    assert result.returncode == 1
    assert f".github/workflows/ci.yml:{last_line} 是 99" in result.stderr


# 放行写法，以及检查本身对不上文件时不能静默通过


HEAVY_PG = "postgres:{} -c fsync=off -c max_connections=200 >/dev/null &"


def test_a_reason_on_the_line_lets_a_different_version_through(repo: Path) -> None:
    reason = " # sfly-version-ok: 测试旧库迁移"
    edit(repo, "scripts/heavy.sh", HEAVY_PG.format(postgres_major()), HEAVY_PG.format(99) + reason)

    assert run(repo).returncode == 0


def test_the_exception_needs_a_reason(repo: Path) -> None:
    edit(
        repo,
        "scripts/heavy.sh",
        HEAVY_PG.format(postgres_major()),
        HEAVY_PG.format(99) + " # sfly-version-ok:",
    )

    assert run(repo).returncode == 1


@pytest.mark.parametrize(
    ("rel", "needle", "name"),
    [
        ("apps/web/package.json", '"@playwright/test"', "Playwright"),
        (".github/workflows/ci.yml", "mcr.microsoft.com/playwright", "Playwright"),
        ("agent/src/environment.rs", "pub const PYTHON_VERSION", "Python"),
        ("sdk/python/src/sfly/cli/init.py", "PYTHON_VERSION =", "Python"),
        ("scripts/heavy.sh", "postgres:", "PostgreSQL"),
        ("scripts/linux/run.sh", "pg_image=", "PostgreSQL"),
    ],
)
def test_a_place_the_check_cannot_find_fails_instead_of_passing(
    repo: Path, rel: str, needle: str, name: str
) -> None:
    file = repo / rel
    file.write_text(
        file.read_text(encoding="utf-8").replace(needle, "renamed-away"), encoding="utf-8"
    )

    result = run(repo)

    assert result.returncode == 1
    assert f"在 {rel} 里找不到" in result.stderr
    assert "写法变了" in result.stderr
    assert "不存在" not in result.stderr
    assert name in result.stderr


@pytest.mark.parametrize(
    ("rel", "name"),
    [
        ("apps/web/package.json", "Playwright"),
        (".github/workflows/ci.yml", "Playwright"),
        (".python-version", "Python"),
        ("agent/src/environment.rs", "Python"),
        ("sdk/python/src/sfly/cli/init.py", "Python"),
        ("scripts/heavy.sh", "PostgreSQL"),
        ("scripts/linux/run.sh", "PostgreSQL"),
    ],
)
def test_a_file_that_is_gone_is_reported_as_a_path_not_a_pattern(
    repo: Path, rel: str, name: str
) -> None:
    (repo / rel).unlink()

    result = run(repo)

    assert result.returncode == 1
    assert f"{rel} 不存在" in result.stderr
    assert "路径" in result.stderr
    assert name in result.stderr
    # 不是「写法变了、改正则」，也没有 grep 自己的 No such file 混进来。
    assert "写法变了" not in result.stderr
    assert "No such file" not in result.stderr


@pytest.mark.parametrize("env", [{}, C_LOCALE], ids=["utf8", "c-locale"])
def test_every_failure_is_reported_in_one_run_whatever_the_locale(
    repo: Path, env: dict[str, str]
) -> None:
    edit(
        repo,
        ".github/workflows/ci.yml",
        f"playwright:v{playwright_version()}-",
        "playwright:v1.0.0-",
    )
    (repo / ".python-version").write_text("3.99\n")
    edit(
        repo,
        "scripts/linux/run.sh",
        f"pg_image=postgres:{postgres_major()}",
        "pg_image=postgres:99",
    )

    result = run(repo, **env)

    assert result.returncode == 1
    assert "Playwright" in result.stderr
    assert "Python" in result.stderr
    assert "PostgreSQL" in result.stderr
    assert "unbound variable" not in result.stderr
