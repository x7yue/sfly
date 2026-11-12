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


def test_labeled_points_are_returned_and_invalid_labels_dropped_with_one_warning_each() -> None:
    from sfly_stub import metrics

    long = "x" * 129
    result = run_node(
        metrics,
        {
            "steps": [
                ["conn", 1, {"host": "a", "port": 8080}],
                ["conn", 2, {"port": "8080", "host": "b"}],
                ["level", 3],
                ["conn", 4, {"host": "a"}],
                ["conn", 5, {"host": "a"}],
                ["conn", 6, {"host": "a", "port": "1", "db": "x"}],
                ["level", 7, {"host": "a"}],
                ["conn", 8, {"host": "", "port": "1"}],
                ["conn", 9, {"host": long, "port": "1"}],
                ["conn", 10, {"host": "x" * 128, "port": 1.5}],
            ]
        },
    )

    assert result.status == "success", result.error
    assert [(m.name, m.value, m.labels) for m in result.metrics] == [
        ("conn", 1.0, {"host": "a", "port": "8080"}),
        ("conn", 2.0, {"host": "b", "port": "8080"}),
        ("level", 3.0, {}),
        ("conn", 10.0, {"host": "x" * 128, "port": "1.5"}),
    ]
    warnings = [line.message for line in result.logs if line.level == "warn"]
    # 缺键的两次上报只警告一次。
    assert len(warnings) == 5, warnings
    assert "conn" in warnings[0] and "port" in warnings[0] and "缺少" in warnings[0]
    assert "conn" in warnings[1] and "db" in warnings[1] and "未声明" in warnings[1]
    assert "level" in warnings[2] and "没有声明标签键" in warnings[2]
    assert "conn" in warnings[3] and "host" in warnings[3] and "空" in warnings[3]
    assert "conn" in warnings[4] and "host" in warnings[4] and "128" in warnings[4]


def test_series_beyond_the_per_task_cap_are_dropped_with_one_warning_per_metric() -> None:
    from sfly_stub import metrics

    # 上限 1000 个序列：两个不带标签的指标（level、total）各占 1 个，conn 最多 998 个序列。
    hosts = [f"h{i}" for i in range(1000)]
    result = run_node(
        metrics,
        {
            "steps": [
                *(["conn", i, {"host": h, "port": 80}] for i, h in enumerate(hosts)),
                ["level", 1],
                ["conn", 2000, {"host": "h0", "port": 80}],
                ["conn", 3000, {"host": "h999", "port": 80}],
                ["total", 4],
            ]
        },
    )

    assert result.status == "success", result.error
    conn = [(m.labels["host"], m.value) for m in result.metrics if m.name == "conn"]
    assert len({host for host, _ in conn}) == 998
    assert conn[:2] == [("h0", 0.0), ("h1", 1.0)]
    assert conn[-2:] == [("h997", 997.0), ("h0", 2000.0)]
    assert [(m.name, m.value) for m in result.metrics if m.name != "conn"] == [
        ("level", 1.0),
        ("total", 4.0),
    ]
    warnings = [line.message for line in result.logs if line.level == "warn"]
    assert len(warnings) == 1, warnings
    assert "conn" in warnings[0] and "1000" in warnings[0]


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


def test_metric_rate_reports_sequence_numbers_at_the_given_rate(tmp_path: Path) -> None:
    from sfly_stub import metric_rate

    result = run_node(metric_rate, {"rate": 2000, "seconds": 0.5}, work_dir=tmp_path / "w")

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["count"] == 1000
    # 按速率均匀上报，不会一口气写完：最后一次对时（第 900 次）要等到 0.45 秒。只断言这个下限——
    # 它由节拍保证，与机器快慢无关；上限取决于机器有多忙，不断言。
    assert result.outputs["elapsed"] >= 0.45
    assert result.outputs["max_behind_ms"] >= 0
    assert result.outputs["max_call_ms"] >= 0
    assert [(m.name, m.value) for m in result.metrics] == [
        ("seq", float(i)) for i in range(1, 1001)
    ]


