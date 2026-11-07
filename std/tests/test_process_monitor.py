"""`process_monitor`：监控测试自己启动的真实进程（`sfly.testing.run_node`）。"""

from __future__ import annotations

import csv
import os
import re
import shlex
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path

import psutil
import pytest
from named_sleep import NamedSleep, named_sleep_fixture  # noqa: F401 -- fixture

from sfly.testing import Execution, run_node
from sfly_std.process_monitor import process_monitor
from sfly_std.start_process import start_process

#: processes.csv 的列（与「标准节点」页一致）。
CSV_COLUMNS = [
    "time",
    "pid",
    "ppid",
    "name",
    "cpu_percent",
    "rss_bytes",
    "threads",
    "open_fds",
    "io_read_bytes_per_s",
    "io_write_bytes_per_s",
    "cmdline",
]

Spawn = Callable[..., subprocess.Popen[bytes]]


@pytest.fixture
def spawn() -> Iterator[Spawn]:
    """启动一个测试用的进程（新进程组），测试结束时杀掉整组。"""
    procs: list[subprocess.Popen[bytes]] = []

    def run(args: Sequence[str]) -> subprocess.Popen[bytes]:
        proc = subprocess.Popen(list(args), start_new_session=True)
        procs.append(proc)
        return proc

    yield run
    for proc in procs:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()


def monitor(tmp_path: Path, **inputs: object) -> Execution:
    return run_node(process_monitor, {"interval": 0.2, **inputs}, work_dir=tmp_path)


