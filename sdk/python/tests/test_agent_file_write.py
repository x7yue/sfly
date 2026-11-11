"""Agent 能力 files.write 的本地调试（`sfly.testing.run_node`、`sfly run`）和 SDK 发出的数据帧。

本地调试没有 Agent：`ctx.agent()` 直接写本机的文件系统，其它 Agent 由测试工具映射到
本地目录，行为与 Agent 上一致（agent/tests/file_write.rs）。经本地 socket 发出的请求和数据帧
用本文件里的 `RecordingAgent` 检查。

节点取自 testdata/agent-files-package/src/sfly_agent_files/write.py。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

import sfly
from sfly import Context, TaskInfo
from sfly.testing import run_node

PACKAGE = Path(__file__).resolve().parents[3] / "testdata" / "agent-files-package"
SFLY = str(Path(sys.executable).parent / "sfly")


@pytest.fixture(autouse=True)
def package_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.syspath_prepend(str(PACKAGE / "src"))


def info(path: Path, shown: str) -> dict[str, Any]:
    stat = path.stat()
    return {
        "path": shown,
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "device": stat.st_dev,
        "inode": stat.st_ino,
    }


def run(tmp_path: Path, node_name: str, inputs: dict[str, Any], **kwargs: Any) -> Any:
    from sfly_agent_files import write

    return run_node(getattr(write, node_name), inputs, work_dir=tmp_path / "work", **kwargs)


def test_a_mapped_agent_gets_written_uploaded_and_deleted_files(tmp_path: Path) -> None:
    source = tmp_path / "source"
    (source / "var" / "out").mkdir(parents=True)
    agents = {"fs-source": source}

    written = run(
        tmp_path,
        "write_file",
        {"source": "fs-source", "path": "/var/out/result.txt", "text": "一二三四五\n", "pieces": 4},
        agents=agents,
    )
    assert written.status == "success", written.error
    target = source / "var" / "out" / "result.txt"
    assert target.read_text(encoding="utf-8") == "一二三四五\n"
    assert written.outputs == {"file": info(target, "/var/out/result.txt"), "error": None}

    # 上传：节点所在机器上的文件（相对于任务目录的路径）。
    uploaded = run(
        tmp_path,
        "upload_file",
        {"source": "fs-source", "path": "/var/out/uploaded.txt", "text": "uploaded\n"},
        agents=agents,
    )
    assert uploaded.status == "success", uploaded.error
    copy = source / "var" / "out" / "uploaded.txt"
    assert copy.read_text(encoding="utf-8") == "uploaded\n"
    assert uploaded.outputs == {"file": info(copy, "/var/out/uploaded.txt"), "error": None}

    delete = {"source": "fs-source", "path": "/var/out/result.txt"}
    deleted = run(tmp_path, "delete_file", delete, agents=agents)
    assert deleted.outputs == {"error": None}
    assert sorted(os.listdir(source / "var" / "out")) == ["uploaded.txt"]

    again = run(tmp_path, "delete_file", delete, agents=agents)
    assert again.outputs == {
        "error": {
            "type": "AgentFileNotFound",
            "kind": "not_found",
            "agent": "fs-source",
            "message": "Agent fs-source：/var/out/result.txt 不存在",
        }
    }


def test_the_own_agent_writes_the_local_file_system_and_keeps_permissions(tmp_path: Path) -> None:
    target = tmp_path / "marker"
    target.write_text("an old and longer content\n", encoding="utf-8")
    target.chmod(0o640)

    written = run(tmp_path, "write_file", {"path": str(target), "text": "new\n"})

    assert written.status == "success", written.error
    assert target.read_text(encoding="utf-8") == "new\n"
    assert target.stat().st_mode & 0o777 == 0o640
    assert written.outputs == {"file": info(target, str(target)), "error": None}


def test_a_write_that_fails_halfway_leaves_nothing_at_the_target(tmp_path: Path) -> None:
    out = tmp_path / "out"
    out.mkdir()
    (out / "existing.log").write_text("keep me\n", encoding="utf-8")

    failed = run(tmp_path, "write_then_fail", {"path": str(out / "existing.log")})
    assert failed.status == "failed"
    assert failed.error is not None
    assert "生成内容失败" in failed.error.message
    assert sorted(os.listdir(out)) == ["existing.log"]
    assert (out / "existing.log").read_text(encoding="utf-8") == "keep me\n"


def test_errors_tell_apart_missing_directories_directories_and_permissions(tmp_path: Path) -> None:
    source = tmp_path / "source"
    (source / "data" / "sub").mkdir(parents=True)
    agents = {"fs-source": source}

    def error(node_name: str, inputs: dict[str, Any]) -> Any:
        result = run(tmp_path, node_name, {"source": "fs-source", **inputs}, agents=agents)
        assert result.status == "success", result.error
        return result.outputs["error"]

    assert error("write_file", {"path": "/data/no-such-dir/x", "text": "x"}) == {
        "type": "AgentFileNotFound",
        "kind": "not_found",
        "agent": "fs-source",
        "message": "Agent fs-source：目录 /data/no-such-dir 不存在",
    }
    assert error("write_file", {"path": "/data/sub", "text": "x"})["kind"] == "invalid"
    assert error("delete_file", {"path": "/data/sub"})["message"] == (
        "Agent fs-source：/data/sub 是目录：只能删除文件"
    )
    assert (source / "data" / "sub").is_dir()

    if os.geteuid() != 0:
        locked = source / "data" / "locked"
        locked.mkdir()
        (locked / "app.log").write_text("keep\n", encoding="utf-8")
        locked.chmod(0o555)
        try:
            write = error("write_file", {"path": "/data/locked/new.txt", "text": "x"})
            delete = error("delete_file", {"path": "/data/locked/app.log"})
        finally:
            locked.chmod(0o755)
        assert write["type"] == "AgentPermissionDenied"
        assert write["message"] == "Agent fs-source：没有权限写入 /data/locked/new.txt"
        assert delete["type"] == "AgentPermissionDenied"
        assert delete["message"] == "Agent fs-source：没有权限删除 /data/locked/app.log"
        assert sorted(os.listdir(locked)) == ["app.log"]


def test_sfly_run_writes_to_an_agent_mapped_to_a_local_directory(tmp_path: Path) -> None:
    project = tmp_path / "project"
    shutil.copytree(PACKAGE, project, ignore=shutil.ignore_patterns("__pycache__", "dist"))
    source = tmp_path / "source"
    (source / "srv").mkdir(parents=True)

    done = subprocess.run(
        [
            SFLY,
            "run",
            "write_file",
            "--params",
            '{"source": "fs-source", "path": "/srv/done.flag", "text": "ok"}',
            "--agent",
            f"fs-source={source}",
        ],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert done.returncode == 0, done.stderr
    assert (source / "srv" / "done.flag").read_text(encoding="utf-8") == "ok"
    assert '"path": "/srv/done.flag"' in done.stdout


# ---- 经本地 socket 发出的请求和数据帧 ----


@pytest.fixture
def short_dir() -> Any:
    """socket 路径不能太长（AF_UNIX 108 字节），放在 TMPDIR 下的短目录里。"""
    import tempfile

    with tempfile.TemporaryDirectory(prefix="sfly-") as tmp:
        yield Path(tmp)


INFO = {"path": "/srv/x", "size": 3, "mtime_ns": 1, "device": 2, "inode": 3}


class RecordingAgent:
    """假的 Agent 本地 socket：读请求和之后的数据帧，直到 `end`（或读满 `stop_after` 帧
    就提前回复），然后回复一帧并关闭连接。"""

    def __init__(self, path: Path, reply: dict[str, Any], stop_after: int | None = None) -> None:
        import socket

        self.requests: list[dict[str, Any]] = []
        self.frames: list[Any] = []
        self._reply = reply
        self._stop_after = stop_after
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(str(path))
        self._server.listen()
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        conn, _ = self._server.accept()
        with conn, conn.makefile("rb") as reader:
            self.requests.append(json.loads(reader.readline()))
            while self._stop_after is None or len(self.frames) < self._stop_after:
                frame = json.loads(reader.readline())
                if frame.get("end"):
                    self.frames.append("end")
                    break
                self.frames.append(reader.read(frame["data"]))
            conn.sendall(json.dumps(self._reply).encode("utf-8") + b"\n")

    def close(self) -> None:
        self._server.close()


def context(short_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Context:
    monkeypatch.setenv("SFLY_AGENT_SOCKET", str(short_dir / "agent.sock"))
    monkeypatch.delenv("SFLY_LOCAL_AGENTS", raising=False)
    return Context(
        events_path=None,
        cancel_path=short_dir / "cancel",
        artifacts_dir=None,
        artifacts_url=None,
        task=TaskInfo(task_id="t-1", attempt=1),
    )


def test_writes_send_the_content_as_data_frames_then_end(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = RecordingAgent(short_dir / "agent.sock", {"result": INFO})
    ctx = context(short_dir, monkeypatch)
    big = bytes(range(256)) * 2048  # 512 KiB：分成两帧

    parts: list[bytes | bytearray | memoryview] = [b"ab", bytearray(), memoryview(b"c\n"), big]
    written = ctx.agent("fs-source").files.write("/srv/x", iter(parts), timeout=4)

    assert written == sfly.FileInfo("/srv/x", 3, 1, sfly.FileId(2, 3))
    assert agent.requests == [
        {
            "command": "call",
            "task_id": "t-1",
            "attempt": 1,
            "agent": "fs-source",
            "method": "files.write",
            "args": {"path": "/srv/x"},
            "timeout_ms": 4000,
        }
    ]
    assert agent.frames == [b"ab", b"c\n", big[: 256 * 1024], big[256 * 1024 :], "end"]
    agent.close()


def test_an_agent_that_stops_accepting_mid_write_reports_why(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Agent 中途结束调用（例如目标目录没有写权限）：SDK 不再发，抛出 Agent 回复的错误。"""
    agent = RecordingAgent(
        short_dir / "agent.sock",
        {"error": {"kind": "permission_denied", "message": "没有权限写入 /srv/x", "agent": "a"}},
        stop_after=1,
    )
    ctx = context(short_dir, monkeypatch)
    endless = (b"x" * 65536 for _ in range(100_000))

    with pytest.raises(sfly.AgentPermissionDenied, match="没有权限写入"):
        ctx.agent().files.write("/srv/x", endless)
    agent.close()


