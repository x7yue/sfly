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
from polling import wait_for

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


def test_floats_are_read_from_task_json_and_written_to_output_json_as_the_same_double(
    tmp_path: Path, code_dir: Path
) -> None:
    """数值经过执行器保持不变（#450）：输入里的小数读成写出者的那个双精度数，输出写成它的最短表示。
    前几个数用只做近似解析的实现会差最后一位；比较 repr，负零和 0.0 也要区分。"""
    values = [
        29491.727857142858,
        7.038531e-26,
        123456789.12345679,
        60.157000000000004,
        60.157,
        0.1,
        1e-7,
        5e-324,
        1.7976931348623157e308,
        -0.0,
    ]
    write_module(code_dir, "numbers", "def f(xs: list) -> dict:\n    return {'xs': xs}\n")

    run = execute(tmp_path, code_dir, "numbers:f", {"xs": values})

    assert run.returncode == 0, run.stderr
    assert run.output is not None
    assert [repr(x) for x in run.output["outputs"]["xs"]] == [repr(x) for x in values]
    text = (tmp_path / "work" / "output.json").read_text(encoding="utf-8")
    assert "60.157000000000004" in text
    assert "29491.727857142858" in text


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


@pytest.mark.parametrize(
    ("node_name", "where"),
    [
        ("nan_beside_a_key_json_cannot_write", "输出 a 的值是 NaN"),
        (
            "nan_under_a_key_json_cannot_write",
            "输出里有 2 处 NaN 或无穷：n（NaN）、x[b'k']（Infinity）",
        ),
    ],
)
def test_finding_the_place_of_a_nan_does_not_trip_over_a_key_json_cannot_write(
    tmp_path: Path, code_dir: Path, node_name: str, where: str
) -> None:
    """字典的键是 bytes 这类 JSON 写不了的东西时，找位置的遍历不能自己抛异常：
    那样任务的错误会变成 `TypeError`，堆栈落在执行器里，盖住 NaN 这个真正的原因。"""
    shutil.copy(Path(__file__).with_name("number_nodes.py"), code_dir)

    run = execute(tmp_path, code_dir, f"number_nodes:{node_name}")

    assert run.output is not None
    message = run.output["error"]["message"]
    assert message.startswith("NodeOutputError: 节点返回值不能序列化为 JSON：")
    assert where in message


def test_when_finding_the_place_fails_the_original_error_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """位置只是附带的信息：取不到时报原来的错误，不让取位置的异常盖住它。"""

    def broken(value: object) -> list[tuple[str, float]]:
        raise RuntimeError("取位置时出的错")

    monkeypatch.setattr(runner, "non_finite_places", broken)

    with pytest.raises(runner.NodeOutputError) as raised:
        runner._encode({"a": float("nan")})

    message = str(raised.value)
    assert message.startswith(
        "节点返回值不能序列化为 JSON：Out of range float values are not JSON compliant"
    )
    assert "输出" not in message


def test_ctx_progress_drops_integers_too_big_for_a_float_with_one_warning(
    tmp_path: Path, code_dir: Path
) -> None:
    """`math.isfinite(10**400)` 抛 `OverflowError`：不能让节点因此失败（#481）。"""
    shutil.copy(Path(__file__).with_name("number_nodes.py"), code_dir)

    run = execute(tmp_path, code_dir, "number_nodes:huge_integer_progress")

    assert run.returncode == 0, run.stderr
    events = events_of(tmp_path)
    assert [(e["current"], e["total"]) for e in events if e["type"] == "progress"] == [(2, 10)]
    warnings = [e["message"] for e in events if e["type"] == "log" and e["level"] == "warn"]
    assert len(warnings) == 1
    assert "ctx.progress" in warnings[0]
    assert len(warnings[0]) < 300


def test_ctx_metric_drops_integers_too_big_for_a_float_like_progress(
    tmp_path: Path, code_dir: Path
) -> None:
    shutil.copy(Path(__file__).with_name("number_nodes.py"), code_dir)

    run = execute(tmp_path, code_dir, "number_nodes:huge_integer_metric")

    assert run.returncode == 0, run.stderr
    events = events_of(tmp_path)
    assert [e["value"] for e in events if e["type"] == "metric"] == [1.5]
    warnings = [e["message"] for e in events if e["type"] == "log" and e["level"] == "warn"]
    assert len(warnings) == 1
    assert "指标 'tps'" in warnings[0]
    assert len(warnings[0]) < 300


def test_the_progress_warning_does_not_hide_a_metric_named_progress(
    tmp_path: Path, code_dir: Path
) -> None:
    """两种警告各写一次：`ctx.progress` 先警告过，名叫 `progress` 的指标的警告也照常写。"""
    shutil.copy(Path(__file__).with_name("number_nodes.py"), code_dir)

    run = execute(
        tmp_path, code_dir, "number_nodes:non_finite_progress_and_a_metric_named_progress"
    )

    assert run.returncode == 0, run.stderr
    warnings = [
        e["message"] for e in events_of(tmp_path) if e["type"] == "log" and e["level"] == "warn"
    ]
    assert len(warnings) == 2
    assert "ctx.progress" in warnings[0]
    assert "指标 'progress'" in warnings[1]


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
    wait_for(ready.exists, 30, what="节点启动")
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


