"""Agent 能力 files.read：`files.read`（流式读取）、`files.download`（下载到本地路径）。

- 本地调试（`sfly.testing.run_node`、`sfly run`）：没有 Agent，`ctx.agent()` 直接操作
  本机的文件系统，其它 Agent 由测试工具映射到本地目录；行为与 Agent 上一致
  （agent/tests/file_read.rs）。
- 在 Agent 上：用假的 Agent 本地 socket（test_agent_channel.py 的 `FakeAgent`）检查
  SDK 发出的请求、对回复的处理和取消。

节点取自 testdata/agent-files-package（`sfly_agent_files.read`）。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from test_agent_channel import INFO, PACKAGE_SRC, SDK_SRC, FakeAgent, frame, wait_for

import sfly
from sfly import Context, TaskInfo
from sfly.testing import run_node

PACKAGE = PACKAGE_SRC.parent
SFLY = str(Path(sys.executable).parent / "sfly")


@pytest.fixture(autouse=True)
def package_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.syspath_prepend(str(PACKAGE_SRC))


@pytest.fixture
def short_dir() -> Iterator[Path]:
    """socket 路径不能太长（AF_UNIX 108 字节），放在 TMPDIR 下的短目录里。"""
    import tempfile

    with tempfile.TemporaryDirectory(prefix="sfly-") as tmp:
        yield Path(tmp)


def content(size: int) -> bytes:
    """`size` 个任意字节（含换行和 0）。"""
    return (hashlib.sha256(b"seed").digest() * (size // 32 + 1))[:size]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def info_of(path: Path, shown: str) -> dict[str, Any]:
    stat = path.stat()
    return {
        "path": shown,
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "device": stat.st_dev,
        "inode": stat.st_ino,
    }


def make_source(root: Path, size: int = 600_000) -> tuple[Path, bytes]:
    """一台「Agent」上的 /var/log/app/app.log.1（几块的量）。"""
    body = content(size)
    logs = root / "var" / "log" / "app"
    logs.mkdir(parents=True)
    (logs / "app.log.1").write_bytes(body)
    return logs / "app.log.1", body


# ---- 本地调试 ----


def test_a_mapped_agent_is_read_from_an_offset_up_to_a_length(tmp_path: Path) -> None:
    from sfly_agent_files.read import read_file

    source = tmp_path / "source"
    _, body = make_source(source)
    agents = {"fs-source": source}

    def read(**inputs: Any) -> Any:
        result = run_node(
            read_file,
            {"source": "fs-source", "path": "/var/log/app/app.log.1", **inputs},
            agents=agents,
            work_dir=tmp_path / "work",
        )
        assert result.status == "success", result.error
        return result.outputs

    whole = read()
    assert (whole["size"], whole["sha256"]) == (len(body), sha(body))
    part = body[1000:301_000]
    assert read(offset=1000, length=300_000)["sha256"] == sha(part)
    assert read(offset=len(body) - 7)["size"] == 7
    assert read(offset=len(body) - 3, length=100)["size"] == 3
    assert read(offset=len(body) + 5)["size"] == 0
    assert read(length=0)["size"] == 0


def test_downloading_from_a_mapped_agent_writes_the_local_path(tmp_path: Path) -> None:
    from sfly_agent_files.read import download_file

    source = tmp_path / "source"
    path, body = make_source(source)
    work = tmp_path / "work"

    # 相对路径相对于节点的工作目录；目录不存在时一并创建。
    result = run_node(
        download_file,
        {"source": "fs-source", "path": "/var/log/app/app.log.1", "local_path": "pulled/a.log"},
        agents={"fs-source": source},
        work_dir=work,
    )

    assert result.status == "success", result.error
    assert result.outputs == {
        "file": info_of(path, "/var/log/app/app.log.1"),
        "size": len(body),
        "sha256": sha(body),
    }
    assert (work / "pulled" / "a.log").read_bytes() == body
    assert os.listdir(work / "pulled") == ["a.log"]


def test_the_own_agent_reads_and_downloads_local_files(tmp_path: Path) -> None:
    from sfly_agent_files.read import download_file, read_file

    path, body = make_source(tmp_path / "here")
    target = tmp_path / "copy" / "app.log.1"

    read = run_node(read_file, {"path": str(path), "offset": 10}, work_dir=tmp_path / "w1")
    copied = run_node(
        download_file, {"path": str(path), "local_path": str(target)}, work_dir=tmp_path / "w2"
    )

    assert read.outputs is not None and read.outputs["sha256"] == sha(body[10:])
    assert copied.status == "success", copied.error
    assert copied.outputs is not None and copied.outputs["file"] == info_of(path, str(path))
    assert target.read_bytes() == body


def test_reading_errors_match_the_agent(tmp_path: Path) -> None:
    from sfly_agent_files.read import download_file, read_file

    source = tmp_path / "source"
    make_source(source)

    missing = run_node(
        read_file,
        {"source": "fs-source", "path": "/var/log/app/gone.log"},
        agents={"fs-source": source},
        work_dir=tmp_path / "w1",
    )
    assert missing.status == "failed"
    assert missing.error is not None
    assert "Agent fs-source：/var/log/app/gone.log 不存在" in missing.error.message

    directory = run_node(
        download_file,
        {"source": "fs-source", "path": "/var/log/app", "local_path": "x"},
        agents={"fs-source": source},
        work_dir=tmp_path / "w2",
    )
    assert directory.error is not None
    assert "Agent fs-source：/var/log/app 是目录，不能读取" in directory.error.message
    assert not (tmp_path / "w2" / "x").exists()

    relative = run_node(read_file, {"path": "var/log"}, work_dir=tmp_path / "w3")
    assert relative.error is not None
    assert "路径必须是那台 Agent 所在机器上的绝对路径" in relative.error.message


def local_context(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: Path) -> Context:
    """本地调试时的上下文：fs-source 映射到 `source`（`sfly.local` 写的映射表）。"""
    table = tmp_path / "agents.json"
    table.write_text(json.dumps({"fs-source": str(source)}), encoding="utf-8")
    monkeypatch.delenv("SFLY_AGENT_SOCKET", raising=False)
    monkeypatch.setenv("SFLY_LOCAL_AGENTS", str(table))
    return Context(
        events_path=None,
        cancel_path=None,
        artifacts_dir=None,
        artifacts_url=None,
        task=TaskInfo(task_id="local", attempt=1),
    )


def grow(path: Path) -> None:
    with path.open("ab") as f:
        f.write(b"one more line\n")


@pytest.mark.parametrize(
    ("change", "error", "message"),
    [
        (Path.unlink, sfly.AgentFileNotFound, "在下载期间被删除"),
        (lambda p: os.truncate(p, 10), sfly.AgentError, "在下载期间被截短"),
        (grow, sfly.AgentError, "在下载期间变化了"),
    ],
)
def test_a_source_that_changes_during_the_download_fails_it_without_leaving_a_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    change: Callable[[Path], Any],
    error: type[Exception],
    message: str,
) -> None:
    source = tmp_path / "source"
    path, _ = make_source(source)
    target = tmp_path / "local" / "app.log.1"
    ctx = local_context(tmp_path, monkeypatch, source)
    changed: list[int] = []

    def progress(done: int, total: int) -> None:
        # 下载到一半时源文件变了。
        if not changed:
            changed.append(done)
            change(path)

    with pytest.raises(error, match=message):
        ctx.agent("fs-source").files.download("/var/log/app/app.log.1", target, progress=progress)

    assert changed
    assert os.listdir(target.parent) == []


def test_a_source_rotated_during_the_download_is_still_downloaded_and_reports_its_new_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 日志轮转：下载到一半时 app.log.1 被改名为 app.log.2，路径上换成了一个新文件。
    # 内容从打开的文件读，下载照常完成，返回的是它现在的路径。
    source = tmp_path / "source"
    path, body = make_source(source)
    rotated = path.with_name("app.log.2")
    target = tmp_path / "local" / "app.log.1"
    ctx = local_context(tmp_path, monkeypatch, source)
    rotations: list[int] = []

    def progress(done: int, total: int) -> None:
        if not rotations:
            rotations.append(done)
            path.rename(rotated)
            path.write_bytes(b"a new file")

    info = ctx.agent("fs-source").files.download(
        "/var/log/app/app.log.1", target, progress=progress
    )

    assert rotations and rotations[0] < len(body)
    assert info == sfly.FileInfo.from_json(info_of(rotated, "/var/log/app/app.log.2"))
    assert target.read_bytes() == body
    assert os.listdir(target.parent) == ["app.log.1"]


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="用 /proc/self/fd 数文件描述符")
def test_a_cancel_right_after_the_file_is_opened_closes_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, sigterm_after: Callable[[Any, str], None]
) -> None:
    # 取消（SIGTERM）恰好落在文件打开之后：文件描述符照样被关闭。
    from sfly.capabilities import Agent, local

    monkeypatch.delenv("SFLY_AGENT_SOCKET", raising=False)
    (tmp_path / "app.log").write_bytes(b"data\n")
    files = Agent(None, local_mapping={}).files
    fds = set(os.listdir("/proc/self/fd"))
    sigterm_after(local, "open")

    with pytest.raises(sfly.Cancelled):
        next(files.read(str(tmp_path / "app.log")))
    with pytest.raises(sfly.Cancelled):
        files.download(str(tmp_path / "app.log"), tmp_path / "copy.log")

    assert os.listdir(tmp_path) == ["app.log"]
    assert set(os.listdir("/proc/self/fd")) == fds


def test_sfly_run_downloads_from_a_mapped_agent(tmp_path: Path) -> None:
    project = tmp_path / "project"
    shutil.copytree(PACKAGE, project, ignore=shutil.ignore_patterns("__pycache__", "dist"))
    source = tmp_path / "source"
    _, body = make_source(source)
    target = tmp_path / "pulled.log"

    run = subprocess.run(
        [
            SFLY,
            "run",
            "download_file",
            "--params",
            json.dumps(
                {"source": "fs-source", "path": "/var/log/app/app.log.1", "local_path": str(target)}
            ),
            "--agent",
            f"fs-source={source}",
        ],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert run.returncode == 0, run.stderr
    assert f'"sha256": "{sha(body)}"' in run.stdout
    assert target.read_bytes() == body


# ---- 在 Agent 上（假的 Agent 本地 socket）----


def agent_context(short_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Context:
    monkeypatch.setenv("SFLY_AGENT_SOCKET", str(short_dir / "agent.sock"))
    monkeypatch.delenv("SFLY_LOCAL_AGENTS", raising=False)
    return Context(
        events_path=None,
        cancel_path=short_dir / "cancel",
        artifacts_dir=None,
        artifacts_url=None,
        task=TaskInfo(task_id="t-1", attempt=2),
    )


def test_reading_yields_the_raw_bytes_of_each_data_frame(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    chunks = [b"line 1\n\x00", b"\xff line 2", b"\n"]
    agent = FakeAgent(
        short_dir / "agent.sock",
        lambda _: [frame({"data": len(c)}) + c for c in chunks] + [frame({"result": None})],
    )
    ctx = agent_context(short_dir, monkeypatch)

    read = list(ctx.agent("fs-source").files.read("/var/log/app.log", 5, 100, timeout=2.5))
    whole = list(ctx.agent().files.read("/var/log/app.log"))

    assert read == chunks
    assert whole == chunks
    assert [(r["agent"], r["method"], r["args"], r["timeout_ms"]) for r in agent.requests] == [
        ("fs-source", "files.read", {"path": "/var/log/app.log", "offset": 5, "length": 100}, 2500),
        ("", "files.read", {"path": "/var/log/app.log", "offset": 0, "length": None}, 30000),
    ]
    agent.close()


def test_downloading_hands_the_absolute_local_path_to_the_agent_and_reports_progress(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = FakeAgent(
        short_dir / "agent.sock",
        lambda _: [
            frame({"item": {"downloaded": 4, "size": 12}}),
            frame({"item": {"downloaded": 12, "size": 12}}),
            frame({"result": INFO}),
        ],
    )
    ctx = agent_context(short_dir, monkeypatch)
    monkeypatch.chdir(short_dir)
    seen: list[tuple[int, int]] = []

    info = ctx.agent("fs-source").files.download(
        "/var/log/app.log", "pulled/app.log", progress=lambda done, size: seen.append((done, size))
    )
    # 不要进度时也一样。
    again = ctx.agent("fs-source").files.download("/var/log/app.log", short_dir / "b.log")

    assert info == again == sfly.FileInfo.from_json(INFO)
    assert seen == [(4, 12), (12, 12)]
    assert [r["args"] for r in agent.requests] == [
        {"path": "/var/log/app.log", "local_path": str(short_dir / "pulled" / "app.log")},
        {"path": "/var/log/app.log", "local_path": str(short_dir / "b.log")},
    ]
    assert agent.requests[0]["method"] == "files.download"
    agent.close()


def test_a_failed_download_raises_the_agents_error(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    message = "Agent fs-source：/var/log/app.log 在下载期间被删除，下载作废"
    agent = FakeAgent(
        short_dir / "agent.sock",
        lambda _: [
            frame({"item": {"downloaded": 4, "size": 12}}),
            frame({"error": {"kind": "not_found", "message": message, "agent": "fs-source"}}),
        ],
    )
    ctx = agent_context(short_dir, monkeypatch)

    with pytest.raises(sfly.AgentFileNotFound) as raised:
        ctx.agent("fs-source").files.download("/var/log/app.log", short_dir / "x")

    assert str(raised.value) == message
    assert raised.value.agent == "fs-source"
    agent.close()


def test_a_source_moved_away_while_resuming_raises_agent_file_moved(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 续传时原来的文件已经不在路径上（Agent 回复 moved）：节点据此用新路径重新下载。
    message = (
        "Agent fs-source：/var/log/app.log 在下载期间被移走（路径上换成了另一个文件），下载作废"
    )
    agent = FakeAgent(
        short_dir / "agent.sock",
        lambda _: [
            frame({"item": {"downloaded": 4, "size": 12}}),
            frame({"error": {"kind": "moved", "message": message, "agent": "fs-source"}}),
        ],
    )
    ctx = agent_context(short_dir, monkeypatch)

    with pytest.raises(sfly.AgentFileMoved) as raised:
        ctx.agent("fs-source").files.download("/var/log/app.log", short_dir / "x")

    assert isinstance(raised.value, sfly.AgentError)
    assert raised.value.kind == "moved"
    assert str(raised.value) == message
    agent.close()


def test_arguments_are_checked_before_calling(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx = agent_context(short_dir, monkeypatch)
    files = ctx.agent().files

    with pytest.raises(ValueError, match="offset 必须是不小于 0 的整数"):
        files.read("/x", -1)
    with pytest.raises(ValueError, match="length 必须是不小于 0 的整数"):
        files.read("/x", 0, -5)
    with pytest.raises(ValueError, match="绝对路径"):
        files.read("x")
    with pytest.raises(ValueError, match="绝对路径"):
        files.download("x", "/y")
    with pytest.raises(ValueError, match="timeout 必须大于 0"):
        files.download("/x", "/y", timeout=0)


def test_cancelling_the_task_interrupts_a_download_that_is_waiting(short_dir: Path) -> None:
    """主线程卡在下载里时，SIGTERM（Agent 取消任务）立即让下载抛出 Cancelled。"""
    agent = FakeAgent(short_dir / "agent.sock", lambda _: [], hang=True)
    work = short_dir / "work"
    work.mkdir()
    (work / "task.json").write_text(
        json.dumps(
            {
                "task_id": "t-1",
                "attempt": 1,
                "entry": "sfly_agent_files.read:wait_download",
                "inputs": {"path": "/x", "local_path": "x", "source": "fs-source"},
                "agents": [{"name": "fs-source", "address": "10.0.0.5", "port": 50052}],
            }
        ),
        encoding="utf-8",
    )
    env = {k: v for k, v in os.environ.items() if not k.startswith("SFLY_")}
    env.update(
        PYTHONPATH=os.pathsep.join([str(SDK_SRC), str(PACKAGE_SRC)]),
        SFLY_TASK=str(work / "task.json"),
        SFLY_OUTPUT=str(work / "output.json"),
        SFLY_EVENTS=str(work / "events.jsonl"),
        SFLY_CANCEL=str(work / "cancel"),
        SFLY_AGENT_SOCKET=str(agent.path),
    )
    proc = subprocess.Popen([sys.executable, "-m", "sfly.runner"], cwd=work, env=env)
    try:
        wait_for(lambda: len(agent.requests) == 1)
        assert agent.requests[0]["method"] == "files.download"
        assert agent.requests[0]["timeout_ms"] == 0
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=10) == 1
    finally:
        proc.kill()
        agent.close()
    # 调用随节点进程退出放弃：Agent 看到连接断开。
    assert agent.closed.wait(10)
