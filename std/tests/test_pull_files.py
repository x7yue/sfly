"""`pull_files`：把另一台 Agent 上匹配的文件拉到本地目录（`sfly.testing.run_node`）。

来源 Agent `a-01` 映射到临时目录（`run_node(agents=...)`）：它上面的 `/var/log/app` 落在
`<临时目录>/var/log/app`，节点看到的路径仍是 `/var/log/app/...`。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from sfly.testing import Execution, run_node
from sfly_std.pull_files import pull_files

SOURCE = "a-01"
#: 来源 Agent 上的目录（那台 Agent 上的绝对路径）。
LOGS = "/var/log/app"


def source_files(root: Path, files: dict[str, bytes]) -> Path:
    """在来源 Agent（映射到 `root`）的 `LOGS` 下建文件，返回它在本机上的位置。"""
    logs = root / LOGS.lstrip("/")
    for name, data in files.items():
        path = logs / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    logs.mkdir(parents=True, exist_ok=True)
    return logs


def run(tmp_path: Path, **inputs: Any) -> Execution:
    return run_node(
        pull_files,
        {"source": SOURCE, "directory": LOGS, **inputs},
        work_dir=tmp_path / "task",
        agents={SOURCE: tmp_path / "a"},
    )


def test_pulls_the_matching_files_into_the_local_directory(tmp_path: Path) -> None:
    source_files(
        tmp_path / "a",
        {"app.log.1": b"first\n", "app.log.2": "第二个\n".encode(), "notes.txt": b"skip"},
    )
    local = tmp_path / "pulled"

    result = run(tmp_path, pattern="app.log.*", local_dir=str(local))

    assert result.status == "success", result.error
    assert sorted(p.name for p in local.iterdir()) == ["app.log.1", "app.log.2"]
    assert (local / "app.log.1").read_bytes() == b"first\n"
    assert (local / "app.log.2").read_text(encoding="utf-8") == "第二个\n"
    assert result.outputs == {
        "files": [str(local / "app.log.1"), str(local / "app.log.2")],
        "count": 2,
        "total_bytes": 6 + len("第二个\n".encode()),
    }


def test_succeeds_with_no_files_when_nothing_matches(tmp_path: Path) -> None:
    source_files(tmp_path / "a", {"notes.txt": b"skip"})
    local = tmp_path / "pulled"

    result = run(tmp_path, pattern="*.log", local_dir=str(local))

    assert result.status == "success", result.error
    assert result.outputs == {"files": [], "count": 0, "total_bytes": 0}


def test_recursive_keeps_the_subdirectories_under_the_local_directory(tmp_path: Path) -> None:
    source_files(tmp_path / "a", {"a.log": b"a", "node-1/b.log": b"bb", "node-1/x/c.log": b"c"})
    local = tmp_path / "pulled"

    result = run(tmp_path, pattern="*.log", local_dir=str(local), recursive=True)

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["files"] == [
        str(local / "a.log"),
        str(local / "node-1" / "b.log"),
        str(local / "node-1" / "x" / "c.log"),
    ]
    assert (local / "node-1" / "x" / "c.log").read_bytes() == b"c"
    assert result.outputs["total_bytes"] == 4


def test_without_recursive_files_in_subdirectories_are_not_pulled(tmp_path: Path) -> None:
    source_files(tmp_path / "a", {"a.log": b"a", "node-1/b.log": b"bb"})
    local = tmp_path / "pulled"

    result = run(tmp_path, local_dir=str(local))

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["files"] == [str(local / "a.log")]


def test_a_relative_local_directory_is_relative_to_the_task_work_dir(tmp_path: Path) -> None:
    source_files(tmp_path / "a", {"a.log": b"a"})

    result = run(tmp_path, local_dir="pulled")

    assert result.status == "success", result.error
    target = tmp_path / "task" / "pulled" / "a.log"
    assert target.read_bytes() == b"a"
    assert result.outputs is not None
    assert result.outputs["files"] == [str(target)]


def test_delete_source_deletes_the_pulled_files_from_the_source_agent(tmp_path: Path) -> None:
    logs = source_files(tmp_path / "a", {"app.log.1": b"1", "app.log.2": b"2", "app.log": b"now"})
    local = tmp_path / "pulled"

    result = run(tmp_path, pattern="app.log.*", local_dir=str(local), delete_source=True)

    assert result.status == "success", result.error
    assert sorted(p.name for p in local.iterdir()) == ["app.log.1", "app.log.2"]
    assert sorted(p.name for p in logs.iterdir()) == ["app.log"]


@pytest.mark.skipif(os.geteuid() == 0, reason="root 不受文件权限限制")
def test_only_files_that_were_pulled_are_deleted_when_a_download_fails(tmp_path: Path) -> None:
    # 按名称顺序拉取：a 成功后被删除，b 没有读权限、下载失败，节点在这里失败，
    # b 和之后的 c 都留在来源上。
    logs = source_files(tmp_path / "a", {"a.log": b"a", "b.log": b"b", "c.log": b"c"})
    (logs / "b.log").chmod(0)
    local = tmp_path / "pulled"
    try:
        result = run(tmp_path, local_dir=str(local), delete_source=True)
    finally:
        (logs / "b.log").chmod(0o644)

    assert result.status == "failed"
    assert result.error is not None
    assert "b.log" in result.error.message, result.error.message
    assert sorted(p.name for p in logs.iterdir()) == ["b.log", "c.log"]
    assert sorted(p.name for p in local.iterdir()) == ["a.log"]


def test_lists_at_most_1000_local_paths_and_counts_all_of_them(tmp_path: Path) -> None:
    source_files(tmp_path / "a", {f"{i:04}.log": b"x" for i in range(1001)})
    local = tmp_path / "pulled"

    result = run(tmp_path, local_dir=str(local))

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["files"] == [str(local / f"{i:04}.log") for i in range(1000)]
    assert result.outputs["count"] == 1001
    assert result.outputs["total_bytes"] == 1001
    assert len(list(local.iterdir())) == 1001


def test_long_local_paths_are_listed_up_to_256_kib(tmp_path: Path) -> None:
    # 本地目录很深，每个本地路径三百多字节：1000 个超过 256 KiB，只列出前面放得下的。
    segment = "很长的目录名" * 8
    source_files(tmp_path / "a", {f"{i:04}.log": b"x" for i in range(1000)})
    local = tmp_path / segment / segment

    result = run(tmp_path, local_dir=str(local))

    assert result.status == "success", result.error
    assert result.outputs is not None
    listed = result.outputs["files"]
    assert 0 < len(listed) < 1000
    assert listed == [str(local / f"{i:04}.log") for i in range(len(listed))]
    assert len(json.dumps(listed, ensure_ascii=False).encode()) <= 256 * 1024
    assert result.outputs["count"] == 1000


def test_reports_progress_in_bytes_up_to_the_total(tmp_path: Path) -> None:
    source_files(tmp_path / "a", {"a.log": b"a" * 600_000, "b.log": b"b" * 10})

    result = run(tmp_path, local_dir=str(tmp_path / "pulled"))

    assert result.status == "success", result.error
    assert result.progress, "没有上报进度"
    assert all(p.total == 600_010 for p in result.progress)
    currents = [p.current for p in result.progress]
    assert currents == sorted(currents)
    assert currents[-1] == 600_010
    assert result.progress[-1].message == "第 2/2 个文件：/var/log/app/b.log"


#: 取消测试里拉取的大文件：稀疏文件，在来源上不占磁盘；取消前只写下开头的一小部分。
BIG = 2 * 1024 * 1024 * 1024


def test_cancelling_stops_without_leaving_a_partial_file(tmp_path: Path) -> None:
    # 先拉 a.log（小），再拉 b.log（2 GiB）：拉 b.log 的中途取消。a.log 已经拉完、源文件已删除；
    # b.log 没有拉完，本地目录里没有它（也没有临时文件），来源上的 b.log 还在。
    logs = source_files(tmp_path / "a", {"a.log": b"a" * 100})
    with open(logs / "b.log", "wb") as f:
        f.truncate(BIG)
    local = tmp_path / "pulled"

    result = run_node(
        pull_files,
        {"source": SOURCE, "directory": LOGS, "local_dir": str(local), "delete_source": True},
        work_dir=tmp_path / "task",
        agents={SOURCE: tmp_path / "a"},
        cancel_when=lambda partial: any(p.current > 100 for p in partial.progress),
    )

    assert result.status == "cancelled", result.error
    assert sorted(p.name for p in local.iterdir()) == ["a.log"]
    assert (local / "a.log").read_bytes() == b"a" * 100
    assert sorted(p.name for p in logs.iterdir()) == ["b.log"]


def test_fails_when_the_directory_does_not_exist_on_the_source_agent(tmp_path: Path) -> None:
    (tmp_path / "a").mkdir()

    result = run(tmp_path, local_dir=str(tmp_path / "pulled"))

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message.endswith("AgentFileNotFound: Agent a-01：/var/log/app 不存在")