def test_uploads_and_deletes_send_absolute_paths(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx = context(short_dir, monkeypatch)
    monkeypatch.chdir(short_dir)

    agent = RecordingAgent(short_dir / "agent.sock", {"result": INFO}, stop_after=0)
    assert ctx.agent().files.upload("out/data.bin", "/srv/x").path == "/srv/x"
    assert agent.requests[0]["method"] == "files.upload"
    assert agent.requests[0]["args"] == {
        "local_path": str(short_dir / "out" / "data.bin"),
        "path": "/srv/x",
    }
    agent.close()
    os.unlink(short_dir / "agent.sock")

    agent = RecordingAgent(short_dir / "agent.sock", {"result": None}, stop_after=0)
    ctx.agent("a").files.delete("/srv/x")
    assert agent.requests[0]["method"] == "files.delete"
    assert agent.requests[0]["args"] == {"path": "/srv/x"}
    agent.close()


def test_arguments_are_checked_before_calling(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx = context(short_dir, monkeypatch)
    files = ctx.agent().files

    with pytest.raises(TypeError, match="文本先 encode"):
        files.write("/x", "text")  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="收到 int"):
        files.write("/x", 3)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="绝对路径"):
        files.write("x", b"")
    with pytest.raises(ValueError, match="绝对路径"):
        files.upload("/local", "x")
    with pytest.raises(ValueError, match="绝对路径"):
        files.delete("x")
    with pytest.raises(ValueError, match="timeout 必须大于 0"):
        files.delete("/x", timeout=0)
