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
