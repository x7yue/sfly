"""Agent 能力 files 的本地调试（`sfly.testing.run_node`、`sfly debug`）：没有 Agent，
`ctx.agent()` 直接操作本机的文件系统，其它 Agent 由测试工具映射到本地目录。
行为与 Agent 上一致（agent/tests/files.rs）。

节点取自 testdata/agent-files-package。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from sfly.testing import run_node

PACKAGE = Path(__file__).resolve().parents[3] / "testdata" / "agent-files-package"
SFLY = str(Path(sys.executable).parent / "sfly")


@pytest.fixture(autouse=True)
def package_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.syspath_prepend(str(PACKAGE / "src"))


def expected(path: Path, shown: str) -> dict[str, Any]:
    stat = path.stat()
    return {
        "path": shown,
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "device": stat.st_dev,
        "inode": stat.st_ino,
    }


def make_logs(root: Path) -> Path:
    """一台「Agent」上的 /var/log/app：app.log、app.log.1、notes.txt，old/app.log.2、
    old/deeper/app.log.3。"""
    logs = root / "var" / "log" / "app"
    (logs / "old" / "deeper").mkdir(parents=True)
    for name, body in [
        ("app.log", "current\n"),
        ("app.log.1", "rotated once\n"),
        ("notes.txt", "not a log\n"),
        ("old/app.log.2", "rotated twice\n"),
        ("old/deeper/app.log.3", "rotated three times\n"),
    ]:
        (logs / name).write_text(body, encoding="utf-8")
    return logs


def test_a_mapped_agent_lists_its_files_with_paths_as_seen_on_that_agent(tmp_path: Path) -> None:
    from sfly_agent_files import list_files

    source = tmp_path / "source"
    logs = make_logs(source)

    result = run_node(
        list_files,
        {
            "source": "fs-source",
            "directory": "/var/log/app",
            "pattern": "app.log*",
            "recursive": True,
        },
        agents={"fs-source": source},
        work_dir=tmp_path / "work",
    )

    assert result.status == "success", result.error
    names = ["app.log", "app.log.1", "old/app.log.2", "old/deeper/app.log.3"]
    assert result.outputs == {
        "files": [expected(logs / name, f"/var/log/app/{name}") for name in names]
    }


def test_the_own_agent_is_the_local_file_system(tmp_path: Path) -> None:
    from sfly_agent_files import list_files, stat_file

    logs = make_logs(tmp_path)

    listed = run_node(
        list_files, {"directory": str(logs), "pattern": "*.txt"}, work_dir=tmp_path / "w1"
    )
    stat = run_node(stat_file, {"path": str(logs / "app.log")}, work_dir=tmp_path / "w2")

    assert listed.status == "success", listed.error
    assert listed.outputs == {"files": [expected(logs / "notes.txt", str(logs / "notes.txt"))]}
    assert stat.outputs == {"file": expected(logs / "app.log", str(logs / "app.log"))}


def try_stat(tmp_path: Path, inputs: dict[str, Any], **kwargs: Any) -> Any:
    from sfly_agent_files import try_stat as node

    result = run_node(node, inputs, work_dir=tmp_path / "work", **kwargs)
    assert result.status == "success", result.error
    assert result.outputs is not None
    return result.outputs["error"]


def test_errors_tell_apart_missing_files_permissions_and_unreferenced_agents(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    logs = make_logs(source)

    assert try_stat(
        tmp_path,
        {"source": "fs-source", "path": "/var/log/app/gone.log"},
        agents={"fs-source": source},
    ) == {
        "type": "AgentFileNotFound",
        "kind": "not_found",
        "agent": "fs-source",
        "message": "Agent fs-source：/var/log/app/gone.log 不存在",
    }

    # 名称没有通过「Agent」类型的参数传进来：映射了也不能访问，和 Agent 上一样。
    error = try_stat(
        tmp_path,
        {"source": "fs-source", "name": "fs-other", "path": "/x"},
        agents={"fs-source": source, "fs-other": source},
    )
    assert error["type"] == "AgentNotReferenced"
    assert "Agent fs-other 不是" in error["message"]

    # 参数里有但没有映射：提示怎样映射。
    error = try_stat(tmp_path, {"source": "fs-source", "path": "/x"})
    assert error["type"] == "AgentUnreachable"
    assert "sfly debug --agent fs-source=<目录>" in error["message"]

    if os.geteuid() != 0:
        (logs / "old").chmod(0)
        try:
            error = try_stat(
                tmp_path,
                {"source": "fs-source", "path": "/var/log/app/old/app.log.2"},
                agents={"fs-source": source},
            )
        finally:
            (logs / "old").chmod(0o755)
        assert error["type"] == "AgentPermissionDenied"
        assert error["message"] == "Agent fs-source：没有权限访问 /var/log/app/old/app.log.2"


def test_paths_must_be_absolute(tmp_path: Path) -> None:
    from sfly_agent_files import stat_file

    result = run_node(stat_file, {"path": "var/log"}, work_dir=tmp_path)

    assert result.status == "failed"
    assert result.error is not None
    assert "路径必须是那台 Agent 所在机器上的绝对路径" in result.error.message


def test_sfly_debug_maps_an_agent_to_a_local_directory(tmp_path: Path) -> None:
    project = tmp_path / "project"
    shutil.copytree(PACKAGE, project, ignore=shutil.ignore_patterns("__pycache__", "dist"))
    source = tmp_path / "source"
    logs = make_logs(source)

    run = subprocess.run(
        [
            SFLY,
            "debug",
            "stat_file",
            "--params",
            '{"source": "fs-source", "path": "/var/log/app/app.log"}',
            "--agent",
            f"fs-source={source}",
        ],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert run.returncode == 0, run.stderr
    assert f'"inode": {(logs / "app.log").stat().st_ino}' in run.stdout
    assert '"path": "/var/log/app/app.log"' in run.stdout

    bad = subprocess.run(
        [SFLY, "debug", "stat_file", "--params", '{"path": "/"}', "--agent", "fs-source"],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert bad.returncode == 2
    assert "--agent 的格式是 <名称>=<目录>" in bad.stderr
