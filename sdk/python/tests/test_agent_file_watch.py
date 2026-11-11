"""Agent 能力 files.watch 的本地调试（`sfly.testing.run_node`）：没有 Agent，`ctx.agent()` 直接监听
本机的目录，其它 Agent 由测试工具映射到本地目录。行为与 Agent 上一致（agent/tests/file_watch.rs）。

节点取自 testdata/agent-files-package（`sfly_agent_files.watch`）。节点一直监听到新建了名为 `stop`
的文件；收到第一份快照后新建 `ready` 文件，测试等到它出现再改动目录。
"""

from __future__ import annotations

import os
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

import sfly
from sfly.testing import Execution, run_node

PACKAGE = Path(__file__).resolve().parents[3] / "testdata" / "agent-files-package"


@pytest.fixture(autouse=True)
def package_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.syspath_prepend(str(PACKAGE / "src"))


def wait_for(check: Callable[[], bool], timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)


class Running:
    """在后台线程里运行 `watch_until`，`ready` 出现后测试再改动目录。"""

    def __init__(self, tmp_path: Path, inputs: dict[str, Any], **kwargs: Any) -> None:
        from sfly_agent_files.watch import watch_until

        self.ready = tmp_path / "ready"
        self.result: Execution | None = None

        def run() -> None:
            self.result = run_node(
                watch_until,
                {**inputs, "ready": str(self.ready)},
                work_dir=tmp_path / "work",
                **kwargs,
            )

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()

    def wait_ready(self) -> None:
        wait_for(lambda: self.ready.exists() or self.result is not None)

    def finish(self) -> Execution:
        self._thread.join(timeout=30)
        assert self.result is not None, "the node did not finish"
        return self.result


def test_a_mapped_agent_gives_a_snapshot_then_reports_a_log_rotation(tmp_path: Path) -> None:
    source = tmp_path / "source"
    logs = source / "var" / "log" / "app"
    logs.mkdir(parents=True)
    (logs / "app.log").write_text("current\n", encoding="utf-8")
    (logs / "app.log.1").write_text("rotated once\n", encoding="utf-8")
    (logs / "notes.txt").write_text("not a log\n", encoding="utf-8")
    current = (logs / "app.log").stat().st_ino

    running = Running(
        tmp_path,
        {
            "source": "fs-source",
            "directory": "/var/log/app",
            "pattern": "app.log*",
            "stop": "app.log.stop",
        },
        agents={"fs-source": source},
    )
    running.wait_ready()
    (logs / "app.log.1").rename(logs / "app.log.2")
    (logs / "app.log").rename(logs / "app.log.1")
    (logs / "app.log").write_text("fresh\n", encoding="utf-8")
    (logs / "notes.txt").write_text("still not a log\n", encoding="utf-8")
    (logs / "app.log.stop").write_text("", encoding="utf-8")
    result = running.finish()

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["snapshots"] == [
        {"files": ["/var/log/app/app.log", "/var/log/app/app.log.1"], "missed": False}
    ]
    events = [(e["kind"], e["path"], e["old_path"]) for e in result.outputs["events"]]
    assert events[:2] == [
        ("moved", "/var/log/app/app.log.2", "/var/log/app/app.log.1"),
        ("moved", "/var/log/app/app.log.1", "/var/log/app/app.log"),
    ]
    assert result.outputs["events"][1]["inode"] == current
    fresh = [e for e in events if e[1] == "/var/log/app/app.log"]
    assert [kind for kind, _, _ in fresh][0] == "created"
    assert ("closed", "/var/log/app/app.log", None) in fresh
    assert events[-1] == ("created", "/var/log/app/app.log.stop", None)


def test_the_own_agent_watches_the_local_directory_recursively(tmp_path: Path) -> None:
    logs = tmp_path / "logs"
    (logs / "old").mkdir(parents=True)
    (logs / "old" / "a.log").write_text("x", encoding="utf-8")

    running = Running(tmp_path, {"directory": str(logs), "recursive": True, "stop": "stop"})
    running.wait_ready()
    (logs / "2026" / "11").mkdir(parents=True)
    (logs / "2026" / "11" / "b.log").write_text("y", encoding="utf-8")
    (logs / "old" / "a.log").unlink()
    (logs / "stop").write_text("", encoding="utf-8")
    result = running.finish()

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["snapshots"] == [
        {"files": [str(logs / "old" / "a.log")], "missed": False}
    ]
    events = [(e["kind"], e["path"]) for e in result.outputs["events"]]
    assert ("created", str(logs / "2026" / "11" / "b.log")) in events
    assert ("deleted", str(logs / "old" / "a.log")) in events


def test_watching_a_missing_directory_fails_clearly(tmp_path: Path) -> None:
    from sfly_agent_files.watch import watch_until

    source = tmp_path / "source"
    source.mkdir()
    result = run_node(
        watch_until,
        {"source": "fs-source", "directory": "/var/log/none", "stop": "x"},
        agents={"fs-source": source},
        work_dir=tmp_path / "work",
    )

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.type == "AgentFileNotFound"
    assert "Agent fs-source：/var/log/none 不存在" in result.error.message


def test_cancelling_the_task_ends_the_watch_at_once(tmp_path: Path) -> None:
    logs = tmp_path / "logs"
    logs.mkdir()
    ready = tmp_path / "ready"

    from sfly_agent_files.watch import watch_until

    result = run_node(
        watch_until,
        {"directory": str(logs), "stop": "never", "ready": str(ready)},
        cancel_when=lambda _partial: ready.exists(),
        work_dir=tmp_path / "work",
    )

    assert result.status == "cancelled", result.error
    # 节点在宽限期内自己停下（被强制杀掉的话没有这行日志）。
    assert "监听被取消" in [line.message for line in result.logs]


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="inotify")
def test_a_cancel_right_after_the_inotify_instance_is_created_closes_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, sigterm_after: Callable[[Any, str], None]
) -> None:
    # 取消（SIGTERM）恰好落在 inotify 实例建出来之后：它的文件描述符照样被关闭。
    from sfly.capabilities import Agent, files_watch_local

    monkeypatch.delenv("SFLY_AGENT_SOCKET", raising=False)
    files = Agent(None, local_mapping={}).files
    fds = set(os.listdir("/proc/self/fd"))
    sigterm_after(files_watch_local, "_Inotify")

    with pytest.raises(sfly.Cancelled):
        next(files.watch(str(tmp_path)))

    assert set(os.listdir("/proc/self/fd")) == fds
