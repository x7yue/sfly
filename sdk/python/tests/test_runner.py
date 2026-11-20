"""切入点 B（SDK 一侧）：直接按本地协议运行执行器 `python -m sfly.runner`。

本地协议（docs/ARCHITECTURE.md §5.4）：Agent 写好 task.json，通过环境变量
SFLY_TASK / SFLY_OUTPUT / SFLY_ARTIFACTS / SFLY_EVENTS / SFLY_CANCEL 启动执行器；
执行器调用节点后把结果写到 SFLY_OUTPUT。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import sysconfig
import textwrap
import time
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from sfly import Cancelled, runner

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
    env: dict[str, str | None] | None = None,
    task_fields: dict[str, Any] | None = None,
) -> Execution:
    """`env` 里的变量覆盖默认的；值为 None 的变量不设置。"""
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    task = work / "task.json"
    spec = {"task_id": "t-1", "attempt": 1, "entry": entry, "inputs": inputs or {}}
    task.write_text(json.dumps({**spec, **(task_fields or {})}), encoding="utf-8")
    output = work / "output.json"
    merged: dict[str, str | None] = {
        **{k: v for k, v in os.environ.items() if not k.startswith("SFLY_")},
        "PYTHONPATH": os.pathsep.join([str(SDK_SRC), str(code_dir)]),
        "SFLY_TASK": str(task),
        "SFLY_OUTPUT": str(output),
        "SFLY_ARTIFACTS": str(work / "artifacts"),
        "SFLY_EVENTS": str(work / "events.jsonl"),
        "SFLY_CANCEL": str(work / "cancel"),
        **(env or {}),
    }
    result = subprocess.run(
        [sys.executable, "-m", "sfly.runner"],
        cwd=work,
        env={k: v for k, v in merged.items() if v is not None},
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


NON_FINITE_OUTPUTS = [
    ("ratio_is_nan", "输出 ratio 的值是 NaN"),
    ("nested_infinity", '输出 stats["items"][2] 的值是 Infinity'),
    ("several", '输出里有 3 处 NaN 或无穷：a（NaN）、b[0]（-Infinity）、c["d"]（NaN）'),
]


@pytest.mark.parametrize(("node_name", "where"), NON_FINITE_OUTPUTS)
def test_a_return_value_with_nan_or_infinity_fails_and_says_which_output_and_what_to_do(
    tmp_path: Path, code_dir: Path, node_name: str, where: str
) -> None:
    """JSON 里没有 NaN 和无穷（#481）：任务失败，错误信息写明是哪个输出、怎么办，
    而不是写出一份 Agent 读不了的 output.json，让任务以「执行器异常退出」失败。"""
    shutil.copy(Path(__file__).with_name("number_nodes.py"), code_dir)

    run = execute(tmp_path, code_dir, f"number_nodes:{node_name}")

    assert run.returncode == 1
    assert run.output is not None
    assert run.output["status"] == "failed"
    message = run.output["error"]["message"]
    assert message.startswith("NodeOutputError: 节点返回值不能序列化为 JSON：")
    assert where in message
    assert "换成 None" in message
    assert "字符串" in message


def test_other_unserializable_values_keep_the_standard_message(
    tmp_path: Path, code_dir: Path
) -> None:
    shutil.copy(Path(__file__).with_name("number_nodes.py"), code_dir)

    run = execute(tmp_path, code_dir, "number_nodes:not_serializable")

    assert run.output is not None
    assert run.output["error"]["message"] == (
        "NodeOutputError: 节点返回值不能序列化为 JSON："
        "Object of type object is not JSON serializable"
    )


def test_ctx_progress_drops_non_finite_numbers_with_one_warning(
    tmp_path: Path, code_dir: Path
) -> None:
    """NaN 和无穷写进事件管道是非法的 JSON，Agent 读不了，只会留下一行看不懂的日志（#481）：
    和 `ctx.metric` 一样，在 SDK 里丢掉，写一条警告日志。"""
    shutil.copy(Path(__file__).with_name("number_nodes.py"), code_dir)

    run = execute(tmp_path, code_dir, "number_nodes:non_finite_progress")

    assert run.returncode == 0, run.stderr
    events = events_of(tmp_path)
    assert [
        (e["type"], e["current"], e["total"], e["message"])
        for e in events
        if e["type"] == "progress"
    ] == [
        ("progress", 2, 10, "正常"),
    ]
    warnings = [e["message"] for e in events if e["type"] == "log" and e["level"] == "warn"]
    assert len(warnings) == 1
    assert "ctx.progress" in warnings[0]
    assert "有限数值" in warnings[0]


def test_missing_entry_is_a_failure(tmp_path: Path, code_dir: Path) -> None:
    run = execute(tmp_path, code_dir, "no_such_module:f")

    assert run.returncode == 1
    assert run.output is not None
    assert run.output["error"]["type"] == "ModuleNotFoundError"


#: 执行器启动路径上推迟导入的标准库模块（#76）：每个任务一个进程，它们只在构造 Context、保存产物、
#: 节点失败时才用到。这个测试防止以后又在 sfly 或 sfly.runner 的模块顶层导入它们。
DEFERRED_MODULES = {
    "pathlib",
    "shutil",
    "threading",
    "traceback",
    # 取被终止时执行到哪要用到标准库的目录，只在节点被终止时才导入。
    "sysconfig",
    "urllib.parse",
    # 下载产物（sfly.download）只在节点调用 ctx.artifacts.download 时才导入。
    "urllib.request",
    "http.client",
    "sfly.download",
    # 动作和标记（sfly.actions）只在节点第一次用到 ctx.action、ctx.mark 时才导入。
    "sfly.actions",
}


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


# ---- 没有声明的输入：调用节点函数之前就失败，记为配置错误 ----
#
# 派发给节点的输入里有节点没有声明的名字（多半是写错了参数名）时，不让它跑进函数里再抛
# `TypeError: f() got an unexpected keyword argument`（那会记成 node_error 并按重试次数重试）：
# 执行器在调用前就以 config_error 失败，信息里写出多出来的名字和节点声明的输入。


def test_inputs_the_node_does_not_declare_fail_as_config_error_before_the_node_runs(
    tmp_path: Path, code_dir: Path
) -> None:
    ran = tmp_path / "ran"
    write_module(
        code_dir,
        "load",
        f"""
        from sfly import Context

        def http_load(
            ctx: Context, url: str, duration: float = 1.0, concurrency: int = 1
        ) -> dict:
            open({str(ran)!r}, "w").close()
            return {{}}
        """,
    )

    run = execute(tmp_path, code_dir, "load:http_load", {"url": "http://x", "duraton": 2})

    assert run.returncode == 1
    assert not ran.exists()
    # 配置错误没有异常类型和堆栈，标准错误里也不写：错误信息就是原因。
    assert run.stderr == ""
    assert run.output == {
        "status": "failed",
        "error": {
            "kind": "config_error",
            "message": (
                "节点 http_load 没有声明输入 duraton，它声明的输入有：url、duration、concurrency"
            ),
        },
    }


def test_every_undeclared_input_is_named_and_the_context_parameter_is_not_an_input(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "two",
        """
        from sfly import Context

        def work(ctx: Context, *, a: int, b: int = 0) -> dict:
            return {}
        """,
    )

    run = execute(tmp_path, code_dir, "two:work", {"a": 1, "x": 1, "ctx": 2, "y": 3})

    assert run.output is not None
    assert run.output["error"] == {
        "kind": "config_error",
        "message": "节点 work 没有声明输入 x、ctx、y，它声明的输入有：a、b",
    }


def test_a_node_without_inputs_says_it_takes_none(tmp_path: Path, code_dir: Path) -> None:
    write_module(
        code_dir,
        "bare",
        """
        def ping() -> dict:
            return {}
        """,
    )

    run = execute(tmp_path, code_dir, "bare:ping", {"x": 1})

    assert run.output is not None
    assert run.output["error"] == {
        "kind": "config_error",
        "message": "节点 ping 没有声明输入 x，它不接收任何输入",
    }


def test_the_node_name_in_the_message_is_the_one_the_node_declares(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "named",
        """
        from sfly import node

        @node(name="http-load", title="压测")
        def run_load(url: str) -> dict:
            return {}
        """,
    )

    run = execute(tmp_path, code_dir, "named:run_load", {"url": "u", "urll": "u"})

    assert run.output is not None
    assert run.output["error"]["message"].startswith("节点 http-load 没有声明输入 urll，")


def test_declared_inputs_missing_optional_ones_and_kwargs_nodes_are_not_affected(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "ok",
        """
        def work(a: int, b: int = 2) -> dict:
            return {"sum": a + b}

        def anything(**kwargs) -> dict:
            return {"names": sorted(kwargs)}
        """,
    )

    declared = execute(tmp_path, code_dir, "ok:work", {"a": 1})
    kwargs = execute(tmp_path, code_dir, "ok:anything", {"x": 1, "y": 2})

    assert declared.output == {"status": "success", "outputs": {"sum": 3}}
    assert kwargs.output == {"status": "success", "outputs": {"names": ["x", "y"]}}


def test_a_type_error_raised_inside_the_node_is_still_a_node_error(
    tmp_path: Path, code_dir: Path
) -> None:
    # 只拦调用之前的「没有声明的输入」：节点自己抛出的 TypeError 是节点出错，堆栈照旧。
    write_module(
        code_dir,
        "typo",
        """
        def work(a: int) -> dict:
            return {"x": a + "1"}
        """,
    )

    run = execute(tmp_path, code_dir, "typo:work", {"a": 1})

    assert run.output is not None
    assert run.output["error"]["type"] == "TypeError"
    assert "kind" not in run.output["error"]
    assert "Traceback" in run.stderr


# ---- 被终止（取消、超时、被停止子流程节点停止）不写堆栈 ----
#
# 这三种情况 Agent 都是写取消标记再发 SIGTERM，执行器看到的都是节点里抛出的 `Cancelled`：
# 它是正常终止，不是节点出错，日志里不写 ERROR 级的堆栈，只留一行 INFO 的「执行到哪」：
# 被终止已经由任务状态表达，不是需要处理的问题，所以不是 WARN。


def terminate(tmp_path: Path, code_dir: Path, entry: str, ready: Path) -> Execution:
    """启动执行器，等节点写出 `ready` 后像 Agent 那样先写取消标记再发 SIGTERM，等它退出。"""
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    (work / "task.json").write_text(json.dumps({"entry": entry, "inputs": {}}))
    env = {
        **{k: v for k, v in os.environ.items() if not k.startswith("SFLY_")},
        "PYTHONPATH": os.pathsep.join([str(SDK_SRC), str(code_dir)]),
        "SFLY_TASK": str(work / "task.json"),
        "SFLY_OUTPUT": str(work / "output.json"),
        "SFLY_EVENTS": str(work / "events.jsonl"),
        "SFLY_CANCEL": str(work / "cancel"),
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "sfly.runner"],
        cwd=work,
        env=env,
        stderr=subprocess.PIPE,
        text=True,
    )
    deadline = time.monotonic() + 30
    while not ready.exists():
        assert time.monotonic() < deadline, "node never started"
        time.sleep(0.02)
    (work / "cancel").write_text("")
    proc.terminate()
    _, stderr = proc.communicate(timeout=10)
    output = work / "output.json"
    parsed = json.loads(output.read_text(encoding="utf-8")) if output.exists() else None
    return Execution(proc.returncode, parsed, stderr)


def test_a_terminated_node_writes_one_info_line_saying_where_instead_of_a_traceback(
    tmp_path: Path, code_dir: Path
) -> None:
    ready = tmp_path / "ready"
    write_module(
        code_dir,
        "monitor",
        f"""
        import time
        from sfly import Context

        def watch(ctx: Context) -> None:
            open({str(ready)!r}, "w").close()
            time.sleep(60)  # 被终止时停在这一行
        """,
    )
    sleep_line = (code_dir / "monitor.py").read_text().splitlines().index(
        "    time.sleep(60)  # 被终止时停在这一行"
    ) + 1

    run = terminate(tmp_path, code_dir, "monitor:watch", ready)

    # 标准错误来源的日志是 ERROR 级：不写任何东西，更不写堆栈；事件管道里只有一行 INFO，不是 WARN。
    assert run.stderr == ""
    assert run.returncode == 1
    [event] = events_of(tmp_path)
    assert (event["type"], event["level"]) == ("log", "info")
    assert event["message"] == f"任务被终止（SIGTERM），执行到 monitor.watch 第 {sleep_line} 行"
    assert "\n" not in event["message"]
    # 结果文件不变：读取端按取消、超时处理时不看它，节点自己被别的方式终止时它仍然说明原因。
    assert run.output is not None
    assert run.output["status"] == "failed"
    assert run.output["error"]["type"] == "Cancelled"


def test_the_place_a_terminated_node_stopped_at_is_the_node_code_not_the_sdk(
    tmp_path: Path, code_dir: Path
) -> None:
    # 停在 SDK 里（这里是 ctx.agent 的等待、下载产物之类的调用）时，报的是调用它的节点代码那一行。
    ready = tmp_path / "ready"
    write_module(
        code_dir,
        "helper",
        f"""
        import time

        def nap() -> None:
            open({str(ready)!r}, "w").close()
            time.sleep(60)
        """,
    )
    write_module(
        code_dir,
        "outer",
        """
        import helper

        def run() -> None:
            helper.nap()
        """,
    )

    terminate(tmp_path, code_dir, "outer:run", ready)

    [event] = events_of(tmp_path)
    assert event["level"] == "info"
    assert event["message"].startswith("任务被终止（SIGTERM），执行到 helper.nap 第 ")


def test_a_cancelled_raised_by_the_node_itself_is_also_quiet(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "giveup",
        """
        from sfly import Cancelled

        def stop() -> None:
            raise Cancelled("下载被取消")
        """,
    )

    run = execute(tmp_path, code_dir, "giveup:stop")

    assert run.returncode == 1
    assert run.stderr == ""
    [event] = events_of(tmp_path)
    assert (event["level"], event["message"]) == ("info", "下载被取消，执行到 giveup.stop 第 5 行")


def test_cleanup_after_cancelled_and_the_nodes_own_logs_are_not_affected(
    tmp_path: Path, code_dir: Path
) -> None:
    ready = tmp_path / "ready"
    write_module(
        code_dir,
        "tidy",
        f"""
        import time
        from sfly import Cancelled, Context

        def watch(ctx: Context) -> dict:
            open({str(ready)!r}, "w").close()
            try:
                time.sleep(60)
            except Cancelled:
                ctx.log.info("收尾：关闭文件")
                ctx.log.error("节点自己写的错误")
                return {{"cleaned": True}}
            return {{}}
        """,
    )

    run = terminate(tmp_path, code_dir, "tidy:watch", ready)

    # 节点自己接住了 Cancelled，正常收尾返回：成功，日志原样，执行器不再多写什么。
    assert run.returncode == 0, run.stderr
    assert run.output == {"status": "success", "outputs": {"cleaned": True}}
    assert [(e["level"], e["message"]) for e in events_of(tmp_path)] == [
        ("info", "收尾：关闭文件"),
        ("error", "节点自己写的错误"),
    ]


#: 节点里被打断的那一行的标记：期望的行号从源码里按它找，不写死。
STOPPED_HERE = "# 停在这一行"


def marked_line(code_dir: Path, module: str) -> int:
    lines = (code_dir / f"{module}.py").read_text(encoding="utf-8").splitlines()
    return next(i for i, line in enumerate(lines, 1) if STOPPED_HERE in line)


#: 节点停在标准库里的各种等待：每个写法都在同一行先写出 ready 文件再开始等待，被打断时无论
#: 停在这一行的哪个位置，节点代码这一帧报的行号都相同。第二列是节点模块的导入和准备工作。
STDLIB_WAITS = {
    "Event.wait": ("import threading", "threading.Event().wait(60)"),
    "subprocess.run": (
        # 子进程不继承标准输入输出：被终止时恰好落在创建子进程的中途，它没有被杀掉，
        # 仍持有管道的话测试要等到它结束才读得到执行器的退出。
        "import subprocess, sys\n"
        "null = subprocess.DEVNULL\n"
        "QUIET = dict(stdin=null, stdout=null, stderr=null)",
        'subprocess.run([sys.executable, "-c", "import time; time.sleep(10)"], **QUIET)',
    ),
    "Thread.join": (
        "import threading, time\n"
        "t = threading.Thread(target=time.sleep, args=(60,), daemon=True)\n"
        "t.start()",
        "t.join()",
    ),
    "asyncio.run": (
        "import asyncio\n\n"
        "async def main():\n"
        "    # 事件循环在等待时才写出 ready：节点这一帧不在被打断的栈上\n"
        "    loop = asyncio.get_running_loop()\n"
        "    loop.call_later(0.1, lambda: open(READY, 'w').close())\n"
        "    await asyncio.sleep(60)",
        "asyncio.run(main())",
    ),
}


@pytest.mark.parametrize("wait", STDLIB_WAITS, ids=list(STDLIB_WAITS))
def test_stopped_inside_the_standard_library_reports_the_node_line_that_called_it(
    tmp_path: Path, code_dir: Path, wait: str
) -> None:
    ready = tmp_path / "ready"
    setup, statement = STDLIB_WAITS[wait]
    # asyncio 的节点代码在协程里写 ready，其余在等待的同一行写。
    touch = "" if wait == "asyncio.run" else "open(READY, 'w').close(); "
    write_module(
        code_dir,
        "waiter",
        f"READY = {str(ready)!r}\n{setup}\n\n\ndef watch() -> None:\n"
        f"    {touch}{statement}  {STOPPED_HERE}\n",
    )

    run = terminate(tmp_path, code_dir, "waiter:watch", ready)

    [event] = events_of(tmp_path)
    assert event["level"] == "info"
    assert event["message"] == (
        f"任务被终止（SIGTERM），执行到 waiter.watch 第 {marked_line(code_dir, 'waiter')} 行"
    )
    assert run.stderr == ""


def test_stopped_inside_a_third_party_library_reports_the_place_in_the_library(
    tmp_path: Path, code_dir: Path
) -> None:
    # 节点包自己可能装在 site-packages 里：那里的帧不跳过，停在第三方库里时写的是库里的位置。
    # 这里用一个假的「第三方库」放在名为 site-packages 的目录里。
    ready = tmp_path / "ready"
    library = code_dir / "site-packages"
    library.mkdir()
    (library / "thirdparty.py").write_text(
        f"import threading\n\n\ndef wait_for_it() -> None:\n"
        f"    open({str(ready)!r}, 'w').close(); threading.Event().wait(60)  {STOPPED_HERE}\n",
        encoding="utf-8",
    )
    write_module(
        code_dir,
        "usesit",
        """
        import sys
        sys.path.insert(0, __file__.rsplit("/", 1)[0] + "/site-packages")
        import thirdparty

        def watch() -> None:
            thirdparty.wait_for_it()
        """,
    )

    terminate(tmp_path, code_dir, "usesit:watch", ready)

    [event] = events_of(tmp_path)
    line = marked_line(code_dir / "site-packages", "thirdparty")
    assert event["message"] == f"任务被终止（SIGTERM），执行到 thirdparty.wait_for_it 第 {line} 行"


# ---- 「执行到哪」的取法本身：用拼出来的栈直接测，不需要真的被终止 ----


def frame_in(filename: str, function: str = "f") -> types.FrameType:
    """一个代码文件名是 `filename` 的函数的栈帧（函数已经返回，帧对象还在）。"""
    namespace: dict[str, Any] = {"__name__": "fake"}
    exec(  # noqa: S102 - 测试里造一个带指定文件名的帧
        compile(f"import sys\ndef {function}():\n    return sys._getframe()\n", filename, "exec"),
        namespace,
    )
    frame: types.FrameType = namespace[function]()
    return frame


def cancelled_through(*frames: types.FrameType) -> Cancelled:
    """栈是 `frames`（先外层后内层）的 `Cancelled`。"""
    traceback = None
    for frame in reversed(frames):
        traceback = types.TracebackType(traceback, frame, 0, 3)
    return Cancelled("任务被终止（SIGTERM）").with_traceback(traceback)


STDLIB = sysconfig.get_paths()["stdlib"]
NODE_FRAME = "/work/node.py"


def test_sdk_and_standard_library_frames_are_skipped_the_innermost_node_frame_is_reported() -> None:
    sdk = Path(runner.__file__).parent
    error = cancelled_through(
        frame_in(NODE_FRAME, "watch"),
        frame_in(str(sdk / "capabilities" / "base.py"), "call"),
        frame_in(f"{STDLIB}/threading.py", "wait"),
        frame_in("<frozen importlib._bootstrap>", "_find"),
    )

    assert runner._terminated_at(error) == "fake.watch 第 3 行"


def test_a_frame_without_a_file_cannot_be_told_apart_so_it_counts_as_node_code() -> None:
    error = cancelled_through(
        frame_in(NODE_FRAME, "watch"),
        frame_in("<string>", "generated"),
        frame_in(f"{STDLIB}/threading.py", "wait"),
    )

    assert runner._terminated_at(error) == "fake.generated 第 3 行"
    assert runner._terminated_at(cancelled_through(frame_in("", "bare"))) == "fake.bare 第 3 行"


def test_frames_in_site_packages_are_not_the_standard_library_even_when_it_contains_them() -> None:
    # 有的 Python 把 site-packages 放在标准库目录里面：那里的文件不算标准库。
    error = cancelled_through(
        frame_in(NODE_FRAME, "watch"),
        frame_in(f"{STDLIB}/site-packages/requests/api.py", "get"),
        frame_in(f"{STDLIB}/socket.py", "recv"),
    )

    assert runner._terminated_at(error) == "fake.get 第 3 行"


def test_a_path_that_reaches_the_standard_library_through_a_symlink_still_counts(
    tmp_path: Path,
) -> None:
    link = tmp_path / "lib"
    link.symlink_to(STDLIB)
    error = cancelled_through(
        frame_in(NODE_FRAME, "watch"), frame_in(f"{link}/threading.py", "wait")
    )

    assert runner._terminated_at(error) == "fake.watch 第 3 行"


def test_on_a_case_insensitive_file_system_a_differently_cased_path_still_counts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(os.path, "normcase", str.lower)
    error = cancelled_through(
        frame_in(NODE_FRAME, "watch"), frame_in(f"{STDLIB.upper()}/THREADING.PY", "wait")
    )

    assert runner._terminated_at(error) == "fake.watch 第 3 行"


def test_when_every_frame_is_skipped_the_innermost_one_is_reported() -> None:
    error = cancelled_through(
        frame_in(f"{STDLIB}/runpy.py", "run"), frame_in(f"{STDLIB}/threading.py", "wait")
    )

    assert runner._terminated_at(error) == "fake.wait 第 3 行"


def test_without_a_stack_there_is_no_place_and_the_message_only_gives_the_reason() -> None:
    assert runner._terminated_at(Cancelled("x")) is None
    assert runner._termination_message(Cancelled("下载被取消")) == "下载被取消"
    assert runner._termination_message(Cancelled()) == "任务被终止"


def test_failing_to_work_out_the_place_never_raises_on_the_termination_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def broken() -> None:
        raise RuntimeError("sysconfig 坏了")

    monkeypatch.setattr(runner, "_runtime_dirs", broken)
    error = cancelled_through(frame_in(NODE_FRAME, "watch"))

    assert runner._termination_message(error) == "任务被终止（SIGTERM）"


@pytest.mark.parametrize(
    "failure", [OSError("没有这个目录"), RuntimeError("写事件管道时出了别的错")]
)
def test_failing_to_write_the_log_line_does_not_lose_the_result(
    monkeypatch: pytest.MonkeyPatch, code_dir: Path, failure: Exception
) -> None:
    write_module(
        code_dir,
        "giveup",
        """
        from sfly import Cancelled

        def stop() -> None:
            raise Cancelled("取消")
        """,
    )
    monkeypatch.syspath_prepend(str(code_dir))

    def broken() -> None:
        raise failure

    monkeypatch.setattr(runner, "Context", broken)

    code, text = runner.run({"entry": "giveup:stop", "inputs": {}})

    assert code == 1
    assert json.loads(text)["error"]["type"] == "Cancelled"


def test_an_exception_raised_while_cleaning_up_after_cancelled_keeps_its_full_traceback(
    tmp_path: Path, code_dir: Path
) -> None:
    ready = tmp_path / "ready"
    write_module(
        code_dir,
        "broken",
        f"""
        import time
        from sfly import Cancelled

        def watch() -> None:
            open({str(ready)!r}, "w").close()
            try:
                time.sleep(60)
            except Cancelled:
                raise RuntimeError("收尾时出错")
        """,
    )

    run = terminate(tmp_path, code_dir, "broken:watch", ready)

    assert "Traceback (most recent call last)" in run.stderr
    assert "RuntimeError: 收尾时出错" in run.stderr
    assert not (tmp_path / "work" / "events.jsonl").exists()
    assert run.output is not None
    assert run.output["error"]["type"] == "RuntimeError"


def test_without_an_event_pipe_a_terminated_node_still_fails_quietly(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "giveup",
        """
        from sfly import Cancelled

        def stop() -> None:
            raise Cancelled()
        """,
    )

    run = execute(tmp_path, code_dir, "giveup:stop", env={"SFLY_EVENTS": None})

    assert run.returncode == 1
    assert run.stderr == ""
    assert run.output is not None
    assert run.output["error"]["type"] == "Cancelled"


def test_an_ordinary_exception_in_the_node_still_writes_its_full_traceback_to_stderr(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "boom",
        """
        def explode() -> None:
            raise ValueError("坏了")
        """,
    )

    run = execute(tmp_path, code_dir, "boom:explode")

    assert run.stderr.startswith("Traceback (most recent call last):\n")
    assert 'raise ValueError("坏了")' in run.stderr
    assert run.stderr.rstrip().endswith("ValueError: 坏了")
    assert not (tmp_path / "work" / "events.jsonl").exists()


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
