"""切入点 B（SDK 一侧）：直接按本地协议运行执行器 `python -m sfly.runner`。

本地协议（docs/ARCHITECTURE.md §5.4）：Agent 写好 task.json，通过环境变量
SFLY_TASK / SFLY_OUTPUT / SFLY_ARTIFACTS / SFLY_EVENTS / SFLY_CANCEL 启动执行器；
执行器调用节点后把结果写到 SFLY_OUTPUT。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

SDK_SRC = Path(__file__).resolve().parents[1] / "src"


@dataclass
class Execution:
    returncode: int
    output: dict[str, Any] | None
    stderr: str


@pytest.fixture
def code_dir(tmp_path: Path) -> Path:
    path = tmp_path / "code"
    path.mkdir()
    return path


def write_module(code_dir: Path, name: str, source: str) -> None:
    (code_dir / f"{name}.py").write_text(textwrap.dedent(source), encoding="utf-8")


def execute(
    tmp_path: Path,
    code_dir: Path,
    entry: str,
    inputs: dict[str, Any] | None = None,
    env: dict[str, str] | None = None,
    task_fields: dict[str, Any] | None = None,
) -> Execution:
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    task = work / "task.json"
    spec = {"task_id": "t-1", "attempt": 1, "entry": entry, "inputs": inputs or {}}
    task.write_text(json.dumps({**spec, **(task_fields or {})}), encoding="utf-8")
    output = work / "output.json"
    env = {
        **{k: v for k, v in os.environ.items() if not k.startswith("SFLY_")},
        **(env or {}),
        "PYTHONPATH": os.pathsep.join([str(SDK_SRC), str(code_dir)]),
        "SFLY_TASK": str(task),
        "SFLY_OUTPUT": str(output),
        "SFLY_ARTIFACTS": str(work / "artifacts"),
        "SFLY_EVENTS": str(work / "events.jsonl"),
        "SFLY_CANCEL": str(work / "cancel"),
    }
    result = subprocess.run(
        [sys.executable, "-m", "sfly.runner"],
        cwd=work,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    parsed = json.loads(output.read_text(encoding="utf-8")) if output.exists() else None
    return Execution(result.returncode, parsed, result.stderr)


def test_calls_node_with_inputs_and_writes_return_value(tmp_path: Path, code_dir: Path) -> None:
    write_module(
        code_dir,
        "demo",
        """
        from sfly import Context, node

        @node(outputs=["text"])
        def echo(ctx: Context, text: str, times: int = 1) -> dict:
            assert isinstance(ctx, Context)
            return {"text": text * times}
        """,
    )

    run = execute(tmp_path, code_dir, "demo:echo", {"text": "ab", "times": 2})

    assert run.returncode == 0, run.stderr
    assert run.output == {"status": "success", "outputs": {"text": "abab"}}


def test_node_without_context_and_returning_none_outputs_empty_object(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "plain",
        """
        def noop(value: int = 0) -> None:
            assert value == 3
        """,
    )

    run = execute(tmp_path, code_dir, "plain:noop", {"value": 3})

    assert run.returncode == 0, run.stderr
    assert run.output == {"status": "success", "outputs": {}}


def test_exception_in_node_becomes_failure_with_message_and_traceback(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "boom",
        """
        def explode(reason: str) -> dict:
            raise ValueError(f"坏了：{reason}")
        """,
    )

    run = execute(tmp_path, code_dir, "boom:explode", {"reason": "磁盘满"})

    assert run.returncode == 1
    assert run.output is not None
    assert run.output["status"] == "failed"
    error = run.output["error"]
    assert error["type"] == "ValueError"
    assert error["message"] == "ValueError: 坏了：磁盘满"
    assert 'raise ValueError(f"坏了：{reason}")' in error["traceback"]
    assert "ValueError: 坏了：磁盘满" in run.stderr


@pytest.mark.parametrize(
    ("source", "message"),
    [
        ("def f() -> list:\n    return [1]\n", "节点返回值必须是 JSON 对象（dict），实际为 list"),
        ("def f() -> dict:\n    return {'x': object()}\n", "节点返回值不能序列化为 JSON"),
        ("def f() -> dict:\n    return {'x': 'a' * (1024 * 1024)}\n", "节点返回值超过 1 MB 上限"),
    ],
)
def test_invalid_return_value_is_a_failure(
    tmp_path: Path, code_dir: Path, source: str, message: str
) -> None:
    write_module(code_dir, "bad", source)

    run = execute(tmp_path, code_dir, "bad:f")

    assert run.returncode == 1
    assert run.output is not None
    assert run.output["status"] == "failed"
    assert message in run.output["error"]["message"]


def test_missing_entry_is_a_failure(tmp_path: Path, code_dir: Path) -> None:
    run = execute(tmp_path, code_dir, "no_such_module:f")

    assert run.returncode == 1
    assert run.output is not None
    assert run.output["error"]["type"] == "ModuleNotFoundError"


#: 执行器启动路径上推迟导入的标准库模块（#76）：每个任务一个进程，它们只在构造 Context、保存产物、
#: 节点失败时才用到。这个测试防止以后又在 sfly 或 sfly.runner 的模块顶层导入它们。
DEFERRED_MODULES = {"pathlib", "shutil", "threading", "traceback", "urllib.parse"}


def test_startup_path_does_not_import_deferred_modules(tmp_path: Path, code_dir: Path) -> None:
    # 节点模块被导入时记下已经导入的模块：这就是执行器从解释器启动到开始导入节点模块之间导入的。
    write_module(
        code_dir,
        "probe",
        """
        import sys

        LOADED = sorted(sys.modules)

        def loaded() -> dict:
            return {"modules": LOADED}
        """,
    )
    # 解释器自己启动时（site 等）就导入的不算：不同的 Python 和 venv 可能不一样。
    baseline = subprocess.run(
        [sys.executable, "-c", "import sys, json; print(json.dumps(sorted(sys.modules)))"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout

    run = execute(tmp_path, code_dir, "probe:loaded")

    assert run.returncode == 0, run.stderr
    assert run.output is not None
    loaded = set(run.output["outputs"]["modules"]) - set(json.loads(baseline))
    assert "sfly.context" in loaded
    assert loaded & DEFERRED_MODULES == set()


# ---- ctx.log / ctx.progress：按本地协议追加写入事件文件 SFLY_EVENTS ----
#
# 事件文件是 JSONL，每行一个事件：
# - 日志 {"type": "log", "ts": <毫秒时间戳>, "level": "debug|info|warn|error", "message": "..."}
# - 进度 {"type": "progress", "ts": ..., "current": 1, "total": 3, "message": "..."}
#   （total 可以是 null）
# - 指标 {"type": "metric", "ts": ..., "name": "tps", "kind": "gauge|counter", "value": 1.5}


def events_of(tmp_path: Path) -> list[dict[str, Any]]:
    path = tmp_path / "work" / "events.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_ctx_log_writes_leveled_log_events(tmp_path: Path, code_dir: Path) -> None:
    write_module(
        code_dir,
        "logs",
        """
        from sfly import Context

        def work(ctx: Context, url: str) -> dict:
            ctx.log.debug("准备")
            ctx.log.info("checking %s", url)
            ctx.log.warning("慢：%d ms", 1500)
            ctx.log.error("失败\\n第二行")
            ctx.log("默认级别")
            ctx.log("显式级别", level="warn")
            return {}
        """,
    )
    before = int(time.time() * 1000)

    run = execute(tmp_path, code_dir, "logs:work", {"url": "http://x"})

    assert run.returncode == 0, run.stderr
    events = events_of(tmp_path)
    assert [(e["type"], e["level"], e["message"]) for e in events] == [
        ("log", "debug", "准备"),
        ("log", "info", "checking http://x"),
        ("log", "warn", "慢：1500 ms"),
        ("log", "error", "失败\n第二行"),
        ("log", "info", "默认级别"),
        ("log", "warn", "显式级别"),
    ]
    after = int(time.time() * 1000)
    assert all(before <= e["ts"] <= after for e in events)


def test_ctx_log_exception_includes_traceback(tmp_path: Path, code_dir: Path) -> None:
    write_module(
        code_dir,
        "exc",
        """
        from sfly import Context

        def work(ctx: Context) -> dict:
            try:
                raise KeyError("k")
            except KeyError:
                ctx.log.exception("处理失败")
            return {}
        """,
    )

    run = execute(tmp_path, code_dir, "exc:work")

    assert run.returncode == 0, run.stderr
    [event] = events_of(tmp_path)
    assert event["level"] == "error"
    assert event["message"].startswith("处理失败\nTraceback")
    assert "KeyError: 'k'" in event["message"]


def test_ctx_progress_writes_progress_events(tmp_path: Path, code_dir: Path) -> None:
    write_module(
        code_dir,
        "prog",
        """
        from sfly import Context

        def work(ctx: Context) -> dict:
            ctx.progress(1, 3, "建立连接")
            ctx.progress(2.5, 3)
            ctx.progress(7)
            return {}
        """,
    )

    run = execute(tmp_path, code_dir, "prog:work")

    assert run.returncode == 0, run.stderr
    assert [(e["type"], e["current"], e["total"], e["message"]) for e in events_of(tmp_path)] == [
        ("progress", 1, 3, "建立连接"),
        ("progress", 2.5, 3, ""),
        ("progress", 7, None, ""),
    ]


def test_ctx_metric_writes_declared_metrics_and_drops_the_rest_with_a_warning(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "bench",
        """
        from sfly import Context, Metric, node

        @node(metrics=[Metric("tps", "req/s"), Metric("requests", kind="counter")])
        def work(ctx: Context) -> dict:
            ctx.metric("tps", 12.5)
            ctx.metric("requests", 3)
            ctx.metric("tsp", 1)
            ctx.metric("tsp", 2)
            ctx.metric("tps", float("nan"))
            ctx.metric("tps", float("inf"))
            ctx.metric("tps", 13)
            return {}
        """,
    )

    run = execute(tmp_path, code_dir, "bench:work")

    assert run.returncode == 0, run.stderr
    events = events_of(tmp_path)
    assert [(e["name"], e["kind"], e["value"]) for e in events if e["type"] == "metric"] == [
        ("tps", "gauge", 12.5),
        ("requests", "counter", 3),
        ("tps", "gauge", 13),
    ]
    assert all(isinstance(e["ts"], int) for e in events)
    # 每个指标名、每种原因只警告一次，避免刷屏。
    warnings = [e["message"] for e in events if e["type"] == "log"]
    assert all(e["level"] == "warn" for e in events if e["type"] == "log")
    assert len(warnings) == 2
    assert "tsp" in warnings[0] and "未声明" in warnings[0]
    assert "tps" in warnings[1] and "有限" in warnings[1]


def test_events_from_threads_are_whole_lines(tmp_path: Path, code_dir: Path) -> None:
    write_module(
        code_dir,
        "threads",
        """
        import threading
        from sfly import Context

        def work(ctx: Context) -> dict:
            def spam(n):
                for i in range(200):
                    ctx.log.info("线程 %d 第 %d 条 " + "x" * 500, n, i)
            threads = [threading.Thread(target=spam, args=(n,)) for n in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            return {}
        """,
    )

    run = execute(tmp_path, code_dir, "threads:work")

    assert run.returncode == 0, run.stderr
    assert len(events_of(tmp_path)) == 800


def test_context_without_events_file_does_not_fail(tmp_path: Path) -> None:
    from sfly import Context

    ctx = Context(events_path=None)
    ctx.log.info("丢弃")
    ctx.progress(1, 2)


def test_ctx_cancelled_reflects_the_cancel_marker(tmp_path: Path) -> None:
    from sfly import Context

    marker = tmp_path / "cancel"
    ctx = Context(events_path=None, cancel_path=marker)
    assert ctx.cancelled() is False
    marker.write_text("")
    assert ctx.cancelled() is True
    assert Context(events_path=None, cancel_path=None).cancelled() is False


def test_sigterm_raises_cancelled_in_the_node_so_cleanup_runs(
    tmp_path: Path, code_dir: Path
) -> None:
    """Agent 取消任务时先写取消标记再发 SIGTERM。

    节点里抛出 sfly.Cancelled，finally 能看到 ctx.cancelled()。
    """
    ready = tmp_path / "ready"
    report = tmp_path / "report"
    write_module(
        code_dir,
        "slow",
        f"""
        import time
        from sfly import Context

        def wait(ctx: Context) -> None:
            open({str(ready)!r}, "w").close()
            try:
                time.sleep(60)
            except Exception:
                # Cancelled 不是 Exception 的子类，不会被宽泛的 except 吞掉。
                open({str(report)!r}, "w").write("swallowed ")
                raise
            finally:
                with open({str(report)!r}, "a") as f:
                    f.write(f"cancelled={{ctx.cancelled()}}")
        """,
    )
    work = tmp_path / "work"
    work.mkdir()
    (work / "task.json").write_text(json.dumps({"entry": "slow:wait", "inputs": {}}))
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join([str(SDK_SRC), str(code_dir)]),
        "SFLY_TASK": str(work / "task.json"),
        "SFLY_OUTPUT": str(work / "output.json"),
        "SFLY_EVENTS": str(work / "events.jsonl"),
        "SFLY_CANCEL": str(work / "cancel"),
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "sfly.runner"], cwd=work, env=env, stderr=subprocess.PIPE
    )
    deadline = time.monotonic() + 30
    while not ready.exists():
        assert time.monotonic() < deadline, "node never started"
        time.sleep(0.02)
    (work / "cancel").write_text("")
    proc.terminate()
    _, stderr = proc.communicate(timeout=10)

    assert report.read_text() == "cancelled=True", stderr
    assert proc.returncode == 1
    output = json.loads((work / "output.json").read_text())
    assert output["status"] == "failed"
    assert output["error"]["type"] == "Cancelled"


# ---- ctx.artifacts：保存到产物目录 SFLY_ARTIFACTS，返回产物引用（下载地址） ----
#
# Agent 通过 SFLY_ARTIFACTS_URL 告诉执行器产物的下载地址前缀；save 返回的引用就是
# 前缀 + 按路径段百分号编码的名称，节点把它写进输出，后续节点或界面据此下载。


def test_ctx_artifacts_save_writes_files_and_returns_download_urls(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "arts",
        """
        from pathlib import Path
        from sfly import Context

        def work(ctx: Context) -> dict:
            report = ctx.artifacts.save("report.json", '{"ok": true}')
            shot = ctx.artifacts.save("截图/第 1 张.png", b"\\x89PNG\\x00")
            src = Path("local.txt")
            src.write_text("copied", encoding="utf-8")
            copied = ctx.artifacts.save("logs/copy.txt", src)
            direct = ctx.artifacts.path("direct/out.csv")
            direct.write_text("a,b\\n", encoding="utf-8")
            return {
                "report": report,
                "shot": shot,
                "copied": copied,
                "direct": ctx.artifacts.ref("direct/out.csv"),
            }
        """,
    )

    run = execute(
        tmp_path,
        code_dir,
        "arts:work",
        env={"SFLY_ARTIFACTS_URL": "http://cp:8080/tasks/t-1/artifacts/"},
    )

    assert run.returncode == 0, run.stderr
    assert run.output is not None
    assert run.output["outputs"] == {
        "report": "http://cp:8080/tasks/t-1/artifacts/report.json",
        "shot": "http://cp:8080/tasks/t-1/artifacts/%E6%88%AA%E5%9B%BE/%E7%AC%AC%201%20%E5%BC%A0.png",
        "copied": "http://cp:8080/tasks/t-1/artifacts/logs/copy.txt",
        "direct": "http://cp:8080/tasks/t-1/artifacts/direct/out.csv",
    }
    artifacts = tmp_path / "work" / "artifacts"
    assert (artifacts / "report.json").read_text(encoding="utf-8") == '{"ok": true}'
    assert (artifacts / "截图" / "第 1 张.png").read_bytes() == b"\x89PNG\x00"
    assert (artifacts / "logs" / "copy.txt").read_text(encoding="utf-8") == "copied"
    assert (artifacts / "direct" / "out.csv").read_text(encoding="utf-8") == "a,b\n"


def test_ctx_artifacts_without_url_returns_local_paths(tmp_path: Path, code_dir: Path) -> None:
    write_module(
        code_dir,
        "local",
        """
        from sfly import Context

        def work(ctx: Context) -> dict:
            return {"path": ctx.artifacts.save("a.txt", "x")}
        """,
    )

    run = execute(tmp_path, code_dir, "local:work")

    assert run.returncode == 0, run.stderr
    assert run.output is not None
    assert run.output["outputs"]["path"] == str(tmp_path / "work" / "artifacts" / "a.txt")


@pytest.mark.parametrize("name", ["", "../x", "a/../b", "/abs", "a//b", "a\\b", ".", "a/./b"])
def test_ctx_artifacts_rejects_names_outside_the_artifacts_dir(tmp_path: Path, name: str) -> None:
    from sfly import Context

    ctx = Context(events_path=None, artifacts_dir=tmp_path / "artifacts")
    with pytest.raises(ValueError, match="产物名称"):
        ctx.artifacts.save(name, "x")
    assert not (tmp_path / "x").exists()


TASK_INFO_NODE = """
from sfly import Context

def info(ctx: Context) -> dict:
    t = ctx.task
    return {
        "task": [t.run_id, t.node_id, t.task_id, t.attempt],
        "procs_dir": str(ctx.procs_dir),
    }
"""

#: Agent 写的 task.json 里的任务信息（agent/src/executor.rs）。
AGENT_TASK = {"task_id": "task-9", "attempt": 2, "run_id": "run-7", "node_id": "start-db"}


def test_ctx_task_and_procs_dir_come_from_the_agent(tmp_path: Path, code_dir: Path) -> None:
    write_module(code_dir, "info", TASK_INFO_NODE)
    procs = tmp_path / "home" / "procs" / "run-7"

    run = execute(
        tmp_path, code_dir, "info:info", env={"SFLY_PROCS": str(procs)}, task_fields=AGENT_TASK
    )

    assert run.returncode == 0, run.stderr
    assert run.output is not None
    assert run.output["outputs"] == {
        "task": ["run-7", "start-db", "task-9", 2],
        "procs_dir": str(procs),
    }


def test_without_sfly_procs_from_an_older_agent_procs_dir_is_under_sfly_home(
    tmp_path: Path, code_dir: Path
) -> None:
    # 低于 0.0.4 的 Agent 不设置 SFLY_PROCS：取 Agent 默认布局下的位置（不会被旧 Agent 清理）。
    write_module(code_dir, "info", TASK_INFO_NODE)
    home = tmp_path / "home"

    run = execute(
        tmp_path, code_dir, "info:info", env={"SFLY_HOME": str(home)}, task_fields=AGENT_TASK
    )

    assert run.returncode == 0, run.stderr
    assert run.output is not None
    assert run.output["outputs"]["procs_dir"] == str(home / "procs" / "run-7")


def test_context_outside_an_executor_has_local_task_info(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sfly import Context, TaskInfo

    monkeypatch.delenv("SFLY_TASK", raising=False)
    monkeypatch.delenv("SFLY_PROCS", raising=False)
    monkeypatch.setenv("SFLY_HOME", str(tmp_path))

    ctx = Context(events_path=None)

    assert ctx.task == TaskInfo(run_id="local", node_id="local", task_id="local", attempt=1)
    assert ctx.procs_dir == tmp_path / "procs" / "local"