def terminate(
    tmp_path: Path,
    code_dir: Path,
    entry: str,
    ready: Path,
    *,
    extra_path: Path | None = None,
    task_fields: dict[str, Any] | None = None,
) -> Execution:
    """启动执行器，等节点写出 `ready` 后像 Agent 那样先写取消标记再发 SIGTERM，等它退出。

    `extra_path` 是再多加进导入路径的目录（装第三方库、标准节点包的 site-packages），
    `task_fields` 是写进 task.json 的其他字段（例如 `package`）。"""
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    (work / "task.json").write_text(
        json.dumps({"entry": entry, "inputs": {}, **(task_fields or {})})
    )
    env = {
        **{k: v for k, v in os.environ.items() if not k.startswith("SFLY_")},
        "PYTHONPATH": os.pathsep.join(
            [str(SDK_SRC), str(code_dir), *([str(extra_path)] if extra_path else [])]
        ),
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
    wait_for(ready.exists, 30, what="节点启动")
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


def test_a_cancelled_that_nobody_catches_in_a_background_thread_is_quiet_too(
    tmp_path: Path, code_dir: Path
) -> None:
    """取消或超时进入收尾时，后台线程里正在进行的调用抛 `Cancelled`，节点没有接住：和主线程一样是
    正常终止，只在事件管道里留一行 INFO，标准错误里没有 ERROR 级的堆栈（#678）。"""
    write_module(
        code_dir,
        "bgcancel",
        """
        import threading
        from sfly import Cancelled

        def work() -> dict:
            def waiting() -> None:
                raise Cancelled("任务正在收尾，调用已放弃")

            thread = threading.Thread(target=waiting, name="bg-wait")
            thread.start()
            thread.join()
            return {"done": True}
        """,
    )

    run = execute(tmp_path, code_dir, "bgcancel:work")

    assert run.returncode == 0
    assert run.stderr == ""
    infos = [e for e in events_of(tmp_path) if e.get("level") == "info"]
    assert [e["message"] for e in infos] == [
        "后台线程 bg-wait：任务正在收尾，调用已放弃，执行到 bgcancel.work.<locals>.waiting 第 7 行"
    ]


def test_any_other_exception_in_a_background_thread_still_writes_its_stack(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "bgerror",
        """
        import threading

        def work() -> dict:
            def broken() -> None:
                raise ValueError("后台线程自己的错")

            thread = threading.Thread(target=broken, name="bg-broken")
            thread.start()
            thread.join()
            return {}
        """,
    )

    run = execute(tmp_path, code_dir, "bgerror:work")

    assert run.returncode == 0
    assert "Exception in thread bg-broken" in run.stderr
    assert "ValueError: 后台线程自己的错" in run.stderr
    # 没有被当作正常终止：事件管道里没有 INFO（节点没有写过日志，事件文件可能都没有）。
    events = tmp_path / "work" / "events.jsonl"
    assert not events.exists() or [e for e in events_of(tmp_path) if e.get("level") == "info"] == []


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


def marked_line(code_dir: Path, module: str, marker: str = STOPPED_HERE) -> int:
    lines = (code_dir / f"{module}.py").read_text(encoding="utf-8").splitlines()
    return next(i for i, line in enumerate(lines, 1) if marker in line)


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


CALLED_HERE = "# 在这一行调用内部函数"


def fake_sfly_std(code_dir: Path, ready: Path, *, editable: bool = False) -> Path:
    """一个假的 `sfly_std`，结构和真的一样：公开函数 `wait_for_port` 再调内部函数 `_wait` 去等，
    里面调到它依赖的第三方库 `thirdlib`（真的会调到 `psutil`）。第三方库总在名为 site-packages 的
    目录里；
    `sfly_std` 默认也装在那里（Agent 上用 wheel 装的样子），`editable=True` 时放在普通目录里
    （可编辑安装，本仓库的 `std/tests` 和开发文档的示例是这样跑的）。返回放 `sfly_std` 的目录。"""
    site = code_dir / "site-packages"
    site.mkdir(exist_ok=True)
    (site / "thirdlib.py").write_text(
        "import threading\n\n\ndef block() -> None:\n"
        f"    open({str(ready)!r}, 'w').close(); threading.Event().wait(60)  {STOPPED_HERE}\n",
        encoding="utf-8",
    )
    library = code_dir / "editable" if editable else site
    package = library / "sfly_std"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "waiting.py").write_text(
        "import thirdlib\n\n\ndef _wait() -> None:\n    thirdlib.block()\n\n\n"
        f"def wait_for_port() -> None:\n    _wait()  {CALLED_HERE}\n",
        encoding="utf-8",
    )
    return library


def business_node(code_dir: Path, library: Path, body: str) -> None:
    """业务节点模块 `business`：导入路径里加上假的 `sfly_std` 和第三方库，`check()` 是 `body`。"""
    write_module(
        code_dir,
        "business",
        f"""
        import sys
        sys.path[:0] = [{str(library)!r}, {str(code_dir / "site-packages")!r}]
        from sfly_std.waiting import wait_for_port

        {body}
        """,
    )


@pytest.mark.parametrize("editable", [False, True], ids=["site-packages", "editable"])
def test_stopped_inside_a_standard_package_helper_reports_the_node_line_that_called_it(
    tmp_path: Path, code_dir: Path, editable: bool
) -> None:
    # #568：业务节点调用标准节点包（`sfly_std`）的辅助函数时被终止：「执行到哪」是业务节点里调用它的
    # 那一行，用户直接调用的那个辅助函数（`wait_for_port`，不是它里面再调的内部函数）写在后面
    # 作补充。
    # 辅助函数调到的第三方库（真的会调到 `psutil`）也算辅助函数内部，不会让位置变成库里的。
    ready = tmp_path / "ready"
    library = fake_sfly_std(code_dir, ready, editable=editable)
    business_node(
        code_dir,
        library,
        f"def check() -> None:\n            wait_for_port()  {STOPPED_HERE}",
    )

    run = terminate(tmp_path, code_dir, "business:check", ready)

    [event] = events_of(tmp_path)
    called = marked_line(library / "sfly_std", "waiting", CALLED_HERE)
    assert event["message"] == (
        f"任务被终止（SIGTERM），执行到 business.check 第 {marked_line(code_dir, 'business')} 行"
        f"（正在 sfly_std.waiting.wait_for_port 第 {called} 行）"
    )
    assert run.stderr == ""


def test_the_standard_nodes_themselves_still_report_the_place_inside_the_package(
    tmp_path: Path, code_dir: Path
) -> None:
    # 节点自己就是 `sfly_std` 里的节点（`shell` 这类）：它们的代码就在包里，位置仍然指向包里，
    # 没有补充。
    ready = tmp_path / "ready"
    package = code_dir / "site-packages" / "sfly_std"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "commands.py").write_text(
        "import threading\n\n\ndef run_command() -> None:\n"
        f"    open({str(ready)!r}, 'w').close(); threading.Event().wait(60)  {STOPPED_HERE}\n",
        encoding="utf-8",
    )
    (package / "shell.py").write_text(
        "from sfly_std.commands import run_command\n\n\ndef shell() -> None:\n    run_command()\n",
        encoding="utf-8",
    )

    run = terminate(
        tmp_path, code_dir, "sfly_std.shell:shell", ready, extra_path=code_dir / "site-packages"
    )

    [event] = events_of(tmp_path)
    inner = marked_line(package, "commands")
    assert event["message"] == (
        f"任务被终止（SIGTERM），执行到 sfly_std.commands.run_command 第 {inner} 行"
    )
    assert run.stderr == ""


def test_a_callback_the_user_passes_to_a_helper_reports_the_callback_line(
    tmp_path: Path, code_dir: Path
) -> None:
    # 用户把回调传给辅助函数（`poll_until(lambda: …)`）：回调是节点自己的代码，被终止时停在回调里，
    # 报回调那一行，不会因为栈里有 `sfly_std` 的帧就被跳过。
    ready = tmp_path / "ready"
    library = fake_sfly_std(code_dir, ready)
    (library / "sfly_std" / "polling.py").write_text(
        "def poll_until(check) -> None:\n    check()\n", encoding="utf-8"
    )
    write_module(
        code_dir,
        "business",
        f"""
        import sys, threading
        sys.path[:0] = [{str(library)!r}, {str(code_dir / "site-packages")!r}]
        from sfly_std.polling import poll_until

        def wait_a_bit() -> None:
            open({str(ready)!r}, "w").close(); threading.Event().wait(60)  {STOPPED_HERE}

        def check() -> None:
            poll_until(wait_a_bit)
        """,
    )

    run = terminate(tmp_path, code_dir, "business:check", ready)

    [event] = events_of(tmp_path)
    assert event["message"] == (
        "任务被终止（SIGTERM），执行到 business.wait_a_bit "
        f"第 {marked_line(code_dir, 'business')} 行"
    )
    assert run.stderr == ""


