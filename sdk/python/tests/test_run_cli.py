"""`sfly run`：在当前项目环境里执行一个节点（本地调试）。CLI 作为子进程运行，项目是桩节点包的副本。

约定：输出值、指标汇总、运行目录打印到标准输出；日志实时打印到标准错误。
退出码：成功 0，节点失败 1，参数不合法 2，取消 130。
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

STUB = Path(__file__).resolve().parents[3] / "testdata" / "stub-package"
SFLY = str(Path(sys.executable).parent / "sfly")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "stub"
    shutil.copytree(STUB, root, ignore=shutil.ignore_patterns("__pycache__", "dist"))
    return root


def sfly_run(project: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [SFLY, "run", *args], cwd=project, capture_output=True, text=True, timeout=60
    )


def outputs_of(stdout: str) -> object:
    """标准输出里「输出：」后面的 JSON。"""
    text = stdout.split("输出：\n", 1)[1]
    value, _ = json.JSONDecoder().raw_decode(text)
    return value


def test_success_prints_outputs_and_logs(project: Path) -> None:
    run = sfly_run(project, "echo", "--params", '{"text": {"你好": [1, 2]}}')

    assert run.returncode == 0, run.stderr
    assert outputs_of(run.stdout) == {"text": {"你好": [1, 2]}}

    chatter = sfly_run(project, "chatter")
    assert chatter.returncode == 0, chatter.stderr
    lines = chatter.stderr.splitlines()
    for level, source, message in [
        ("info", "stdout", "来自 print"),
        ("error", "stderr", "来自标准错误"),
        ("debug", "sdk", "sdk 调试"),
        ("warn", "sdk", "sdk 警告"),
    ]:
        assert any(line.endswith(f" {level:<5} {source:<6} {message}") for line in lines), (
            chatter.stderr
        )


def test_metrics_are_summarized_as_a_table(project: Path) -> None:
    steps = [["level", 1], ["level", 3], ["level", 2], ["total", 5], ["total", 7]]

    run = sfly_run(project, "metrics", "--params", json.dumps({"steps": steps}))

    assert run.returncode == 0, run.stderr
    table = run.stdout.split("指标：\n", 1)[1].splitlines()
    assert table[0].split() == ["指标", "类型", "次数", "最后值", "最小值", "最大值"]
    assert table[1].split() == ["level", "gauge", "3", "2", "1", "3"]
    assert table[2].split() == ["total", "counter", "2", "7", "5", "7"]


def test_metric_table_has_a_row_per_series_with_its_label_values(project: Path) -> None:
    steps = [
        ["level", 1],
        ["conn", 3, {"port": 80, "host": "a"}],
        ["conn", 5, {"host": "b", "port": "80"}],
        ["conn", 1, {"host": "a", "port": "80"}],
        ["level", 2],
    ]

    run = sfly_run(project, "metrics", "--params", json.dumps({"steps": steps}))

    assert run.returncode == 0, run.stderr
    table = run.stdout.split("指标：\n", 1)[1].splitlines()
    # 每个序列一行（按首次上报的顺序），指标名后面跟标签值（数字已转成字符串，按键排序）。
    assert [row.split() for row in table[1:4]] == [
        ["level", "gauge", "2", "2", "1", "2"],
        ["conn{host=a,port=80}", "gauge", "2", "1", "1", "3"],
        ["conn{host=b,port=80}", "gauge", "1", "5", "5", "5"],
    ]


def test_artifacts_of_each_run_are_in_their_own_timestamped_directory(project: Path) -> None:
    first = sfly_run(project, "artifacts", "--params", '{"files": {"a.txt": "第一次"}}')
    second = sfly_run(project, "artifacts", "--params", '{"files": {"a.txt": "第二次"}}')

    assert first.returncode == 0 and second.returncode == 0, first.stderr + second.stderr
    runs = sorted((project / ".sfly" / "runs").iterdir())
    assert len(runs) == 2
    assert [(r / "artifacts" / "a.txt").read_text(encoding="utf-8") for r in runs] == [
        "第一次",
        "第二次",
    ]
    # 目录名以时间开头（按名称排序即按时间排序），再跟节点名。
    assert all(r.name.endswith("-artifacts") and r.name[:8].isdigit() for r in runs)
    assert str(runs[0]) in first.stdout and "a.txt" in first.stdout
    assert outputs_of(second.stdout) == {"refs": {"a.txt": str(runs[1] / "artifacts" / "a.txt")}}
    # 运行目录不进版本库。
    assert (project / ".sfly" / ".gitignore").read_text() == "*\n"


FETCH_NODE = """
from sfly import Context, node


