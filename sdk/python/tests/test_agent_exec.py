"""Agent 能力 exec 的本地调试（`sfly.testing.run_node`、`sfly debug`）和 SDK 经本地 socket
发出的调用。

本地调试没有 Agent：`ctx.agent()` 在本机执行命令，其它 Agent 由测试工具映射到本地目录
（工作目录落在映射的目录里），规则与 Agent 上一致（agent/tests/exec.rs）：输出逐行进入
任务日志并标明来自哪台 Agent，超时、取消时命令连同它的子进程一起结束。经本地 socket 的
调用用本文件里的 `ReplyingAgent` 检查。

节点取自 testdata/agent-files-package/src/sfly_agent_files/commands.py。
"""

from __future__ import annotations

import json
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

import sfly
from sfly import Context, TaskInfo
from sfly.capabilities import Agent
from sfly.testing import run_node

PACKAGE = Path(__file__).resolve().parents[3] / "testdata" / "agent-files-package"
SFLY = str(Path(sys.executable).parent / "sfly")

#: 一棵进程树：sh 在后台启动 sleep，把两者的 PID 写进 `$PIDS`，然后等它。
TREE = 'sleep 300 & echo $! >> "$PIDS"; echo $$ >> "$PIDS"; echo started; wait'


@pytest.fixture(autouse=True)
def package_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.syspath_prepend(str(PACKAGE / "src"))


def wait_for(check: Callable[[], bool], timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.02)


def alive(pid: int) -> bool:
    """进程是否还活着（僵尸进程算已经结束）。"""
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as f:
            state = f.read().rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError):
        return False
    return state not in ("Z", "X")


def pids_in(path: Path) -> list[int]:
    try:
        return [int(p) for p in path.read_text(encoding="utf-8").split()]
    except OSError:
        return []


def run(tmp_path: Path, inputs: dict[str, Any], **kwargs: Any) -> Any:
    from sfly_agent_files import commands

    return run_node(commands.run_command, inputs, work_dir=tmp_path / "work", **kwargs)


def lines(result: Any, source: str) -> list[str]:
    return [line.message for line in result.logs if line.source == source]


def test_the_own_agent_runs_the_command_here_and_logs_its_output_tagged(tmp_path: Path) -> None:
    result = run(tmp_path, {"command": "echo out; echo err >&2; printf tail; exit 3"})

    assert result.status == "success", result.error
    assert result.outputs == {"exit_code": 3, "error": None}
    assert lines(result, "stdout") == ["开始执行命令", "[本机] out", "[本机] tail"]
    assert lines(result, "stderr") == ["[本机] err"]


def test_a_mapped_agent_runs_in_its_directory_with_argv_and_env(tmp_path: Path) -> None:
    source = tmp_path / "source"
    (source / "srv" / "app").mkdir(parents=True)
    inputs = {
        "argv": ["sh", "-c", 'pwd; echo "$GREETING"; kill -TERM $$'],
        "source": "cmd-source",
        "cwd": "/srv/app",
        "env": {"GREETING": "你好"},
    }

    result = run(tmp_path, inputs, agents={"cmd-source": source})

    assert result.status == "success", result.error
    # 被信号终止：128 + 信号值。
    assert result.outputs == {"exit_code": 128 + 15, "error": None}
    tag = "[Agent cmd-source] "
    assert lines(result, "stdout")[1:] == [f"{tag}{source / 'srv' / 'app'}", f"{tag}你好"]

    missing = run(tmp_path, {**inputs, "cwd": "/srv/none"}, agents={"cmd-source": source})
    assert missing.outputs["error"] == {
        "type": "AgentFileNotFound",
        "kind": "not_found",
        "agent": "cmd-source",
        "message": "Agent cmd-source：工作目录 /srv/none 不存在",
    }
    no_program = run(
        tmp_path, {**inputs, "argv": ["sfly-no-such-program"]}, agents={"cmd-source": source}
    )
    assert no_program.outputs["error"]["type"] == "AgentFileNotFound"
    assert no_program.outputs["error"]["message"] == (
        "Agent cmd-source：找不到程序 sfly-no-such-program"
    )