def test_the_package_in_task_json_tells_the_nodes_own_modules_from_the_libraries_beside_them(
    tmp_path: Path, code_dir: Path
) -> None:
    # 节点包装进来的顶层模块不止入口模块的那一个（`helpers`）：用户直接传给辅助函数的回调在
    # `helpers` 里，靠 task.json 的 `package`（发行版）才认得出它是节点自己的代码，被终止时报回调
    # 那一行。执行器不把 `package` 传下去的话，`helpers` 在 site-packages 里被当成第三方库，位置
    # 落回业务节点调用辅助函数的那一行。
    ready = tmp_path / "ready"
    library = fake_sfly_std(code_dir, ready)
    (library / "sfly_std" / "polling.py").write_text(
        "def poll_until(check) -> None:\n    check()\n", encoding="utf-8"
    )
    site = code_dir / "site-packages"
    (site / "helpers.py").write_text(
        "import threading\n\n\ndef wait_a_bit(ready) -> None:\n"
        f"    open(ready, 'w').close(); threading.Event().wait(60)  {STOPPED_HERE}\n",
        encoding="utf-8",
    )
    dist = site / "my_pkg-1.0.dist-info"
    dist.mkdir()
    (dist / "METADATA").write_text("Metadata-Version: 2.1\nName: my-pkg\nVersion: 1.0\n")
    (dist / "top_level.txt").write_text("business\nhelpers\n")
    write_module(
        code_dir,
        "business",
        f"""
        import functools, sys
        sys.path[:0] = [{str(library)!r}, {str(site)!r}]
        import helpers
        from sfly_std.polling import poll_until

        def check() -> None:
            poll_until(functools.partial(helpers.wait_a_bit, {str(ready)!r}))
        """,
    )

    run = terminate(tmp_path, code_dir, "business:check", ready, task_fields={"package": "my-pkg"})

    [event] = events_of(tmp_path)
    assert event["message"] == (
        f"任务被终止（SIGTERM），执行到 helpers.wait_a_bit 第 {marked_line(site, 'helpers')} 行"
    )
    assert run.stderr == ""


# ---- 节点失败：堆栈从节点代码开始，给出出错的位置（#471） ----

RAISED_HERE = "# 在这一行抛出"


def raised_line(directory: Path, module: str) -> int:
    lines = (directory / f"{module}.py").read_text(encoding="utf-8").splitlines()
    return next(i for i, line in enumerate(lines, 1) if RAISED_HERE in line)


def failed(
    tmp_path: Path,
    code_dir: Path,
    entry: str,
    env: dict[str, str | None] | None = None,
    **task_fields: Any,
) -> tuple[Execution, dict[str, Any]]:
    """执行一个会失败的节点，返回执行结果和 output.json 里的 error。"""
    run = execute(tmp_path, code_dir, entry, env=env, task_fields=task_fields)
    assert run.returncode == 1, run.stderr
    assert run.output is not None
    assert run.output["status"] == "failed"
    error: dict[str, Any] = run.output["error"]
    return run, error


def frame_files(traceback_text: str) -> list[str]:
    """堆栈里每一帧的文件名（`File "…", line N, in f` 那一行）。"""
    return [
        line.split('"')[1] for line in traceback_text.splitlines() if line.startswith('  File "')
    ]


def test_a_node_raising_directly_gets_a_traceback_that_starts_in_the_node_and_the_line(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "direct",
        f"""
        def work(x: str = "a") -> dict:
            raise ValueError("坏了")  {RAISED_HERE}
        """,
    )

    run, error = failed(tmp_path, code_dir, "direct:work")

    line = raised_line(code_dir, "direct")
    assert error["location"] == f"direct.work 第 {line} 行"
    assert error["message"] == "ValueError: 坏了"
    # 堆栈第一帧就是节点代码，没有执行器的帧。
    assert frame_files(error["traceback"]) == [str(code_dir / "direct.py")]
    assert error["traceback"].rstrip().endswith("ValueError: 坏了")
    assert "runner.py" not in error["traceback"]
    # 日志里：标准错误是同一份堆栈，之前先写一行出错的位置（ERROR 级，来源 sdk）：
    # `sfly run logs --failed` 只看日志也看得到，不用翻堆栈。
    assert run.stderr == error["traceback"]
    [event] = events_of(tmp_path)
    assert (event["type"], event["level"]) == ("log", "error")
    assert event["message"] == f"出错位置：direct.work 第 {line} 行"


def test_an_exception_raised_in_a_helper_module_reports_the_helper_line(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "helpers",
        f"""
        def parse(text: str) -> int:
            return int(text)  {RAISED_HERE}
        """,
    )
    write_module(
        code_dir,
        "usehelper",
        """
        import helpers

        def work() -> dict:
            return {"n": helpers.parse("x")}
        """,
    )

    _, error = failed(tmp_path, code_dir, "usehelper:work")

    assert error["location"] == f"helpers.parse 第 {raised_line(code_dir, 'helpers')} 行"
    assert frame_files(error["traceback"]) == [
        str(code_dir / "usehelper.py"),
        str(code_dir / "helpers.py"),
    ]


def test_an_exception_raised_by_the_sdk_reports_the_node_line_and_keeps_the_sdk_frames(
    tmp_path: Path, code_dir: Path
) -> None:
    # 异常是在 SDK 里抛出的（这里是 ctx.notify 的参数不对）：位置是调用它的那一行节点代码，
    # 节点代码之后的 SDK 帧留着，它们说明是哪一次调用失败。
    write_module(
        code_dir,
        "usesdk",
        f"""
        from sfly import Context

        def work(ctx: Context) -> dict:
            ctx.notify(5, "x")  {RAISED_HERE}
            return {{}}
        """,
    )

    _, error = failed(tmp_path, code_dir, "usesdk:work")

    assert error["location"] == f"usesdk.work 第 {raised_line(code_dir, 'usesdk')} 行"
    files = frame_files(error["traceback"])
    assert files[0] == str(code_dir / "usesdk.py")
    assert [Path(f).name for f in files[1:]] == ["context.py"]
    assert "runner.py" not in error["traceback"]


def test_an_exception_raised_in_a_third_party_library_reports_the_node_line_that_called_it(
    tmp_path: Path, code_dir: Path
) -> None:
    # 异常从第三方库里抛出时，位置是调用它的那一行节点代码：失败时人要改的是自己的代码。
    # 和被终止时不同（那里停在第三方库里就报库里的位置）。库的帧在堆栈里照常保留。
    library = code_dir / "site-packages"
    library.mkdir()
    (library / "thirdparty.py").write_text(
        f"def fetch() -> None:\n    raise OSError('连不上')  {RAISED_HERE}\n", encoding="utf-8"
    )
    write_module(
        code_dir,
        "uselib",
        f"""
        import sys
        sys.path.insert(0, __file__.rsplit("/", 1)[0] + "/site-packages")
        import thirdparty

        def work() -> dict:
            thirdparty.fetch()  {RAISED_HERE}
            return {{}}
        """,
    )

    _, error = failed(tmp_path, code_dir, "uselib:work")

    assert error["location"] == f"uselib.work 第 {raised_line(code_dir, 'uselib')} 行"
    assert frame_files(error["traceback"]) == [
        str(code_dir / "uselib.py"),
        str(library / "thirdparty.py"),
    ]


@pytest.mark.parametrize("editable", [False, True], ids=["site-packages", "editable"])
def test_an_exception_raised_in_a_standard_package_helper_reports_the_node_line_that_called_it(
    tmp_path: Path, code_dir: Path, editable: bool
) -> None:
    # #568：出错的位置也是业务节点里调用辅助函数的那一行，不是 `sfly_std` 内部，不管它装在哪里：
    # 装进 site-packages（Agent 上）和可编辑安装（本仓库的 `std/tests`、开发文档的示例）用同一个判断
    # （被终止时的「执行到哪」也是它），不会一个跳过 `sfly_std`、一个不跳过。堆栈里辅助函数的帧
    # 照常保留。
    library = code_dir / "editable" if editable else code_dir / "site-packages"
    package = library / "sfly_std"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "waiting.py").write_text(
        f"def wait_for_port() -> None:\n    raise TimeoutError('等不到')  {RAISED_HERE}\n",
        encoding="utf-8",
    )
    write_module(
        code_dir,
        "business",
        f"""
        import sys
        sys.path.insert(0, {str(library)!r})
        from sfly_std.waiting import wait_for_port

        def check() -> dict:
            wait_for_port()  {RAISED_HERE}
            return {{}}
        """,
    )

    _, error = failed(tmp_path, code_dir, "business:check")

    assert error["location"] == f"business.check 第 {raised_line(code_dir, 'business')} 行"
    assert frame_files(error["traceback"]) == [
        str(code_dir / "business.py"),
        str(package / "waiting.py"),
    ]