def rows(result: Execution) -> list[dict[str, str]]:
    with open(result.artifacts["processes.csv"], newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        assert reader.fieldnames == CSV_COLUMNS
        return list(reader)


def metric_names(result: Execution) -> set[str]:
    return {point.name for point in result.metrics}


def test_monitors_a_process_by_pid_and_writes_per_process_samples(
    tmp_path: Path, spawn: Spawn
) -> None:
    proc = spawn(["sleep", "300"])

    result = monitor(tmp_path, pid=proc.pid, duration=1)

    assert result.status == "success", result.error
    assert metric_names(result) == {
        "cpu_percent",
        "rss_bytes",
        "threads",
        "open_fds",
        "io_read_bytes_per_s",
        "io_write_bytes_per_s",
    }
    samples = rows(result)
    assert len(samples) >= 3
    assert {row["pid"] for row in samples} == {str(proc.pid)}
    assert {row["name"] for row in samples} == {"sleep"}
    assert samples[0]["cmdline"] == "sleep 300"
    rss = [p.value for p in result.metrics if p.name == "rss_bytes"]
    assert all(value > 0 for value in rss)
    assert [p.value for p in result.metrics if p.name == "threads"][-1] == 1


def test_matches_targets_by_name_and_by_command_line_pattern(
    tmp_path: Path, spawn: Spawn, named_sleep: NamedSleep
) -> None:
    tag = f"pm{os.getpid()}"
    first = named_sleep.start(f"{tag}a", "300")
    second = named_sleep.start(f"{tag}b", "300")
    third = spawn([sys.executable, "-c", "import time; time.sleep(300)", tag])

    by_name = monitor(tmp_path / "name", name=[f"{tag}a", f"{tag}b"], duration=0.6)
    by_pattern = monitor(tmp_path / "match", match=rf"sleep\(300\) {tag}$", duration=0.6)
    mixed = monitor(
        tmp_path / "mixed", pid=first.pid, match=[f" {tag}b 300$", rf"\) {tag}$"], duration=0.6
    )

    assert by_name.status == "success", by_name.error
    assert {row["pid"] for row in rows(by_name)} == {str(first.pid), str(second.pid)}
    assert by_pattern.status == "success", by_pattern.error
    assert {row["pid"] for row in rows(by_pattern)} == {str(third.pid)}
    assert mixed.status == "success", mixed.error
    assert {row["pid"] for row in rows(mixed)} == {str(first.pid), str(second.pid), str(third.pid)}


def test_children_count_towards_the_totals_unless_include_children_is_false(
    tmp_path: Path, spawn: Spawn
) -> None:
    # 父进程是 shell，两个子进程各占约 64 MiB 内存。
    child = f"{sys.executable} -c 'import time; b = bytes([1]) * (64 << 20); time.sleep(300)'"
    parent = spawn(["sh", "-c", f"{child} & {child} & wait"])
    wait_for_children(parent.pid, 2)

    tree = monitor(tmp_path / "tree", pid=parent.pid, duration=0.6)
    alone = monitor(tmp_path / "alone", pid=parent.pid, include_children=False, duration=0.6)

    assert tree.status == "success", tree.error
    assert len({row["pid"] for row in rows(tree)}) == 3
    assert {row["ppid"] for row in rows(tree) if row["pid"] != str(parent.pid)} == {str(parent.pid)}
    assert [p.value for p in tree.metrics if p.name == "rss_bytes"][-1] > 128 << 20
    assert [p.value for p in tree.metrics if p.name == "threads"][-1] == 3
    assert alone.status == "success", alone.error
    assert {row["pid"] for row in rows(alone)} == {str(parent.pid)}
    assert [p.value for p in alone.metrics if p.name == "rss_bytes"][-1] < 64 << 20


def wait_for_children(pid: int, count: int) -> None:
    deadline = time.monotonic() + 10
    while len(psutil.Process(pid).children()) < count:
        assert time.monotonic() < deadline, f"进程 {pid} 没有启动 {count} 个子进程"
        time.sleep(0.05)


def test_waits_for_the_targets_to_appear(tmp_path: Path, spawn: Spawn) -> None:
    name = f"pm{os.getpid()}late"
    late = spawn(["sh", "-c", f"sleep 0.8; exec {shlex.join(NamedSleep.argv(name, '300'))}"])

    result = monitor(tmp_path / "run", name=name, duration=0.6)

    assert result.status == "success", result.error
    assert {row["pid"] for row in rows(result)} == {str(late.pid)}
    assert any("等待" in line.message and name in line.message for line in result.logs)


def test_fails_when_a_target_does_not_appear_within_wait_for_process(
    tmp_path: Path, spawn: Spawn
) -> None:
    present = spawn(["sleep", "300"])
    missing = f"pm{os.getpid()}none"
    started = time.monotonic()

    result = monitor(
        tmp_path, pid=present.pid, name=missing, match="^no such command$", wait_for_process=0.5
    )

    assert time.monotonic() - started < 5
    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message == (
        "sfly_std.process_monitor.ProcessNotFound: 等待 0.5 秒后仍没有找到目标进程："
        f'name "{missing}"、match "^no such command$"'
    ), result.error.message


def test_fails_when_a_target_exits_by_default(tmp_path: Path) -> None:
    started = run_node(start_process, {"command": "sleep 0.8; exit 3"}, work_dir=tmp_path)
    assert started.outputs is not None
    pid = started.outputs["pid"]

    # 与 start_process 同一个 work_dir（同一次运行）：能拿到退出码。
    result = monitor(tmp_path, pid=pid)

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message.startswith(
        f"sfly_std.process_monitor.ProcessExited: 目标进程已退出：pid {pid}（退出码 3）"
    ), result.error.message
    assert str(pid) in {row["pid"] for row in rows(result)}  # 另有子进程 sleep


def test_on_exit_succeed_ends_monitoring_successfully(
    tmp_path: Path, spawn: Spawn, named_sleep: NamedSleep
) -> None:
    name = f"pm{os.getpid()}exit"
    short = named_sleep.start(name, "0.8")
    other = spawn(["sleep", "300"])

    result = monitor(tmp_path / "run", pid=other.pid, name=name, on_exit="succeed")

    assert result.status == "success", result.error
    assert {row["pid"] for row in rows(result)} == {str(short.pid), str(other.pid)}
    assert result.outputs is not None
    assert result.outputs["samples"] >= 2
    assert any(f'目标进程已退出：name "{name}"' in line.message for line in result.logs)


def test_samples_collected_before_cancellation_are_kept(tmp_path: Path, spawn: Spawn) -> None:
    proc = spawn(["sleep", "300"])

    result = run_node(
        process_monitor,
        {"pid": proc.pid, "interval": 0.2},
        cancel_when=lambda partial: sum(p.name == "cpu_percent" for p in partial.metrics) >= 3,
        work_dir=tmp_path,
    )

    assert result.status == "cancelled"
    samples = rows(result)
    reported = sum(p.name == "cpu_percent" for p in result.metrics)
    assert reported >= 3
    assert len({row["time"] for row in samples}) >= reported
    assert all(row["pid"] == str(proc.pid) and row["cmdline"] == "sleep 300" for row in samples)


def test_logs_the_matched_processes_and_their_changes(tmp_path: Path, spawn: Spawn) -> None:
    parent = spawn(["sh", "-c", "sleep 0.6; sleep 300; true"])
    wait_for_children(parent.pid, 1)
    first_child = psutil.Process(parent.pid).children()[0].pid

    result = monitor(tmp_path, pid=parent.pid, duration=1.2)

    assert result.status == "success", result.error
    messages = [line.message for line in result.logs if line.source == "sdk"]
    assert messages[0] == (
        "监控 2 个进程：\n"
        f"pid {parent.pid} sh：sh -c sleep 0.6; sleep 300; true\n"
        f"pid {first_child} sleep：sleep 0.6"
    ), messages
    changes = "\n".join(m for m in messages if m.startswith("进程有变化"))
    second_child = next(c.pid for c in psutil.Process(parent.pid).children())
    assert f"已退出 pid {first_child} sleep" in changes, messages
    assert f"新增 pid {second_child} sleep：sleep 300" in changes, messages


def test_cpu_percent_is_the_total_of_all_processes(tmp_path: Path, spawn: Spawn) -> None:
    busy = spawn([sys.executable, "-c", "while True: pass"])
    idle = spawn(["sleep", "300"])

    result = monitor(tmp_path, pid=[busy.pid, idle.pid], duration=1)

    assert result.status == "success", result.error
    cpu = [p.value for p in result.metrics if p.name == "cpu_percent"]
    assert max(cpu) > 50, cpu  # 一个核满载约为 100（机器很忙时会低一些）
    by_pid: dict[str, list[float]] = {}
    for row in rows(result):
        by_pid.setdefault(row["pid"], []).append(float(row["cpu_percent"]))
    assert max(by_pid[str(busy.pid)]) > 50
    assert max(by_pid[str(idle.pid)]) < 5


@pytest.mark.parametrize(
    ("inputs", "message"),
    [
        ({}, "ValueError: 至少要给出 pid、name、match 中的一个"),
        ({"pid": 0}, "ValueError: pid 必须是正整数，实际为 0"),
        ({"match": "("}, "ValueError: match 不是合法的正则表达式：'('（"),
        ({"pid": 1, "interval": 0}, "ValueError: interval 必须大于 0，实际为 0"),
        ({"pid": 1, "duration": 0}, "ValueError: duration 必须大于 0，实际为 0"),
    ],
)
def test_rejects_invalid_parameters(
    tmp_path: Path, inputs: dict[str, object], message: str
) -> None:
    result = run_node(process_monitor, inputs, work_dir=tmp_path)

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message.startswith(message), result.error.message


def test_the_standard_nodes_page_documents_the_csv_columns_in_order() -> None:
    page = (Path(__file__).parents[2] / "docs" / "guide" / "standard-nodes.md").read_text(
        encoding="utf-8"
    )
    section = page.split("## `process_monitor`", 1)[1].split("\n## ", 1)[0]
    table = section.split("| `processes.csv` 的列 |", 1)[1].split("\n\n", 1)[0]

    assert re.findall(r"^\| `([a-z_]+)` \|", table, re.M) == CSV_COLUMNS