def test_running_past_the_timeout_ends_the_whole_tree(tmp_path: Path) -> None:
    pids = tmp_path / "pids"

    result = run(tmp_path, {"command": TREE, "timeout": 1, "env": {"PIDS": str(pids)}})

    assert result.status == "success", result.error
    assert result.outputs["error"] == {
        "type": "AgentTimeout",
        "kind": "timeout",
        "agent": None,
        "message": "本机：命令超过 1 秒没有结束，已结束它的进程树",
    }
    assert lines(result, "stdout")[1:] == ["[本机] started"]
    tree = pids_in(pids)
    assert len(tree) == 2
    wait_for(lambda: not any(alive(p) for p in tree))


def test_cancelling_the_task_ends_the_whole_tree(tmp_path: Path) -> None:
    pids = tmp_path / "pids"

    result = run(
        tmp_path,
        {"command": TREE, "timeout": 600, "env": {"PIDS": str(pids)}},
        cancel_when=lambda _: len(pids_in(pids)) == 2,
    )

    assert result.status == "cancelled"
    tree = pids_in(pids)
    wait_for(lambda: not any(alive(p) for p in tree))


def test_force_cancelling_the_task_also_ends_the_whole_tree(tmp_path: Path) -> None:
    # 强制取消直接杀掉执行器，它来不及清理：命令由看守进程启动，执行器一退出看守进程就结束它。
    from sfly.local import Cancellation, execute

    pids = tmp_path / "pids"
    cancellation = Cancellation()

    def tick(_: Any) -> None:
        if len(pids_in(pids)) == 2:
            cancellation.cancel(force=True)

    result = execute(
        "sfly_agent_files.commands:run_command",
        {"command": TREE, "timeout": 600, "env": {"PIDS": str(pids)}},
        tmp_path / "work",
        pythonpath=[str(PACKAGE / "src"), *(p for p in sys.path if p)],
        cancellation=cancellation,
        on_tick=tick,
    )

    assert result.status == "cancelled"
    assert result.error is not None and "强制" in result.error.message
    tree = pids_in(pids)
    wait_for(lambda: not any(alive(p) for p in tree))


def test_a_cancel_right_after_the_command_starts_ends_the_whole_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 取消（SIGTERM）恰好落在启动命令的调用返回之后、登记好清理之前（这时命令已经在运行）：
    # 命令照样被结束，exec.run 等它结束才返回。
    from sfly.context import on_sigterm

    monkeypatch.delenv("SFLY_AGENT_SOCKET", raising=False)
    pids = tmp_path / "pids"
    real_popen = subprocess.Popen

    def popen_then_sigterm(*args: Any, **kwargs: Any) -> Any:
        started = real_popen(*args, **kwargs)
        wait_for(lambda: len(pids_in(pids)) == 2)
        on_sigterm(signal.SIGTERM, None)
        return started

    monkeypatch.setattr(subprocess, "Popen", popen_then_sigterm)

    with pytest.raises(sfly.Cancelled):
        Agent(None, local_mapping={}).exec.run(TREE, timeout=600, env={"PIDS": str(pids)})

    tree = pids_in(pids)
    wait_for(lambda: not any(alive(p) for p in tree))


def test_a_timeout_is_required_and_arguments_are_checked(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SFLY_AGENT_SOCKET", raising=False)
    exec_ = Agent(None, local_mapping={}).exec

    with pytest.raises(TypeError, match="timeout"):
        exec_.run("true")  # type: ignore[call-arg]
    with pytest.raises(ValueError, match="必须给超时"):
        exec_.run("true", timeout=None)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="大于 0"):
        exec_.run("true", timeout=0)
    with pytest.raises(ValueError, match="是空的"):
        exec_.run([], timeout=1)
    with pytest.raises(TypeError):
        exec_.run(b"true", timeout=1)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="绝对路径"):
        exec_.run("true", timeout=1, cwd="relative")
    with pytest.raises(sfly.AgentNotReferenced):
        Agent("other", local_mapping={}).exec.run("true", timeout=1)
    assert exec_.run(["true"], timeout=5) == 0


