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
    tmp_path: Path, code_dir: Path, entry: str, inputs: dict[str, Any] | None = None
) -> Execution:
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    task = work / "task.json"
    task.write_text(
        json.dumps({"task_id": "t-1", "attempt": 1, "entry": entry, "inputs": inputs or {}}),
        encoding="utf-8",
    )
    output = work / "output.json"
    env = {
        **os.environ,
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


# ---- ctx.log / ctx.progress：按本地协议追加写入事件文件 SFLY_EVENTS ----
#
# 事件文件是 JSONL，每行一个事件：
# - 日志 {"type": "log", "ts": <毫秒时间戳>, "level": "debug|info|warn|error", "message": "..."}
# - 进度 {"type": "progress", "ts": ..., "current": 1, "total": 3, "message": "..."}
#   （total 可以是 null）


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