def test_metric_clock_reports_the_wall_clock_time_of_each_call(tmp_path: Path) -> None:
    from sfly_stub import metric_clock

    before = time.time() * 1000
    result = run_node(metric_clock, {"rate": 2000, "seconds": 0.5}, work_dir=tmp_path / "w")
    after = time.time() * 1000

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["count"] == 1000
    assert result.outputs["elapsed"] >= 0.45
    values = [m.value for m in result.metrics]
    assert [m.name for m in result.metrics] == ["clock_ms"] * 1000
    # 每次上报调用时的 Unix 毫秒数：单调不减，落在执行前后之间，并按速率铺满 seconds。
    assert values == sorted(values)
    assert before <= values[0] and values[-1] <= after
    assert values[-1] - values[0] >= 400


def test_stdout_rate_writes_numbered_lines_of_fixed_size_at_the_given_rate() -> None:
    from sfly_stub import stdout_rate

    # 每秒 0.1 MiB、每行 100 字节、0.5 秒：共 524 行。
    result = run_node(stdout_rate, {"mib_per_second": 0.1, "seconds": 0.5, "line_bytes": 100})

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["lines"] == 524
    assert result.outputs["bytes"] == 52400
    # 最后一次对时（第 500 行）要等到 500 / 1048 ≈ 0.48 秒（每秒 524 / 0.5 行）。
    assert result.outputs["elapsed"] >= 0.45
    assert result.outputs["max_behind_ms"] >= 0
    lines = [line.message for line in result.logs if line.source == "stdout"]
    assert [int(line.split(" ", 1)[0]) for line in lines] == list(range(1, 525))
    # 每行连同换行正好 line_bytes 字节。
    assert {len(line) + 1 for line in lines} == {100}


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


AGENT_NODES = """
from sfly import AgentName, Context, node


@node
def reach(ctx: Context, source: AgentName, backup: AgentName | None = None) -> dict:
    return {"source": source, "backup": backup}
"""


def test_agent_inputs_are_agent_names(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # 「Agent」类型的输入（#197）：节点收到 Agent 名称，本地调试时不检查它是否注册过。
    (tmp_path / "agent_nodes.py").write_text(AGENT_NODES, encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))

    result = run_node("agent_nodes:reach", {"source": "agent-a"})
    both = run_node("agent_nodes:reach", {"source": "agent-a", "backup": "agent-b"})

    assert result.status == "success", result.error
    assert result.outputs == {"source": "agent-a", "backup": None}
    assert both.outputs == {"source": "agent-a", "backup": "agent-b"}


def test_an_agent_input_that_is_not_a_string_is_a_config_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "agent_nodes.py").write_text(AGENT_NODES, encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))

    result = run_node("agent_nodes:reach", {"source": 1})

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.kind == "config_error"
    assert result.error.message == "输入 source 应为 string，实际是 1"


FEISHU_BOT_NODES = """
from sfly import Context, FeishuBot, node


@node
def alert(ctx: Context, bot: FeishuBot, backup: FeishuBot | None = None) -> dict:
    return {"bot": bot, "backup": backup, "is_str": isinstance(bot, str)}
"""


def test_feishu_bot_inputs_are_bot_names_and_need_no_registration_locally(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 「飞书机器人」类型的输入（#233）：节点收到机器人名称字符串；
    # 本地没有控制面，不检查机器人是否登记过。
    (tmp_path / "feishu_nodes.py").write_text(FEISHU_BOT_NODES, encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))

    result = run_node("feishu_nodes:alert", {"bot": "ops"})
    both = run_node("feishu_nodes:alert", {"bot": "ops", "backup": "dev"})

    assert result.status == "success", result.error
    assert result.outputs == {"bot": "ops", "backup": None, "is_str": True}
    assert both.outputs == {"bot": "ops", "backup": "dev", "is_str": True}


def test_a_feishu_bot_input_that_is_not_a_string_is_a_config_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "feishu_nodes.py").write_text(FEISHU_BOT_NODES, encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))

    result = run_node("feishu_nodes:alert", {"bot": 1})

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.kind == "config_error"
    assert result.error.message == "输入 bot 应为 string，实际是 1"