@pytest.fixture
def installed_package(tmp_path: Path) -> Path:
    """装在 site-packages 里的节点包 mypkg 和同一目录里的第三方库 otherlib（Agent 的共享 venv）。"""
    site = tmp_path / "venv" / "site-packages"
    package = site / "mypkg"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "util.py").write_text(
        f"def check() -> None:\n    raise ValueError('不合格')  {RAISED_HERE}\n", encoding="utf-8"
    )
    (package / "nodes.py").write_text(
        "import otherlib\n"
        "from mypkg import util\n\n\n"
        "def use_util() -> dict:\n    util.check()\n    return {}\n\n\n"
        f"def use_lib() -> dict:\n    otherlib.fetch()  {RAISED_HERE}\n    return {{}}\n",
        encoding="utf-8",
    )
    (site / "otherlib.py").write_text(
        f"def fetch() -> None:\n    raise OSError('连不上')  {RAISED_HERE}\n", encoding="utf-8"
    )
    return site


def test_a_node_package_in_site_packages_is_told_apart_from_the_libraries_beside_it(
    tmp_path: Path, code_dir: Path, installed_package: Path
) -> None:
    # 入口模块所在顶层包里的帧是节点自己的代码，哪怕装在 site-packages 里；同目录的其他库不是。
    env: dict[str, str | None] = {
        "PYTHONPATH": os.pathsep.join([str(SDK_SRC), str(installed_package)])
    }

    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    _, own = failed(tmp_path / "a", code_dir, "mypkg.nodes:use_util", env)
    _, lib = failed(tmp_path / "b", code_dir, "mypkg.nodes:use_lib", env)

    util_line = raised_line(installed_package / "mypkg", "util")
    assert own["location"] == f"mypkg.util.check 第 {util_line} 行"
    nodes_line = raised_line(installed_package / "mypkg", "nodes")
    assert lib["location"] == f"mypkg.nodes.use_lib 第 {nodes_line} 行"


def test_the_package_a_node_belongs_to_decides_which_top_level_modules_are_its_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 节点包装进来的顶层模块不止入口模块的那一个时，按发行版找出全部（`task.json` 的 `package`）。
    from importlib import metadata

    monkeypatch.setattr(
        metadata,
        "packages_distributions",
        lambda: {"mypkg": ["my-pkg"], "helpers": ["My_Pkg"], "requests": ["requests"]},
    )

    assert runner._node_packages("mypkg.nodes:work", "my.pkg") == {"mypkg", "helpers"}
    assert runner._node_packages("mypkg.nodes:work", None) == {"mypkg"}
    assert runner._node_packages("plain:work", "unknown") == {"plain"}


def test_a_syntax_error_in_the_node_module_reports_the_file_and_line_and_no_executor_frames(
    tmp_path: Path, code_dir: Path
) -> None:
    (code_dir / "broken.py").write_text("def work():\n    return (1 +\n", encoding="utf-8")

    _, error = failed(tmp_path, code_dir, "broken:work")

    assert error["location"] == "broken 第 2 行"
    assert error["type"] == "SyntaxError"
    assert "runner.py" not in error["traceback"]
    assert error["traceback"].rstrip().endswith("SyntaxError: '(' was never closed")


def test_a_syntax_error_in_a_helper_imported_by_the_node_module_reports_the_helper(
    tmp_path: Path, code_dir: Path
) -> None:
    (code_dir / "badhelper.py").write_text("x = =\n", encoding="utf-8")
    write_module(
        code_dir, "needshelper", "import badhelper\n\ndef work() -> dict:\n    return {}\n"
    )

    _, error = failed(tmp_path, code_dir, "needshelper:work")

    assert error["location"] == "badhelper 第 1 行"


@pytest.fixture
def broken_packages(tmp_path: Path) -> Path:
    """site-packages 里的节点包（语法错误在包的 `__init__.py`、在子模块里）和一个第三方库。"""
    site = tmp_path / "venv" / "site-packages"
    for name in ("syntaxinit", "syntaxsub"):
        (site / name).mkdir(parents=True)
    (site / "syntaxinit" / "__init__.py").write_text("def work():\n    return (1 +\n", "utf-8")
    (site / "syntaxsub" / "__init__.py").write_text("", encoding="utf-8")
    (site / "syntaxsub" / "broken.py").write_text("x = 1\ny = =\n", encoding="utf-8")
    (site / "syntaxsub" / "nodes.py").write_text(
        "from syntaxsub import broken\n\n\ndef work() -> dict:\n    return {}\n", encoding="utf-8"
    )
    (site / "badlib.py").write_text("z = =\n", encoding="utf-8")
    return site


def test_a_syntax_error_in_a_node_package_in_site_packages_reports_the_module_and_line(
    tmp_path: Path, code_dir: Path, broken_packages: Path
) -> None:
    """节点包装在 Agent 的共享 venv 里时，导入时的语法错误也取得到位置（#471）：文件名去掉扩展名
    不是顶层包名，要按路径判断；包里的子模块写模块名，分得清是哪个 `__init__.py`。"""
    env: dict[str, str | None] = {
        "PYTHONPATH": os.pathsep.join([str(SDK_SRC), str(broken_packages)])
    }
    for index, (entry, place) in enumerate(
        [
            ("syntaxinit:work", "syntaxinit 第 2 行"),
            ("syntaxsub.nodes:work", "syntaxsub.broken 第 2 行"),
        ]
    ):
        (tmp_path / str(index)).mkdir()

        _, error = failed(tmp_path / str(index), code_dir, entry, env)

        assert error["type"] == "SyntaxError"
        assert error["location"] == place


def test_a_syntax_error_in_a_library_beside_the_node_package_reports_the_import_line(
    tmp_path: Path, code_dir: Path, broken_packages: Path
) -> None:
    write_module(
        code_dir,
        "usebadlib",
        f"""
        import badlib  {RAISED_HERE}

        def work() -> dict:
            return {{}}
        """,
    )
    env: dict[str, str | None] = {
        "PYTHONPATH": os.pathsep.join([str(SDK_SRC), str(code_dir), str(broken_packages)])
    }

    _, error = failed(tmp_path, code_dir, "usebadlib:work", env)

    # 第三方库里的语法错误不是节点代码：位置是节点里导入它的那一行。
    assert error["location"] == f"usebadlib 第 {raised_line(code_dir, 'usebadlib')} 行"


def test_a_syntax_error_in_a_package_in_the_source_directory_reports_the_module_and_line(
    tmp_path: Path, code_dir: Path
) -> None:
    (code_dir / "srcpkg").mkdir()
    (code_dir / "srcpkg" / "__init__.py").write_text("", encoding="utf-8")
    (code_dir / "srcpkg" / "broken.py").write_text("y = =\n", encoding="utf-8")
    write_module(
        code_dir, "usesrcpkg", "from srcpkg import broken\n\n\ndef work() -> dict:\n    return {}\n"
    )

    _, error = failed(tmp_path, code_dir, "usesrcpkg:work")

    assert error["location"] == "srcpkg.broken 第 1 行"