def test_sfly_debug_runs_a_command_on_an_agent_mapped_to_a_local_directory(tmp_path: Path) -> None:
    project = tmp_path / "project"
    shutil.copytree(PACKAGE, project, ignore=shutil.ignore_patterns("__pycache__", "dist"))
    source = tmp_path / "source"
    source.mkdir()

    done = subprocess.run(
        [
            SFLY,
            "debug",
            "run_command",
            "--params",
            '{"source": "cmd-source", "command": "pwd; exit 4"}',
            "--agent",
            f"cmd-source={source}",
        ],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert done.returncode == 0, done.stderr
    assert f"[Agent cmd-source] {source}" in done.stdout + done.stderr
    assert '"exit_code": 4' in done.stdout


# ---- 经本地 socket 发出的调用 ----


@pytest.fixture
def short_dir() -> Iterator[Path]:
    """socket 路径不能太长（AF_UNIX 108 字节），放在 TMPDIR 下的短目录里。"""
    import tempfile

    with tempfile.TemporaryDirectory(prefix="sfly-") as tmp:
        yield Path(tmp)


class ReplyingAgent:
    """假的 Agent 本地 socket：记下请求，回复给定的若干帧后关闭连接。"""

    def __init__(self, path: Path, frames: list[Any]) -> None:
        import socket

        self.requests: list[dict[str, Any]] = []
        self._frames = frames
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(str(path))
        self._server.listen()
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        conn, _ = self._server.accept()
        with conn, conn.makefile("rb") as reader:
            self.requests.append(json.loads(reader.readline()))
            for frame in self._frames:
                conn.sendall(json.dumps(frame, ensure_ascii=False).encode("utf-8") + b"\n")


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


def test_the_command_goes_to_the_own_agent_and_its_lines_go_to_stdout_and_stderr(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]
) -> None:
    agent = ReplyingAgent(
        short_dir / "agent.sock",
        [
            {"item": {"stdout": "[Agent cmd-source] 第一行"}},
            {"item": {"stderr": "[Agent cmd-source] oops"}},
            {"item": {"stdout": "[Agent cmd-source] 第二行"}},
            {"result": {"exit_code": 5}},
        ],
    )
    ctx = context(short_dir, monkeypatch)

    code = ctx.agent("cmd-source").exec.run(
        "gzip -9 /var/log/app.log.1", timeout=2.5, cwd="/var/log", env={"LC_ALL": "C"}
    )

    assert code == 5
    assert agent.requests == [
        {
            "command": "call",
            "task_id": "t-1",
            "attempt": 1,
            "agent": "cmd-source",
            "method": "exec.run",
            "args": {
                "argv": ["/bin/sh", "-c", "gzip -9 /var/log/app.log.1"],
                "cwd": "/var/log",
                "env": {"LC_ALL": "C"},
            },
            "timeout_ms": 2500,
        }
    ]
    captured = capfd.readouterr()
    assert captured.out == "[Agent cmd-source] 第一行\n[Agent cmd-source] 第二行\n"
    assert captured.err == "[Agent cmd-source] oops\n"


def test_a_timeout_reply_raises_agent_timeout(
    short_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    message = "Agent cmd-source：命令超过 1 秒没有结束，已结束它的进程树"
    ReplyingAgent(
        short_dir / "agent.sock",
        [{"error": {"kind": "timeout", "message": message, "agent": "cmd-source"}}],
    )
    ctx = context(short_dir, monkeypatch)

    with pytest.raises(sfly.AgentTimeout, match="已结束它的进程树") as raised:
        ctx.agent("cmd-source").exec.run(["sleep", "100"], timeout=1)
    assert raised.value.agent == "cmd-source"
