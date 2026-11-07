"""`sfly init`：用 uv 创建节点包项目，写入控制面的镜像与 sfly 索引配置、开发依赖和示例节点。

CLI 作为子进程运行，控制面与 PyPI 镜像都是本地桩（conftest.py），不访问外网。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any

import pytest
from indexes import FakeControlPlane, StaticServer, uv_env
from jsonschema import Draft202012Validator

from sfly.schemas import load_schema

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

SFLY = str(Path(sys.executable).parent / "sfly")
GUIDE = Path(__file__).resolve().parents[3] / "docs" / "guide"


@pytest.fixture
def work(tmp_path: Path) -> Path:
    """运行 sfly init 的目录；uv 缓存和 SFLY_HOME 在它旁边（tmp_path 下）。"""
    work = tmp_path / "work"
    work.mkdir()
    return work


def sfly_init(
    cwd: Path,
    *args: str,
    server: str | None = None,
    env_root: Path | None = None,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    command = [SFLY, "init", *args]
    if server:
        command += ["--server", server]
    env = uv_env(env_root or cwd.parent)
    env.update(extra_env or {})
    return subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=120)


def pyproject(project: Path) -> dict[str, Any]:
    with (project / "pyproject.toml").open("rb") as f:
        return tomllib.load(f)


def test_pyproject_has_mirrors_sfly_index_and_dev_dependencies(
    work: Path, control_plane: FakeControlPlane
) -> None:
    run = sfly_init(work, "demo", "--name", "demo-nodes", server=control_plane.url)

    assert run.returncode == 0, run.stderr
    data = pyproject(work / "demo")
    assert data["project"]["name"] == "demo-nodes"
    assert data["project"]["dependencies"] == []
    assert data["dependency-groups"]["dev"] == [
        f"sfly[cli]=={control_plane.version}",
        "pytest>=8",
        "ruff>=0.6",
    ]
    uv = data["tool"]["uv"]
    assert uv["python-install-mirror"] == control_plane.python_install_mirror
    assert uv["index"] == [
        {"name": "pypi-mirror", "url": control_plane.pypi_mirror, "default": True},
        {"name": "sfly", "url": f"{control_plane.url}/simple/", "explicit": True},
    ]
    assert uv["sources"] == {"sfly": {"index": "sfly"}}
    # 最低 SDK 版本写成当前版本：节点包用到的接口在更旧的 Agent 上可能没有（#79）。
    assert data["tool"]["sfly"] == {"requires-sdk": f">={control_plane.version}"}


def test_project_layout_from_uv_init_without_agent_instructions(
    work: Path, control_plane: FakeControlPlane
) -> None:
    run = sfly_init(work, "demo-nodes", server=control_plane.url)

    assert run.returncode == 0, run.stderr
    project = work / "demo-nodes"
    assert pyproject(project)["project"]["name"] == "demo-nodes"
    assert (project / ".python-version").read_text().strip() == "3.13"
    assert (project / ".git").is_dir()
    assert (project / ".gitignore").is_file()
    assert (project / "src" / "demo_nodes" / "example.py").is_file()
    assert (project / "tests" / "test_example.py").is_file()
    assert not (project / "AGENTS.md").exists()
    assert not (project / "CLAUDE.md").exists()
    assert "Hello from" not in (project / "src" / "demo_nodes" / "__init__.py").read_text()
    assert [p.name for p in work.iterdir()] == ["demo-nodes"]


def test_writes_node_dev_skill_for_codex_and_claude_code(
    work: Path, control_plane: FakeControlPlane
) -> None:
    run = sfly_init(work, "demo", server=control_plane.url)

    assert run.returncode == 0, run.stderr
    project = work / "demo"
    skill = project / ".agents" / "skills" / "sfly-node-dev"
    # 内容与仓库里的用户文档源文件相同（SDK 参考即 reference.md）。
    assert (skill / "SKILL.md").read_bytes() == (
        GUIDE / "skills" / "sfly-node-dev" / "SKILL.md"
    ).read_bytes()
    assert (skill / "reference.md").read_bytes() == (GUIDE / "sdk-reference.md").read_bytes()
    link = project / ".claude" / "skills" / "sfly-node-dev"
    assert link.is_symlink()
    # 相对链接：项目移动或克隆到别处后仍然有效。
    assert not Path(os.readlink(link)).is_absolute()
    assert link.resolve() == skill.resolve()


def test_without_mirrors_uses_uv_defaults(work: Path) -> None:
    server = StaticServer()
    plane = FakeControlPlane(server, version="1.2.3")
    try:
        run = sfly_init(work, "demo", server=plane.url)
    finally:
        server.close()

    assert run.returncode == 0, run.stderr
    data = pyproject(work / "demo")
    assert data["dependency-groups"]["dev"][0] == "sfly[cli]==1.2.3"
    assert "python-install-mirror" not in data["tool"]["uv"]
    assert data["tool"]["uv"]["index"] == [
        {"name": "sfly", "url": f"{plane.url}/simple/", "explicit": True}
    ]


def test_server_defaults_to_agent_env(work: Path, control_plane: FakeControlPlane) -> None:
    home = work.parent / "sfly-home"
    home.mkdir()
    (home / "agent.env").write_text(f"SFLY_CONTROL_PLANE_URL={control_plane.url}\n")

    run = sfly_init(work, "demo")

    assert run.returncode == 0, run.stderr
    assert "/sdk/project-settings" in control_plane.requests


def write_agent_env(work: Path, **entries: str) -> None:
    home = work.parent / "sfly-home"
    home.mkdir(exist_ok=True)
    (home / "agent.env").write_text("".join(f"{k}={v}\n" for k, v in entries.items()))


def test_local_mirror_overrides_in_agent_env_take_precedence_over_the_control_plane(
    work: Path, control_plane: FakeControlPlane
) -> None:
    write_agent_env(
        work,
        SFLY_INDEX_URL="https://pypi.local.example/simple/",
        SFLY_GITHUB_RELEASE_MIRROR="https://ustc.example/github-release",
        SFLY_PYTHON_INSTALL_MIRROR="https://nju.example/github-release/astral-sh/python-build-standalone/",
    )

    run = sfly_init(work, "demo", server=control_plane.url)

    assert run.returncode == 0, run.stderr
    uv = pyproject(work / "demo")["tool"]["uv"]
    assert uv["python-install-mirror"] == (
        "https://nju.example/github-release/astral-sh/python-build-standalone/"
    )
    assert uv["index"][0] == {
        "name": "pypi-mirror",
        "url": "https://pypi.local.example/simple/",
        "default": True,
    }


def test_python_mirror_derives_from_a_local_release_mirror_and_env_vars_beat_agent_env(
    work: Path, control_plane: FakeControlPlane
) -> None:
    write_agent_env(
        work,
        SFLY_INDEX_URL="https://pypi.agent-env.example/simple/",
        SFLY_GITHUB_RELEASE_MIRROR="https://agent-env.example/github-release",
    )

    run = sfly_init(
        work,
        "demo",
        server=control_plane.url,
        extra_env={"SFLY_GITHUB_RELEASE_MIRROR": "https://env.example/github-release/"},
    )

    assert run.returncode == 0, run.stderr
    uv = pyproject(work / "demo")["tool"]["uv"]
    assert uv["python-install-mirror"] == (
        "https://env.example/github-release/astral-sh/python-build-standalone/"
    )
    assert uv["index"][0]["url"] == "https://pypi.agent-env.example/simple/"


def test_invalid_name_fails_without_leftovers(work: Path, control_plane: FakeControlPlane) -> None:
    for args in (["Demo"], ["demo", "--name", "has space"], ["9lives"], ["sfly"]):
        run = sfly_init(work, *args, server=control_plane.url)
        assert run.returncode == 2, run.stderr
        assert "包名" in run.stderr
    assert list(work.iterdir()) == []


def test_non_empty_directory_is_left_untouched(work: Path, control_plane: FakeControlPlane) -> None:
    target = work / "demo"
    target.mkdir()
    (target / "notes.txt").write_text("我的笔记")

    run = sfly_init(work, "demo", server=control_plane.url)

    assert run.returncode == 2
    assert "不是空目录" in run.stderr
    assert [p.name for p in target.iterdir()] == ["notes.txt"]
    assert [p.name for p in work.iterdir()] == ["demo"]


def test_empty_directory_is_initialized_in_place(
    work: Path, control_plane: FakeControlPlane
) -> None:
    target = work / "demo"
    target.mkdir()

    run = sfly_init(target, ".", server=control_plane.url, env_root=work.parent)

    assert run.returncode == 0, run.stderr
    assert pyproject(target)["project"]["name"] == "demo"
    assert [p.name for p in work.iterdir()] == ["demo"]


def test_unreachable_control_plane_fails_without_leftovers(work: Path) -> None:
    server = StaticServer()
    url = server.url
    server.close()

    run = sfly_init(work, "demo", server=url)

    assert run.returncode == 1
    assert "无法连接控制面" in run.stderr
    assert list(work.iterdir()) == []


def run_in(project: Path, *command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["uv", "run", *command],
        cwd=project,
        env=uv_env(project.parent.parent),
        capture_output=True,
        text=True,
        timeout=300,
    )


def test_generated_project_syncs_tests_lints_runs_and_builds(
    work: Path, control_plane: FakeControlPlane, pypi_mirror: StaticServer
) -> None:
    assert sfly_init(work, "demo", server=control_plane.url).returncode == 0
    project = work / "demo"

    sync = subprocess.run(
        ["uv", "sync"], cwd=project, env=uv_env(work.parent), capture_output=True, text=True
    )
    assert sync.returncode == 0, sync.stderr
    # sfly 只从控制面的 sfly 索引解析，不去 PyPI 镜像找同名的包。
    assert "/simple/sfly/" in control_plane.requests
    assert "/pypi/simple/sfly/" not in pypi_mirror.requests
    assert "/pypi/simple/pytest/" in pypi_mirror.requests
    assert "pypi.org" not in (project / "uv.lock").read_text()

    for command in (["pytest"], ["ruff", "check"], ["ruff", "format", "--check"]):
        result = run_in(project, *command)
        assert result.returncode == 0, result.stdout + result.stderr

    run = run_in(project, "sfly", "run", "countdown", "--params", '{"name": "世界"}')
    assert run.returncode == 0, run.stderr
    outputs, _ = json.JSONDecoder().raw_decode(run.stdout.split("输出：\n", 1)[1])
    assert outputs == {"greeting": "你好，世界", "ticks": 3}
    assert "remaining" in run.stdout.split("指标：\n", 1)[1]

    build = run_in(project, "sfly", "build")
    assert build.returncode == 0, build.stderr
    with zipfile.ZipFile(project / "dist" / "demo-0.1.0.sflypkg") as zf:
        meta = json.loads(zf.read("sfly-package.json"))
        assert "demo-0.1.0-py3-none-any.whl" in zf.namelist()
    assert list(Draft202012Validator(load_schema("package-metadata")).iter_errors(meta)) == []
    assert [n["name"] for n in meta["nodes"]] == ["countdown"]

    # 项目 venv 里装的是 SDK wheel：skill 文件从 wheel 里读取；ruff format 不动 skill 目录。
    update = run_in(project, "sfly", "skill", "update")
    assert update.returncode == 0, update.stderr