def test_an_import_error_in_the_node_module_reports_the_import_line(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "needslib",
        f"""
        import not_installed_anywhere  {RAISED_HERE}

        def work() -> dict:
            return {{}}
        """,
    )

    _, error = failed(tmp_path, code_dir, "needslib:work")

    assert error["location"] == f"needslib 第 {raised_line(code_dir, 'needslib')} 行"
    assert error["type"] == "ModuleNotFoundError"
    # 堆栈从节点模块导入出错的那一行开始。
    assert frame_files(error["traceback"])[0] == str(code_dir / "needslib.py")
    assert "runner.py" not in error["traceback"]


def test_an_entry_module_that_does_not_exist_has_no_location_and_no_frames_at_all(
    tmp_path: Path, code_dir: Path
) -> None:
    _, error = failed(tmp_path, code_dir, "missing_module:work")

    assert "location" not in error
    assert error["traceback"] == "ModuleNotFoundError: No module named 'missing_module'\n"


def test_an_async_node_reports_the_line_inside_the_coroutine(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "asyncnode",
        f"""
        import asyncio

        async def fetch() -> None:
            await asyncio.sleep(0)
            raise TimeoutError("超时")  {RAISED_HERE}

        def work() -> dict:
            asyncio.run(fetch())
            return {{}}
        """,
    )

    _, error = failed(tmp_path, code_dir, "asyncnode:work")

    assert error["location"] == f"asyncnode.fetch 第 {raised_line(code_dir, 'asyncnode')} 行"
    # 中间的标准库帧（asyncio.run）保留，只去开头的执行器帧。
    files = frame_files(error["traceback"])
    assert files[0] == str(code_dir / "asyncnode.py")
    assert any(Path(f).name == "runners.py" for f in files)


def test_an_exception_chain_keeps_every_part_and_the_location_is_the_last_raise(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "chained",
        f"""
        def lookup(key: str) -> int:
            return {{}}[key]  # 先抛出的

        def work() -> dict:
            try:
                lookup("k")
            except KeyError as error:
                raise RuntimeError("查不到") from error  {RAISED_HERE}
        """,
    )

    _, error = failed(tmp_path, code_dir, "chained:work")

    assert error["location"] == f"chained.work 第 {raised_line(code_dir, 'chained')} 行"
    traceback_text = error["traceback"]
    assert "The above exception was the direct cause of the following exception:" in traceback_text
    # 链上每一段都从节点代码开始。
    assert "runner.py" not in traceback_text
    assert traceback_text.count("Traceback (most recent call last):") == 2
    assert traceback_text.index("KeyError: 'k'") < traceback_text.index("RuntimeError: 查不到")


def test_an_error_raised_while_handling_another_one_is_also_cut_from_the_node(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "handling",
        f"""
        def work() -> dict:
            try:
                {{}}["k"]
            except KeyError:
                raise RuntimeError("处理时又出错")  {RAISED_HERE}
        """,
    )

    _, error = failed(tmp_path, code_dir, "handling:work")

    assert (
        "During handling of the above exception, another exception occurred:" in error["traceback"]
    )
    assert "runner.py" not in error["traceback"]
    assert error["location"] == f"handling.work 第 {raised_line(code_dir, 'handling')} 行"


@pytest.mark.skipif(sys.version_info < (3, 11), reason="TaskGroup 和异常组从 Python 3.11 起有")
@pytest.mark.parametrize("nested", [False, True], ids=["one group", "nested groups"])
def test_a_failure_in_a_task_group_reports_the_line_in_the_child_task(
    tmp_path: Path, code_dir: Path, nested: bool
) -> None:
    # `async with asyncio.TaskGroup()` 里的子任务抛出，外面收到的是异常组，它自己的栈停在
    # `async with` 那一行；位置要取第一个子异常里出错的那一行（嵌套的异常组一直往下取）。
    wrapper = (
        "    async with asyncio.TaskGroup() as outer:\n        outer.create_task(inner())\n"
        if nested
        else "    await inner()\n"
    )
    write_module(
        code_dir,
        "groupnode",
        "import asyncio\n\n\n"
        f"async def child() -> None:\n    raise ValueError('子任务出错')  {RAISED_HERE}\n\n\n"
        "async def inner() -> None:\n"
        "    async with asyncio.TaskGroup() as group:\n        group.create_task(child())\n\n\n"
        f"async def main() -> None:\n{wrapper}\n\n"
        "def work() -> dict:\n    asyncio.run(main())\n    return {}\n",
    )

    _, error = failed(tmp_path, code_dir, "groupnode:work")

    assert error["type"] in ("ExceptionGroup", "BaseExceptionGroup")
    assert error["location"] == f"groupnode.child 第 {raised_line(code_dir, 'groupnode')} 行"


def test_a_generated_frame_without_a_file_does_not_hide_the_node_line_that_called_it(
    tmp_path: Path, code_dir: Path
) -> None:
    # 冻结的 dataclass 被赋值时，抛出的是 dataclass 生成的 `__setattr__`（文件名是 `<string>`），
    # 没有任何文件里有那一行：位置是调用它的节点代码那一行。
    write_module(
        code_dir,
        "frozennode",
        f"""
        import dataclasses

        @dataclasses.dataclass(frozen=True)
        class Point:
            x: int

        def work() -> dict:
            point = Point(1)
            point.x = 2  {RAISED_HERE}
            return {{}}
        """,
    )

    _, error = failed(tmp_path, code_dir, "frozennode:work")

    assert error["type"] == "FrozenInstanceError"
    assert error["location"] == f"frozennode.work 第 {raised_line(code_dir, 'frozennode')} 行"


def test_a_function_built_with_exec_reports_the_node_line_that_called_it(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "execnode",
        f"""
        namespace: dict = {{}}
        exec("def f():\\n    raise ValueError('x')\\n", namespace)

        def work() -> dict:
            namespace["f"]()  {RAISED_HERE}
            return {{}}
        """,
    )

    _, error = failed(tmp_path, code_dir, "execnode:work")

    assert error["location"] == f"execnode.work 第 {raised_line(code_dir, 'execnode')} 行"


def test_when_every_node_frame_has_no_file_the_innermost_one_is_reported(
    tmp_path: Path, code_dir: Path
) -> None:
    # 入口函数本身就是 exec 出来的：栈里只有没有文件名的节点帧，退回到它。
    write_module(
        code_dir,
        "allexec",
        """
        exec("def work():\\n    raise ValueError('x')\\n")
        """,
    )

    _, error = failed(tmp_path, code_dir, "allexec:work")

    assert error["location"] == "allexec.work 第 2 行"


