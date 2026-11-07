"""`process_assert`：在真实的执行器进程里检查一次进程的状态（`sfly.testing.run_node`）。"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from sfly.testing import Execution, run_node
from sfly_std.process_assert import process_assert


def run(tmp_path: Path, **inputs: Any) -> Execution:
    return run_node(process_assert, inputs, work_dir=tmp_path / "task")


def failure(result: Execution) -> str:
    assert result.status == "failed", result.outputs
    assert result.error is not None
    return result.error.message


@pytest.fixture
def spawn() -> Iterator[Any]:
    """启动进程，测试结束时终止并回收（不留僵尸进程）。"""
    procs: list[subprocess.Popen[bytes]] = []

    def start(*argv: str) -> subprocess.Popen[bytes]:
        proc = subprocess.Popen(argv)
        procs.append(proc)
        return proc

    yield start
    for proc in procs:
        proc.kill()
        proc.wait()


def test_passes_when_the_pid_is_running_and_outputs_the_matched_pids(
    tmp_path: Path, spawn: Any
) -> None:
    proc = spawn("sleep", "300")

    result = run(tmp_path, pid=proc.pid)

    assert result.status == "success", result.error
    assert result.outputs == {"passed": True, "count": 1, "pids": [proc.pid]}


def test_fails_when_the_pid_is_not_running(tmp_path: Path, spawn: Any) -> None:
    proc = spawn("true")
    proc.wait()

    assert failure(run(tmp_path, pid=proc.pid)) == (
        "sfly_std.process_assert.ProcessAssertionFailed: "
        f"pid {proc.pid} 的进程应在运行，实际没有找到"
    )


def test_a_zombie_process_does_not_count_as_running(tmp_path: Path, spawn: Any) -> None:
    proc = spawn("true")
    while _state(proc.pid) != "Z":  # 已退出、还没被回收
        time.sleep(0.01)

    assert run(tmp_path, pid=proc.pid, running=False).status == "success"


def _state(pid: int) -> str:
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]


@pytest.fixture
def unique_sleep(tmp_path: Path) -> str:
    """指向 sleep 的符号链接：进程名（执行的文件名）在机器上唯一。"""
    name = f"sl{uuid.uuid4().hex[:10]}"
    sleep = shutil.which("sleep")
    assert sleep is not None
    os.symlink(sleep, tmp_path / name)
    return str(tmp_path / name)


def test_name_and_match_must_both_hold(tmp_path: Path, spawn: Any, unique_sleep: str) -> None:
    name = Path(unique_sleep).name
    a = spawn(unique_sleep, "300")
    spawn(unique_sleep, "301")

    result = run(tmp_path, name=name, match=r"\b300$")

    assert result.status == "success", result.error
    assert result.outputs == {"passed": True, "count": 1, "pids": [a.pid]}


def test_running_false_fails_listing_the_processes_still_running(
    tmp_path: Path, spawn: Any, unique_sleep: str
) -> None:
    name = Path(unique_sleep).name
    a = spawn(unique_sleep, "300")
    b = spawn(unique_sleep, "301")

    assert failure(run(tmp_path, name=name, running=False)) == (
        "sfly_std.process_assert.ProcessAssertionFailed: "
        f'name "{name}" 的进程应不在运行，实际有 2 个：\n'
        f"- pid {a.pid} {name}：{unique_sleep} 300\n"
        f"- pid {b.pid} {name}：{unique_sleep} 301"
    )
    assert run(tmp_path, name=name + "x", running=False).status == "success"


def test_count_checks_the_exact_number_of_matched_processes(
    tmp_path: Path, spawn: Any, unique_sleep: str
) -> None:
    name = Path(unique_sleep).name
    a = spawn(unique_sleep, "300")
    b = spawn(unique_sleep, "301")

    result = run(tmp_path, name=name, count=2)
    assert result.status == "success", result.error
    assert result.outputs == {"passed": True, "count": 2, "pids": sorted([a.pid, b.pid])}

    assert failure(run(tmp_path, match=f"{name} 30[01]$", count=3)) == (
        "sfly_std.process_assert.ProcessAssertionFailed: "
        f'match "{name} 30[01]$" 的进程应有 3 个，实际有 2 个：\n'
        f"- pid {a.pid} {name}：{unique_sleep} 300\n"
        f"- pid {b.pid} {name}：{unique_sleep} 301"
    )
    assert failure(run(tmp_path, name=name + "x", count=1)) == (
        "sfly_std.process_assert.ProcessAssertionFailed: "
        f'name "{name}x" 的进程应有 1 个，实际有 0 个'
    )


def test_rejects_count_contradicting_running_false(tmp_path: Path) -> None:
    assert failure(run(tmp_path, name="x", running=False, count=1)) == (
        "ValueError: running 为 false 时 count 只能是 0 或不填，实际为 1"
    )


def test_outputs_at_most_1000_pids_but_counts_every_match(
    tmp_path: Path, spawn: Any, unique_sleep: str
) -> None:
    # 节点输出有大小上限：pids 只列出 pid 最小的 1000 个，count 仍是全部数量，并在日志里写明。
    procs = [spawn(unique_sleep, "300") for _ in range(1001)]

    result = run(tmp_path, name=Path(unique_sleep).name, count=1001)

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["count"] == 1001
    assert result.outputs["pids"] == sorted(p.pid for p in procs)[:1000]
    assert "匹配到 1001 个进程，输出 pids 只列出 pid 最小的 1000 个" in [
        line.message for line in result.logs if line.source == "sdk"
    ]