@node
def fetch(ctx: Context, ref: str) -> dict:
    return {"text": ctx.artifacts.download(ref, "got.txt").read_text(encoding="utf-8")}
"""


def test_download_option_serves_a_local_file_for_an_artifact_ref(
    project: Path, tmp_path: Path
) -> None:
    (project / "src" / "sfly_stub" / "fetching.py").write_text(FETCH_NODE, encoding="utf-8")
    ref = "http://cp.invalid/tasks/t-1/artifacts/a=b.txt"
    (tmp_path / "完整输出.txt").write_text("来自上游节点", encoding="utf-8")

    run = sfly_run(
        project, "fetch", "--params", json.dumps({"ref": ref}), "--download", ref, "../完整输出.txt"
    )

    assert run.returncode == 0, run.stderr
    assert outputs_of(run.stdout) == {"text": "来自上游节点"}


def test_download_option_with_a_missing_file_exits_2_without_running_the_node(
    project: Path,
) -> None:
    run = sfly_run(project, "echo", "--params", '{"text": 1}', "--download", "ref", "nope.bin")

    assert run.returncode == 2, run.stderr
    assert "--download" in run.stderr and "nope.bin" in run.stderr
    assert not (project / ".sfly" / "runs").exists()


def test_background_processes_go_under_the_project_procs_dir_named_after_the_run(
    project: Path,
) -> None:
    run = sfly_run(project, "task_info")

    assert run.returncode == 0, run.stderr
    (run_dir,) = (project / ".sfly" / "runs").iterdir()
    assert outputs_of(run.stdout) == {
        "run_id": run_dir.name,
        "node_id": "task_info",
        "task_id": "local",
        "attempt": 1,
        "procs_dir": str(project / ".sfly" / "procs" / run_dir.name),
    }


def test_node_failure_exits_1_with_the_error_and_traceback(project: Path) -> None:
    run = sfly_run(project, "fail", "--params", '{"message": "磁盘满了"}')

    assert run.returncode == 1
    assert "节点失败：RuntimeError: 磁盘满了" in run.stderr
    assert "Traceback" in run.stderr
    assert "输出：" not in run.stdout


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (
            ["sleep", "--params", '{"seconds": "很久"}'],
            '参数不合法：输入 seconds 应为 number，实际是 "很久"',
        ),
        (["sleep"], "参数不合法：缺少必填输入 seconds"),
        (["sleep", "--params", "{bad"], "参数不合法：--params 不是合法的 JSON"),
        (["sleep", "--params", "[1]"], "参数不合法：--params 必须是 JSON 对象"),
        (["no_such_node"], "找不到节点 no_such_node"),
    ],
)
def test_invalid_params_exit_2_without_running_the_node(
    project: Path, args: list[str], message: str
) -> None:
    run = sfly_run(project, *args)

    assert run.returncode == 2, run.stderr
    assert message in run.stderr
    assert not (project / ".sfly" / "runs").exists() or not any(
        (project / ".sfly" / "runs").iterdir()
    )


def test_ctrl_c_cancels_like_the_platform(project: Path, tmp_path: Path) -> None:
    ready, report = tmp_path / "ready", tmp_path / "report"
    params = json.dumps({"ready_file": str(ready), "report_file": str(report)})
    proc = subprocess.Popen(
        [SFLY, "run", "wait_cancel", "--params", params],
        cwd=project,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    deadline = time.monotonic() + 30
    while not ready.exists():
        assert proc.poll() is None, proc.communicate()
        assert time.monotonic() < deadline, "节点没有启动"
        time.sleep(0.05)

    proc.send_signal(signal.SIGINT)
    _, stderr = proc.communicate(timeout=30)

    assert proc.returncode == 130, stderr
    assert "已取消：任务已取消，已终止进程树" in stderr
    # 节点里抛出 Cancelled，finally 里的清理执行了，并且看到了取消标记。
    assert report.read_text() == "cancelled"


def test_ctrl_c_while_printing_logs_still_cancels(project: Path) -> None:
    """Ctrl-C 恰好打断往标准错误打印日志时（#109）：仍以 130 结束，并打印取消提示。

    先读到几行日志，然后停止读取标准错误：管道写满后 `sfly run` 阻塞在打印日志的 write 里，
    此时发出的 SIGINT 必然在打印中途到达。
    """
    params = json.dumps({"lines": 1_000_000, "interval": 0.0001})
    proc = subprocess.Popen(
        [SFLY, "run", "flood", "--params", params],
        cwd=project,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert proc.stderr is not None
    for _ in range(5):
        assert proc.stderr.readline(), "没有日志输出"
    time.sleep(1)  # 每秒上万行日志，远超管道容量（64 KiB）

    proc.send_signal(signal.SIGINT)
    _, rest = proc.communicate(timeout=60)
    stderr = rest.decode("utf-8", errors="replace")

    assert proc.returncode == 130, stderr[-4000:]
    assert "reentrant call" not in stderr
    assert "正在取消（再按一次 Ctrl-C 立即杀掉）……" in stderr
    assert "已取消：任务已取消，已终止进程树" in stderr


def python_errors(stderr: str) -> list[str]:
    """`sfly run` 自己的 Python 堆栈（节点的日志行带时间前缀，不算）。"""
    starts = ("Traceback", "KeyboardInterrupt", "Exception ignored")
    return [line for line in stderr.splitlines() if line.startswith(starts)]


def interrupt_while_printing(proc: subprocess.Popen[bytes]) -> tuple[bytes, str]:
    """等 `sfly run` 开始往标准输出打印结果，在打印中途发 SIGINT，返回完整的标准输出和标准错误。

    标准输出只在节点结束后打印结果时写入，所以读到第一个字节就说明已经在打印结果；结果远超管道容量
    （64 KiB）而测试暂不读取，`sfly run` 必然阻塞在打印里，此时发出的 SIGINT 必然在打印中途到达。
    """
    assert proc.stdout is not None
    first = os.read(proc.stdout.fileno(), 1)
    assert first, proc.communicate()
    proc.send_signal(signal.SIGINT)
    rest, stderr = proc.communicate(timeout=60)
    return first + rest, stderr.decode("utf-8", errors="replace")


def test_ctrl_c_while_printing_a_cancelled_result_is_ignored(project: Path, tmp_path: Path) -> None:
    """取消后、打印结果期间再按 Ctrl-C（#122）：没有 Python 堆栈，结果打印完整，仍以 130 退出。"""
    ready, report = tmp_path / "ready", tmp_path / "report"
    params = json.dumps({"ready_file": str(ready), "report_file": str(report), "artifacts": 3000})
    proc = subprocess.Popen(
        [SFLY, "run", "wait_cancel", "--params", params],
        cwd=project,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    deadline = time.monotonic() + 30
    while not ready.exists():
        assert proc.poll() is None, proc.communicate()
        assert time.monotonic() < deadline, "节点没有启动"
        time.sleep(0.05)
    proc.send_signal(signal.SIGINT)

    stdout, stderr = interrupt_while_printing(proc)

    assert proc.returncode == 130, stderr
    assert not python_errors(stderr), stderr
    assert "强制杀掉" not in stderr
    assert "已取消：任务已取消，已终止进程树" in stderr
    assert "产物（3000 个" in stdout.decode() and f"02999-{'x' * 100}.txt" in stdout.decode()


def test_ctrl_c_while_printing_a_successful_result_is_ignored(project: Path) -> None:
    """成功结束后、打印结果期间按 Ctrl-C：结果已经确定，忽略它——没有堆栈，输出完整，以 0 退出。"""
    proc = subprocess.Popen(
        [SFLY, "run", "big", "--params", '{"size": 300000}'],
        cwd=project,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    stdout, stderr = interrupt_while_printing(proc)

    assert proc.returncode == 0, stderr
    assert not python_errors(stderr), stderr
    assert outputs_of(stdout.decode()) == {"text": "x" * 300000}
