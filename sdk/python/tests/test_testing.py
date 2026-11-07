"""`sfly.testing`：在 pytest 里执行节点（本地调试）。

对桩节点包（testdata/stub-package）执行节点，期望值与 Agent 的集成测试（agent/tests）一致：
日志的来源与级别、进度、指标、产物引用、失败与取消。
"""

from __future__ import annotations

import os
import stat
import time
from pathlib import Path

import pytest

from sfly.testing import run_node

STUB_SRC = Path(__file__).resolve().parents[3] / "testdata" / "stub-package" / "src"


@pytest.fixture(autouse=True)
def stub_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.syspath_prepend(str(STUB_SRC))


def test_success_returns_outputs() -> None:
    from sfly_stub import echo

    result = run_node(echo, {"text": {"a": [1, "二"]}})

    assert result.status == "success"
    assert result.outputs == {"text": {"a": [1, "二"]}}
    assert result.error is None


def test_logs_have_the_same_sources_and_levels_as_on_the_agent() -> None:
    from sfly_stub import chatter

    result = run_node(chatter)

    assert result.status == "success", result.error
    got = sorted((line.source, line.level, line.message) for line in result.logs)
    assert got == sorted(
        [
            ("stdout", "info", "来自 print"),
            ("stderr", "error", "来自标准错误"),
            ("stdout", "info", "来自子进程"),
            ("stderr", "error", "子进程错误"),
            ("sdk", "debug", "sdk 调试"),
            ("sdk", "info", "sdk 信息 1"),
            ("sdk", "warn", "sdk 警告"),
            ("sdk", "error", "sdk 错误"),
        ]
    )
    # 同一来源内保持写入顺序。
    assert [line.message for line in result.logs if line.source == "sdk"] == [
        "sdk 调试",
        "sdk 信息 1",
        "sdk 警告",
        "sdk 错误",
    ]


def test_every_progress_report_is_returned() -> None:
    from sfly_stub import chatter

    result = run_node(chatter, {"steps": 3})

    assert [(p.current, p.total, p.message) for p in result.progress] == [
        (1, 3, "第 1 步"),
        (2, 3, "第 2 步"),
        (3, 3, "第 3 步"),
    ]


def test_declared_metrics_are_returned_and_undeclared_ones_dropped_with_a_warning() -> None:
    from sfly_stub import metrics

    result = run_node(
        metrics, {"steps": [["level", 1.5], ["total", 3], ["nope", 1], ["level", "nan"]]}
    )

    assert result.status == "success", result.error
    assert [(m.name, m.kind, m.value) for m in result.metrics] == [
        ("level", "gauge", 1.5),
        ("total", "counter", 3.0),
    ]
    warnings = [line.message for line in result.logs if line.level == "warn"]
    assert len(warnings) == 2
    assert "nope" in warnings[0] and "未声明" in warnings[0]
    assert "level" in warnings[1] and "有限" in warnings[1]


def test_events_go_through_a_fifo_in_the_work_dir_and_none_are_lost(tmp_path: Path) -> None:
    from sfly_stub import metric_burst

    result = run_node(metric_burst, {"seconds": 0.5}, work_dir=tmp_path / "w")

    assert result.status == "success", result.error
    assert result.outputs is not None
    count = result.outputs["count"]
    assert count > 1000
    assert [m.value for m in result.metrics] == [float(i) for i in range(1, count + 1)]
    assert stat.S_ISFIFO(os.stat(tmp_path / "w" / "events.fifo").st_mode)
    assert not (tmp_path / "w" / "events.jsonl").exists()


def test_executor_crash_summary_keeps_the_stderr_tail_without_stderr_log(tmp_path: Path) -> None:
    from sfly_stub import write_failure

    result = run_node(
        write_failure, {"message": "OSError: [Errno 122] Disk quota exceeded"}, work_dir=tmp_path
    )

    assert result.status == "failed"
    assert result.error is not None
    assert "没有写出结果" in result.error.message
    assert "OSError: [Errno 122] Disk quota exceeded" in result.error.message


