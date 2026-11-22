"""`sfly_std.agent_files`：直接调用拉文件的辅助函数。

来源 Agent `a-01` 用 `SFLY_LOCAL_AGENTS` 映射到临时目录（本地调试时的做法，见
`sfly.capabilities.local`）：它上面的 `/var/log/app` 落在 `<临时目录>/var/log/app`。
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

import pytest
from direct_context import DirectRun

from sfly_std.agent_files import (
    WATCH_METRICS,
    PullResult,
    WatchResult,
    pull_files_from_agent,
    watch_agent_files,
)

SOURCE = "a-01"
LOGS = "/var/log/app"


@pytest.fixture
def source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """来源 Agent 的根目录；`LOGS` 已经存在。"""
    root = tmp_path / "a"
    (root / LOGS.lstrip("/")).mkdir(parents=True)
    table = tmp_path / "local-agents.json"
    table.write_text(json.dumps({SOURCE: str(root)}))
    monkeypatch.setenv("SFLY_LOCAL_AGENTS", str(table))
    return root / LOGS.lstrip("/")


def test_pull_files_from_agent_returns_the_local_paths_and_the_sizes(
    tmp_path: Path, source: Path
) -> None:
    (source / "app.log.1").write_bytes(b"first\n")
    (source / "app.log.2").write_bytes(b"second\n")
    (source / "notes.txt").write_bytes(b"skip")
    run = DirectRun(tmp_path / "run")
    local = tmp_path / "pulled"

    result = pull_files_from_agent(run.ctx, SOURCE, LOGS, str(local), pattern="app.log.*")

    assert result == PullResult(
        files=[str(local / "app.log.1"), str(local / "app.log.2")], count=2, total_bytes=13
    )
    assert (local / "app.log.2").read_bytes() == b"second\n"


def test_pull_files_from_agent_can_delete_what_it_pulled_from_the_source(
    tmp_path: Path, source: Path
) -> None:
    (source / "app.log.1").write_bytes(b"x")
    run = DirectRun(tmp_path / "run")

    result = pull_files_from_agent(
        run.ctx, SOURCE, LOGS, str(tmp_path / "pulled"), delete_source=True
    )

    assert result.count == 1
    assert not (source / "app.log.1").exists()


def test_pull_files_from_agent_needs_a_local_directory_and_an_existing_source_directory(
    tmp_path: Path, source: Path
) -> None:
    run = DirectRun(tmp_path / "run")

    with pytest.raises(ValueError, match="local_dir 不能为空"):
        pull_files_from_agent(run.ctx, SOURCE, LOGS, "")
    with pytest.raises(Exception, match="/nope"):
        pull_files_from_agent(run.ctx, SOURCE, "/nope", str(tmp_path / "pulled"))


@pytest.mark.skipif(
    not sys.platform.startswith("linux"),
    reason="本地调试时的 files.watch 用 inotify，只有 Linux 有",
)
def test_watch_agent_files_pulls_files_that_appear_once_each_until_duration(
    tmp_path: Path, source: Path
) -> None:
    (source / "app.log.1").write_bytes(b"one\n")
    run = DirectRun(tmp_path / "run", metrics=WATCH_METRICS)
    local = tmp_path / "pulled"

    def later() -> None:
        time.sleep(0.6)
        (source / "app.log.2").write_bytes(b"two\n")

    writer = threading.Thread(target=later)
    writer.start()
    try:
        result = watch_agent_files(
            run.ctx, SOURCE, LOGS, str(local), pattern="app.log.*", duration=2.5
        )
    finally:
        writer.join()

    assert result == WatchResult(count=2, total_bytes=8)
    assert sorted(p.name for p in local.iterdir()) == ["app.log.1", "app.log.2"]
    assert run.metric("bytes_per_s")


def test_watch_agent_files_rejects_a_bad_stable_or_duration_before_connecting(
    tmp_path: Path, source: Path
) -> None:
    run = DirectRun(tmp_path / "run")

    with pytest.raises(ValueError):
        watch_agent_files(run.ctx, SOURCE, LOGS, str(tmp_path / "p"), stable=-1)
    with pytest.raises(ValueError):
        watch_agent_files(run.ctx, SOURCE, LOGS, str(tmp_path / "p"), duration=0)
    with pytest.raises(ValueError, match="local_dir 不能为空"):
        watch_agent_files(run.ctx, SOURCE, LOGS, "")