def test_an_error_the_executor_itself_raises_keeps_the_whole_traceback_and_has_no_location(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(code_dir, "badreturn", "def work():\n    return [1]\n")

    _, error = failed(tmp_path, code_dir, "badreturn:work")

    assert error["type"] == "NodeOutputError"
    assert "location" not in error
    # 栈里没有节点代码：看不出是不是 SDK 自己的问题，原样保留。
    assert "runner.py" in error["traceback"]


def test_failing_to_work_out_the_location_does_not_lose_the_failure(
    tmp_path: Path, code_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_module(code_dir, "plainfail", "def work() -> dict:\n    raise ValueError('坏了')\n")

    def broken(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("取位置时出错")

    monkeypatch.setattr(runner, "_failed_at", broken)
    task = {"entry": "plainfail:work", "inputs": {}}
    monkeypatch.syspath_prepend(str(code_dir))

    code, text = runner.run(task)

    error = json.loads(text)["error"]
    assert code == 1
    assert error["message"] == "ValueError: 坏了"
    assert "location" not in error
    # 位置取不到时堆栈仍是节点的，不是取位置时出的那个错：失败的原因还在，
    # 堆栈里没有取位置出的错，也没有「During handling」那一段。
    assert "ValueError: 坏了" in error["traceback"]
    assert error["traceback"].rstrip().endswith("ValueError: 坏了")
    assert "取位置时出错" not in error["traceback"]
    assert "During handling" not in error["traceback"]
    assert frame_files(error["traceback"]) == [str(code_dir / "plainfail.py")]


def test_failing_to_trim_the_traceback_reports_the_full_traceback_of_the_nodes_error(
    tmp_path: Path, code_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_module(code_dir, "plainfail2", "def work() -> dict:\n    raise ValueError('坏了')\n")

    def broken(*args: Any, **kwargs: Any) -> str:
        raise RuntimeError("整理堆栈时出错")

    monkeypatch.setattr(runner, "_format_failure", broken)
    monkeypatch.syspath_prepend(str(code_dir))

    code, text = runner.run({"entry": "plainfail2:work", "inputs": {}})

    error = json.loads(text)["error"]
    assert code == 1
    assert error["message"] == "ValueError: 坏了"
    # 整理不了就用节点的异常完整的堆栈（执行器的帧也在），不是整理时出的那个错。
    assert error["traceback"].rstrip().endswith("ValueError: 坏了")
    assert "整理堆栈时出错" not in error["traceback"]
    assert "During handling" not in error["traceback"]
    # 位置不依赖堆栈的整理，照常写。
    assert error["location"] == "plainfail2.work 第 2 行"


# ---- 「执行到哪」的取法本身：用拼出来的栈直接测，不需要真的被终止 ----


def frame_in(filename: str, function: str = "f", module: str = "fake") -> types.FrameType:
    """一个代码文件名是 `filename`、模块名是 `module` 的函数的栈帧（函数已经返回，帧对象还在）。"""
    namespace: dict[str, Any] = {"__name__": module}
    exec(  # 测试里造一个带指定文件名的帧
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


STD_FILE = "/venv/site-packages/sfly_std/waiting.py"
PSUTIL_FILE = "/venv/lib/python3.12/site-packages/psutil/__init__.py"


def test_the_helper_the_user_called_is_the_supplement_not_the_internal_function_it_runs() -> None:
    # 真的辅助函数大多再调内部函数去等：补充写用户直接调用的那一个（`wait_for_port`），不是里面的
    # `poll_until`，更不是下划线开头的内部模块里的函数。
    error = cancelled_through(
        frame_in(NODE_FRAME, "check", "biz.checks"),
        frame_in(STD_FILE, "wait_for_port", "sfly_std.waiting"),
        frame_in(STD_FILE, "poll_until", "sfly_std.waiting"),
        frame_in("/venv/site-packages/sfly_std/_process.py", "alive", "sfly_std._process"),
        frame_in(f"{STDLIB}/socket.py", "create_connection", "socket"),
        frame_in(f"{STDLIB}/time.py", "sleep", "time"),
    )

    assert runner._terminated_at(error) == (
        "biz.checks.check 第 3 行（正在 sfly_std.waiting.wait_for_port 第 3 行）"
    )


def test_a_third_party_library_the_helper_calls_is_part_of_the_helper() -> None:
    # `sfly_std` 调到它依赖的 `psutil`、`httpx` 时被终止：不是「停在第三方库里」，位置仍是业务
    # 节点的那一行，
    # 补充是用户直接调用的辅助函数。
    error = cancelled_through(
        frame_in(NODE_FRAME, "check", "biz.checks"),
        frame_in(
            "/venv/site-packages/sfly_std/resources.py", "monitor_processes", "sfly_std.resources"
        ),
        frame_in("/venv/site-packages/sfly_std/resources.py", "_sample", "sfly_std.resources"),
        frame_in(PSUTIL_FILE, "pid", "psutil"),
        frame_in(PSUTIL_FILE, "_get_kinfo_proc", "psutil._psosx"),
    )

    assert runner._terminated_at(error) == (
        "biz.checks.check 第 3 行（正在 sfly_std.resources.monitor_processes 第 3 行）"
    )


def test_a_library_the_user_calls_directly_is_still_reported_as_the_library() -> None:
    # 用户自己的代码直接停在第三方库里（没有经过 `sfly_std`）：和以前一样报库里的位置。
    error = cancelled_through(
        frame_in(NODE_FRAME, "check", "biz.checks"),
        frame_in(PSUTIL_FILE, "pid", "psutil"),
    )

    assert runner._terminated_at(error) == "psutil.pid 第 3 行"


def test_a_callback_passed_to_a_helper_is_the_nodes_own_code_and_is_reported() -> None:
    callback_waiting = cancelled_through(
        frame_in(NODE_FRAME, "check", "biz.checks"),
        frame_in(STD_FILE, "poll_until", "sfly_std.waiting"),
        frame_in("/work/callbacks.py", "ready", "biz.callbacks"),
        frame_in(f"{STDLIB}/time.py", "sleep", "time"),
    )
    callback_calling_a_helper = cancelled_through(
        frame_in(NODE_FRAME, "check", "biz.checks"),
        frame_in(STD_FILE, "poll_until", "sfly_std.waiting"),
        frame_in("/work/callbacks.py", "ready", "biz.callbacks"),
        frame_in("/venv/site-packages/sfly_std/commands.py", "run_command", "sfly_std.commands"),
        frame_in(PSUTIL_FILE, "pid", "psutil"),
    )
    callback_in_a_library = cancelled_through(
        frame_in(NODE_FRAME, "check", "biz.checks"),
        frame_in(STD_FILE, "poll_until", "sfly_std.waiting"),
        frame_in("/work/callbacks.py", "ready", "biz.callbacks"),
        frame_in(PSUTIL_FILE, "pid", "psutil"),
    )

    # 停在回调里：报回调那一行，回调下面没有辅助函数时没有补充。
    assert runner._terminated_at(callback_waiting) == "biz.callbacks.ready 第 3 行"
    # 回调里又调了辅助函数：那一个是补充，它调到的 psutil 同样算辅助函数内部。
    assert runner._terminated_at(callback_calling_a_helper) == (
        "biz.callbacks.ready 第 3 行（正在 sfly_std.commands.run_command 第 3 行）"
    )
    # 回调自己（不经过 `sfly_std`）调到第三方库：和别处一样报库里的位置。
    assert runner._terminated_at(callback_in_a_library) == "psutil.pid 第 3 行"


def test_standard_library_frames_inside_a_helper_do_not_end_the_helpers_stack_segment() -> None:
    # 真实的 `with proc.oneshot():`：`sfly_std` → `contextlib` → psutil。标准库的帧夹在中间，后面的
    # psutil 仍然是辅助函数调到的库，不是节点自己的代码。
    error = cancelled_through(
        frame_in(NODE_FRAME, "check", "biz.checks"),
        frame_in("/venv/site-packages/sfly_std/resources.py", "sample", "sfly_std.resources"),
        frame_in(f"{STDLIB}/contextlib.py", "__enter__", "contextlib"),
        frame_in(PSUTIL_FILE, "oneshot", "psutil"),
    )

    assert runner._terminated_at(error) == (
        "biz.checks.check 第 3 行（正在 sfly_std.resources.sample 第 3 行）"
    )


def test_a_frame_without_a_file_inside_a_helper_is_not_taken_for_a_callback() -> None:
    # psutil 返回的 namedtuple，`__new__` 的文件名是 `<string>`：没有文件，看不出来历，不是用户
    # 传进去的回调；它留在辅助函数的栈段里，位置仍是业务节点调用辅助函数的那一行。
    error = cancelled_through(
        frame_in(NODE_FRAME, "check", "biz.checks"),
        frame_in(
            "/venv/site-packages/sfly_std/resources.py",
            "monitor_processes",
            "sfly_std.resources",
        ),
        frame_in(PSUTIL_FILE, "memory_info", "psutil"),
        frame_in("<string>", "__new__", "namedtuple_pmem"),
    )

    assert runner._terminated_at(error) == (
        "biz.checks.check 第 3 行（正在 sfly_std.resources.monitor_processes 第 3 行）"
    )


def test_the_node_package_metadata_is_only_read_when_the_stack_has_a_standard_package_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 取「执行到哪」发生在收尾时间里：节点包的发行版信息（读全部发行版的元信息，发行版多时要几十
    # 毫秒）只有栈里出现 `sfly_std` 的帧时才用得上，没有时不读。
    calls: list[tuple[str, str | None]] = []
    real = runner._node_packages

    def spy(entry: str, package: str | None) -> set[str]:
        calls.append((entry, package))
        return real(entry, package)

    monkeypatch.setattr(runner, "_node_packages", spy)
    plain = cancelled_through(
        frame_in(NODE_FRAME, "check", "biz.checks"),
        frame_in(f"{STDLIB}/time.py", "sleep", "time"),
        frame_in(PSUTIL_FILE, "pid", "psutil"),
    )
    helper = cancelled_through(
        frame_in(NODE_FRAME, "check", "biz.checks"),
        frame_in(STD_FILE, "poll_until", "sfly_std.waiting"),
    )

    assert runner._terminated_at(plain, "biz.checks:check", "biz") == "psutil.pid 第 3 行"
    assert calls == []

    assert runner._terminated_at(helper, "biz.checks:check", "biz") == (
        "biz.checks.check 第 3 行（正在 sfly_std.waiting.poll_until 第 3 行）"
    )
    assert calls == [("biz.checks:check", "biz")]


def test_a_helper_wrapped_in_the_users_own_tool_module_reports_the_tool_module_line() -> None:
    # 用户把辅助函数再包一层自己的工具模块：最近的一帧用户代码是工具模块里调用它的那一行。
    error = cancelled_through(
        frame_in(NODE_FRAME, "check", "biz.checks"),
        frame_in("/work/tools.py", "wait_ready", "biz.tools"),
        frame_in(STD_FILE, "wait_for_port", "sfly_std.waiting"),
        frame_in(STD_FILE, "poll_until", "sfly_std.waiting"),
        frame_in(f"{STDLIB}/threading.py", "wait", "threading"),
    )

    assert runner._terminated_at(error) == (
        "biz.tools.wait_ready 第 3 行（正在 sfly_std.waiting.wait_for_port 第 3 行）"
    )


def test_a_standard_node_itself_keeps_reporting_the_place_inside_the_package() -> None:
    error = cancelled_through(
        frame_in("/venv/site-packages/sfly_std/shell.py", "shell", "sfly_std.shell"),
        frame_in("/venv/site-packages/sfly_std/commands.py", "run_command", "sfly_std.commands"),
        frame_in(f"{STDLIB}/subprocess.py", "wait", "subprocess"),
    )

    assert runner._terminated_at(error, "sfly_std.shell:shell") == (
        "sfly_std.commands.run_command 第 3 行"
    )
    # 标准节点自己的栈里没有「辅助函数内部」这回事，什么都不跳过：停在它调到的第三方库里，
    # 和以前一样报库里的位置（这一条不随 #568 变）。
    in_a_library = cancelled_through(
        frame_in("/venv/site-packages/sfly_std/shell.py", "shell", "sfly_std.shell"),
        frame_in("/venv/site-packages/sfly_std/commands.py", "run_command", "sfly_std.commands"),
        frame_in(PSUTIL_FILE, "pid", "psutil"),
    )
    assert runner._terminated_at(in_a_library, "sfly_std.shell:shell") == "psutil.pid 第 3 行"


def test_frames_of_other_packages_are_not_taken_for_the_standard_package() -> None:
    # 只认顶层模块叫 `sfly_std` 的：名字相近的第三方库、用户自己的 `sfly_std_extra` 不跳过。
    error = cancelled_through(
        frame_in(NODE_FRAME, "check", "biz.checks"),
        frame_in("/venv/site-packages/sfly_std_extra/x.py", "wait", "sfly_std_extra.x"),
    )

    assert runner._terminated_at(error) == "sfly_std_extra.x.wait 第 3 行"


def test_a_stack_of_only_runtime_and_standard_package_frames_reports_the_innermost_helper() -> None:
    # 整条栈都是辅助函数内部（入口不是 `sfly_std`，很难碰到）：先取最里面一帧 `sfly_std` 的帧，
    # 没有补充；没有 `sfly_std` 的帧时才取最里面一帧。
    only_helpers = cancelled_through(
        frame_in(STD_FILE, "wait_for_port", "sfly_std.waiting"),
        frame_in(STD_FILE, "poll_until", "sfly_std.waiting"),
        frame_in(f"{STDLIB}/time.py", "sleep", "time"),
    )
    only_runtime = cancelled_through(
        frame_in(f"{STDLIB}/threading.py", "wait", "threading"),
        frame_in(f"{STDLIB}/time.py", "sleep", "time"),
    )

    assert runner._terminated_at(only_helpers) == "sfly_std.waiting.poll_until 第 3 行"
    assert runner._terminated_at(only_runtime) == "time.sleep 第 3 行"


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
    # 清理时出的错是普通的失败：没有「任务被终止」那一行 INFO，只有普通失败的一行出错位置（#471）。
    [event] = events_of(tmp_path)
    assert (event["level"], event["message"].split(" 第 ")[0]) == (
        "error",
        "出错位置：broken.watch",
    )
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
    # 普通失败没有「任务被终止」那一行 INFO；只有一行出错位置（#471）。
    assert [(e["level"], e["message"].split(" 第 ")[0]) for e in events_of(tmp_path)] == [
        ("error", "出错位置：boom.explode")
    ]


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


# ---- 失败结果里的文字有上界（#723）----


def test_a_huge_exception_text_is_bounded_and_the_type_the_place_and_both_ends_survive(
    tmp_path: Path, code_dir: Path
) -> None:
    """异常的文字有几 MiB：说明留首尾各一半、堆栈只留帧，不重复同一段文字；类型和出错的位置照旧在；
    output.json 远小于 Agent 的读取上限（16 MiB），完整的文字在标准错误里。"""
    write_module(
        code_dir,
        "huge",
        f"""
        def work(size: int) -> dict:
            raise RuntimeError("起头" + "e" * size + "收尾")  {RAISED_HERE}
        """,
    )
    size = 3 * 1024 * 1024

    run, error = failed(tmp_path, code_dir, "huge:work", inputs={"size": size})

    assert error["type"] == "RuntimeError"
    assert error["location"] == f"huge.work 第 {raised_line(code_dir, 'huge')} 行"
    message = error["message"]
    assert message.startswith("RuntimeError: 起头eeee")
    assert message.endswith("eeee收尾")
    assert "异常的文字有" in message and "字节没有保留" in message
    assert len(message.encode("utf-8")) < runner.MAX_FAILURE_MESSAGE_BYTES + 400
    # 堆栈：看得到节点那一帧，末尾没有再存一份异常的文字
    traceback_text = error["traceback"]
    assert traceback_text.startswith("Traceback (most recent call last):")
    assert frame_files(traceback_text) == [str(code_dir / "huge.py")]
    assert "e" * 1000 not in traceback_text
    assert "这条异常的文字就是上面的说明" in traceback_text
    assert len(traceback_text.encode("utf-8")) < 4096
    assert run.output is not None
    assert len(json.dumps(run.output)) < 200 * 1024
    # 完整的文字写进了标准错误（任务日志里有全文）
    assert len(run.stderr) > size


def test_a_multibyte_exception_text_is_bounded_by_bytes_and_cut_on_character_boundaries(
    tmp_path: Path, code_dir: Path
) -> None:
    write_module(
        code_dir,
        "wide",
        """
        def work(count: int) -> dict:
            raise ValueError("中" * count)
        """,
    )

    # 4 万个字符、12 万字节：字符数在 64 KiB 之下，字节数超过
    _, error = failed(tmp_path, code_dir, "wide:work", inputs={"count": 40_000})

    message = error["message"]
    assert len(message.encode("utf-8")) < runner.MAX_FAILURE_MESSAGE_BYTES + 400
    assert message.startswith("ValueError: 中中")
    assert message.endswith("中中")
    assert "异常的文字有 120" in message  # 异常的类型加文字共 12 万多字节
    message.encode("utf-8")  # 整段都是合法的 UTF-8：没有切在字符中间


def test_a_failure_within_the_limits_is_unchanged(tmp_path: Path, code_dir: Path) -> None:
    """没超过上限的失败一个字不变：说明还在堆栈的末尾（和以前一样）。
    说明正好等于上限时不动，多 1 个字节才省。"""
    write_module(
        code_dir,
        "modest",
        """
        def work(size: int) -> dict:
            raise ValueError("x" * size)
        """,
    )

    _, error = failed(tmp_path, code_dir, "modest:work", inputs={"size": 10_000})
    assert error["message"] == "ValueError: " + "x" * 10_000
    assert error["traceback"].endswith(error["message"] + "\n")
    assert "没有保留" not in error["traceback"]

    exactly = runner.MAX_FAILURE_MESSAGE_BYTES - len("ValueError: ")
    _, error = failed(tmp_path, code_dir, "modest:work", inputs={"size": exactly})
    assert error["message"] == "ValueError: " + "x" * exactly

    _, error = failed(tmp_path, code_dir, "modest:work", inputs={"size": exactly + 1})
    assert "异常的文字有" in error["message"]


def test_a_bound_text_keeps_both_ends_and_says_how_much_was_left_out() -> None:
    limit = 100
    assert runner._bound_text("a" * limit, limit, "说明") == "a" * limit
    assert runner._bound_text("", limit, "说明") == ""
    text = "头" + "m" * 500 + "尾"  # 506 字节，头和尾各 3 个字节
    bounded = runner._bound_text(text, limit, "说明")
    # 首尾各留 50 字节，中间 406 字节没有保留
    assert bounded.startswith(
        "头" + "m" * 47 + "\n\n…（说明有 506 字节，超过 100 字节：中间 406 字节没有保留"
    )
    assert bounded.endswith("\n\n" + "m" * 47 + "尾")
    # 切点落在一个多字节字符中间时，那个字符整个不留，不出现乱码
    cut = runner._bound_text("中" * 40, 100, "说明")
    assert "�" not in cut
    assert cut.startswith("中" * 16 + "\n\n") and cut.endswith("\n\n" + "中" * 16)
    assert "中间 24 字节没有保留" in cut


def test_a_bound_traceback_keeps_the_last_frames_from_the_start_of_a_frame() -> None:
    frames = "".join(
        f'  File "/code/m.py", line {i}, in f{i}\n    call_{i}()\n' for i in range(1, 2001)
    )
    text = "Traceback (most recent call last):\n" + frames + "ValueError: boom\n"
    limit = 4096

    bounded = runner._bound_traceback(text, limit)

    assert bounded.startswith("…（堆栈有 ")
    body = bounded.split("…\n", 1)[1]
    assert len(body.encode("utf-8")) <= limit
    assert body.startswith('  File "/code/m.py"'), "从一帧的开头起"
    assert body.endswith(
        "call_2000()\n    ValueError: boom\n".replace("    ValueError", "ValueError")
    )
    assert runner._bound_traceback(text, 10 * len(text)) == text


def test_the_exception_text_is_not_stored_twice_when_the_message_is_cut(
    tmp_path: Path, code_dir: Path
) -> None:
    """说明被截短了，堆栈末尾那份（同一段文字）不留；说明没截短时堆栈末尾还是它。"""
    message, traceback_text = runner._bound_failure(
        "E: " + "z" * 200_000,
        'Traceback (most recent call last):\n  File "a.py", line 1, in f\n    g()\nE: '
        + "z" * 200_000
        + "\n",
        "E: " + "z" * 200_000 + "\n",
    )
    assert "z" * 200_000 not in traceback_text
    assert len(message.encode("utf-8")) < runner.MAX_FAILURE_MESSAGE_BYTES + 400
    assert traceback_text.startswith("Traceback")
    short_message, short_tb = runner._bound_failure(
        "E: boom", "Traceback\n  File 'a'\nE: boom\n", "E: boom\n"
    )
    assert short_message == "E: boom"
    assert short_tb.endswith("E: boom\n")


def test_a_huge_chained_exception_bounds_the_traceback_and_keeps_the_last_frames(
    tmp_path: Path, code_dir: Path
) -> None:
    """说明很短、堆栈很长（异常链里前一条异常的文字有 1 MiB，在堆栈中间）：
    堆栈限到 64 KiB，只留最后的几帧，说明一个字不变；省掉的东西前面写明了多少。"""
    write_module(
        code_dir,
        "chained",
        f"""
        def work(size: int) -> dict:
            try:
                raise ValueError("a" * size)
            except ValueError as error:
                raise RuntimeError("最后的") from error  {RAISED_HERE}
        """,
    )

    _, error = failed(tmp_path, code_dir, "chained:work", inputs={"size": 1024 * 1024})

    assert error["message"] == "RuntimeError: 最后的"
    traceback_text = error["traceback"]
    assert len(traceback_text.encode("utf-8")) < runner.MAX_FAILURE_TRACEBACK_BYTES + 400
    assert traceback_text.startswith("…（堆栈有 ")
    assert "没有保留，只留最后的几帧" in traceback_text
    # 最后的一帧（节点里 raise 的那一行）还在
    assert 'raise RuntimeError("最后的") from error' in traceback_text
    assert error["location"] == f"chained.work 第 {raised_line(code_dir, 'chained')} 行"


def test_a_traceback_over_the_limit_is_cut_in_failure_results_too() -> None:
    """限长在 `_bound_failure` 里生效：堆栈超过上限时只留最后几帧，说明不动。"""
    frames = "".join(
        f'  File "/code/m.py", line {i}, in f{i}\n    call_{i}()\n' for i in range(1, 3001)
    )
    own = "ValueError: boom\n"
    tb = "Traceback (most recent call last):\n" + frames + own

    message, bounded = runner._bound_failure("ValueError: boom", tb, own)

    assert message == "ValueError: boom"
    assert len(bounded.encode("utf-8")) < runner.MAX_FAILURE_TRACEBACK_BYTES + 400
    assert bounded.startswith("…（堆栈有 ")
    assert "call_3000()" in bounded and "call_1()" not in bounded