def test_task_info_is_local_and_procs_dir_is_in_the_work_dir(tmp_path: Path) -> None:
    from sfly_stub import task_info

    result = run_node(task_info, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert result.outputs == {
        "run_id": "local",
        "node_id": "task_info",
        "task_id": "local",
        "attempt": 1,
        "procs_dir": str(tmp_path / "procs"),
    }


def test_artifacts_are_saved_in_the_work_dir_and_refs_are_local_paths(tmp_path: Path) -> None:
    from sfly_stub import artifacts

    result = run_node(
        artifacts, {"files": {"a.txt": "甲", "dir/b.json": "{}"}}, work_dir=tmp_path / "w"
    )

    assert result.status == "success", result.error
    root = tmp_path / "w" / "artifacts"
    assert result.artifacts_dir == root
    assert result.artifacts == {"a.txt": root / "a.txt", "dir/b.json": root / "dir" / "b.json"}
    assert (root / "a.txt").read_text(encoding="utf-8") == "甲"
    assert result.outputs == {
        "refs": {"a.txt": str(root / "a.txt"), "dir/b.json": str(root / "dir" / "b.json")}
    }


def test_exception_in_node_is_a_node_error_with_traceback() -> None:
    from sfly_stub import fail

    result = run_node(fail, {"message": "磁盘满了"})

    assert result.status == "failed"
    assert result.outputs is None
    assert result.error is not None
    assert result.error.kind == "node_error"
    assert result.error.type == "RuntimeError"
    assert result.error.message == "RuntimeError: 磁盘满了"
    assert "Traceback" in result.error.traceback


def test_output_over_1_mb_is_a_node_error() -> None:
    from sfly_stub import big

    result = run_node(big, {"size": 1024 * 1024})

    assert result.status == "failed"
    assert result.error is not None
    assert "节点返回值超过 1 MB 上限" in result.error.message


def test_invalid_inputs_are_a_config_error_and_the_node_does_not_run(tmp_path: Path) -> None:
    from sfly_stub import sleep

    result = run_node(sleep, {"seconds": "很久"}, work_dir=tmp_path / "w")
    missing = run_node(sleep, {})

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.kind == "config_error"
    assert result.error.message == '输入 seconds 应为 number，实际是 "很久"'
    assert not (tmp_path / "w" / "task.json").exists()
    assert missing.error is not None
    assert missing.error.message == "缺少必填输入 seconds"


def test_entry_string_runs_the_same_node() -> None:

    result = run_node("sfly_stub:echo", {"text": "x"})

    assert result.outputs == {"text": "x"}


def test_simulated_cancel_raises_cancelled_in_the_node_and_finally_runs(tmp_path: Path) -> None:
    from sfly_stub import wait_cancel

    ready, report = tmp_path / "ready", tmp_path / "report"
    result = run_node(
        wait_cancel,
        {"ready_file": str(ready), "report_file": str(report)},
        cancel_when=lambda partial: ready.exists(),
    )

    assert result.status == "cancelled"
    assert result.error is not None
    assert result.error.message == "任务已取消，已终止进程树"
    # finally 里的清理执行了，并且看到了取消标记。
    assert report.read_text() == "cancelled"


def test_cancel_kills_a_node_that_ignores_sigterm_once_the_grace_period_ends(
    tmp_path: Path,
) -> None:
    from sfly_stub import process_tree

    pid_file = tmp_path / "pids"
    started = time.monotonic()
    result = run_node(
        process_tree,
        {"pid_file": str(pid_file), "ignore_term": True},
        cancel_when=lambda partial: pid_file.exists(),
        grace=0.5,
    )

    assert result.status == "cancelled"
    assert time.monotonic() - started < 10
    _assert_all_exited(list(map(int, pid_file.read_text().split())))


def test_cancel_after_seconds() -> None:
    from sfly_stub import sleep

    result = run_node(sleep, {"seconds": 30}, cancel_after=0.3)

    assert result.status == "cancelled"


@pytest.mark.parametrize("error", [ProcessLookupError, FileNotFoundError])
def test_alive_treats_a_process_that_vanishes_before_proc_is_read_as_exited(
    monkeypatch: pytest.MonkeyPatch, error: type[OSError]
) -> None:
    # 竞态的确定性复现：os.kill(pid, 0) 时进程还在，读 /proc/<pid>/stat 时已经消失。
    monkeypatch.setattr(os, "kill", lambda pid, sig: None)

    def vanished(path: str, *args: object, **kwargs: object) -> None:
        raise error(3, "No such process", path)

    monkeypatch.setattr("builtins.open", vanished)

    assert not _alive(12345)


def _assert_all_exited(pids: list[int]) -> None:
    # SIGKILL 的投递是异步的：执行器只等得到组长，孙进程在高负载下可能稍后才真正退出。
    # 与 Agent 的同类测试（agent/tests/timeout.rs 的 assert_all_gone）一样限时轮询。
    deadline = time.monotonic() + 5
    while any(_alive(pid) for pid in pids):
        assert time.monotonic() < deadline, f"进程仍在运行：{[p for p in pids if _alive(p)]}"
        time.sleep(0.02)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # 僵尸进程（已退出未回收）也算退出。进程可能在 os.kill 之后、读 /proc 之前退出，
    # 这时读取会抛 ProcessLookupError 或 FileNotFoundError，同样算已退出。
    try:
        with open(f"/proc/{pid}/stat") as f:
            stat = f.read()
    except OSError:
        return False
    # 第三个字段是状态；命令名在括号里，可能有空格，从最后一个 ')' 之后取。
    return stat.rpartition(")")[2].split()[0] not in ("Z", "X")
