"""产物上限随任务下发（#477）：Agent 把控制面配置的上限（每个任务的产物合计）交给执行器，
节点里 `ctx.artifacts.limit_bytes` 读到它；`ctx.artifacts.save` 在保存时检查，会让合计超限的文件
不写，抛出 `sfly.ArtifactLimitExceeded`，节点可以接住后改成把文件留在本机。本地调试和
`sfly.testing` 没有上限。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any

import pytest

import sfly
from sfly import ArtifactLimitExceeded, Context
from sfly.testing import run_node

SDK_SRC = Path(__file__).resolve().parents[1] / "src"


def context(tmp_path: Path, limit: int | None) -> Context:
    return Context(
        events_path=None,
        cancel_path=None,
        artifacts_dir=tmp_path / "artifacts",
        artifacts_url=None,
        artifact_limit_bytes=limit,
    )


def files_in(tmp_path: Path) -> dict[str, int]:
    root = tmp_path / "artifacts"
    return {
        str(p.relative_to(root)): p.stat().st_size for p in sorted(root.rglob("*")) if p.is_file()
    }


def test_the_exception_is_exported_from_the_top_level_package() -> None:
    assert "ArtifactLimitExceeded" in sfly.__all__
    assert issubclass(ArtifactLimitExceeded, Exception)


def test_limit_bytes_is_what_the_agent_passed_and_read_only(tmp_path: Path) -> None:
    ctx = context(tmp_path, 1000)

    assert ctx.artifacts.limit_bytes == 1000
    with pytest.raises(AttributeError):
        ctx.artifacts.limit_bytes = 5  # type: ignore[misc]


def test_there_is_no_limit_when_none_was_passed(tmp_path: Path) -> None:
    ctx = context(tmp_path, None)

    assert ctx.artifacts.limit_bytes is None
    ctx.artifacts.save("big.bin", b"x" * 10_000)
    assert files_in(tmp_path) == {"big.bin": 10_000}


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("1000", 1000),
        ("1073741824", 1073741824),
        ("0", None),
        ("-5", None),
        ("abc", None),
        ("", None),
    ],
)
def test_the_limit_is_read_from_the_environment_the_agent_sets(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, value: str, expected: int | None
) -> None:
    monkeypatch.setenv("SFLY_ARTIFACT_LIMIT_BYTES", value)

    ctx = Context(events_path=None, cancel_path=None, artifacts_dir=tmp_path, artifacts_url=None)

    assert ctx.artifacts.limit_bytes == expected


def test_without_the_environment_variable_there_is_no_limit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("SFLY_ARTIFACT_LIMIT_BYTES", raising=False)

    ctx = Context(events_path=None, cancel_path=None, artifacts_dir=tmp_path, artifacts_url=None)

    assert ctx.artifacts.limit_bytes is None


def test_saving_a_file_that_would_exceed_the_total_raises_and_leaves_no_file(
    tmp_path: Path,
) -> None:
    ctx = context(tmp_path, 1000)
    ctx.artifacts.save("a.bin", b"x" * 600)

    with pytest.raises(ArtifactLimitExceeded) as raised:
        ctx.artifacts.save("b.bin", b"y" * 600)

    # 超限的文件没有留在产物目录里，之前保存的不受影响。
    assert files_in(tmp_path) == {"a.bin": 600}
    error = raised.value
    assert (error.name, error.size, error.saved, error.limit) == ("b.bin", 600, 600, 1000)
    message = str(error)
    # 消息写明这个文件多大、已保存多少、上限多少，和怎么办。
    assert "b.bin" in message
    assert "600 字节" in message
    assert "1000 字节" in message
    assert "SFLY_ARTIFACT_LIMIT_MB" in message
    assert "limit_bytes" in message


def test_the_total_may_reach_the_limit_exactly(tmp_path: Path) -> None:
    ctx = context(tmp_path, 1000)

    ctx.artifacts.save("a.bin", b"x" * 400)
    ctx.artifacts.save("b.bin", b"y" * 600)

    assert files_in(tmp_path) == {"a.bin": 400, "b.bin": 600}


def test_text_and_files_count_by_their_size_in_bytes(tmp_path: Path) -> None:
    ctx = context(tmp_path, 10)
    source = tmp_path / "source.bin"
    source.write_bytes(b"z" * 8)

    # 「汉字」按 UTF-8 是 6 字节。
    ctx.artifacts.save("text.txt", "汉字")
    with pytest.raises(ArtifactLimitExceeded) as from_path:
        ctx.artifacts.save("copy.bin", source)
    with pytest.raises(ArtifactLimitExceeded) as from_text:
        ctx.artifacts.save("more.txt", "汉字")

    assert from_path.value.size == 8
    assert from_text.value.size == 6
    assert files_in(tmp_path) == {"text.txt": 6}


def test_saving_under_an_existing_name_replaces_it_so_only_the_new_size_counts(
    tmp_path: Path,
) -> None:
    ctx = context(tmp_path, 1000)
    ctx.artifacts.save("a.bin", b"x" * 900)

    ctx.artifacts.save("a.bin", b"y" * 950)
    with pytest.raises(ArtifactLimitExceeded):
        ctx.artifacts.save("a.bin", b"z" * 1001)

    # 超限的那次没有覆盖原来的文件。
    assert files_in(tmp_path) == {"a.bin": 950}


def test_files_written_straight_into_the_directory_count_too(tmp_path: Path) -> None:
    ctx = context(tmp_path, 1000)
    ctx.artifacts.path("sub/direct.bin").write_bytes(b"x" * 700)

    with pytest.raises(ArtifactLimitExceeded) as raised:
        ctx.artifacts.save("b.bin", b"y" * 400)

    assert raised.value.saved == 700
    assert files_in(tmp_path) == {"sub/direct.bin": 700}


def test_the_node_can_catch_it_and_carry_on(tmp_path: Path) -> None:
    ctx = context(tmp_path, 1000)
    kept_on_machine = []

    for name, size in [("a.bin", 600), ("b.bin", 600), ("c.bin", 300)]:
        try:
            ctx.artifacts.save(name, b"x" * size)
        except ArtifactLimitExceeded as error:
            kept_on_machine.append(error.name)

    assert kept_on_machine == ["b.bin"]
    assert files_in(tmp_path) == {"a.bin": 600, "c.bin": 300}


def test_a_node_can_look_before_saving(tmp_path: Path) -> None:
    ctx = context(tmp_path, 1000)

    assert ctx.artifacts.limit_bytes is not None
    assert 1200 > ctx.artifacts.limit_bytes  # 估计的大小超过上限：不保存，留在本机


def test_run_node_has_no_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.syspath_prepend(str(Path(__file__).parent))
    import artifact_nodes

    result = run_node(artifact_nodes.probe_limit)

    assert result.status == "success", result.error
    assert result.outputs == {"limit": None}


def test_run_node_has_no_limit_even_when_the_parent_environment_has_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """本地调试和 run_node 不继承父进程的 SFLY_*（和 `sfly debug` 一样）：没有上限。"""
    monkeypatch.syspath_prepend(str(Path(__file__).parent))
    monkeypatch.setenv("SFLY_ARTIFACT_LIMIT_BYTES", "1000")
    import artifact_nodes

    result = run_node(artifact_nodes.probe_limit)

    assert result.status == "success", result.error
    assert result.outputs == {"limit": None}


def run_runner(tmp_path: Path, source: str, env: dict[str, str]) -> dict[str, Any]:
    code = tmp_path / "code"
    code.mkdir()
    (code / "limitnode.py").write_text(textwrap.dedent(source), encoding="utf-8")
    work = tmp_path / "work"
    work.mkdir()
    task = work / "task.json"
    task.write_text(
        json.dumps({"task_id": "t-1", "attempt": 1, "entry": "limitnode:work", "inputs": {}}),
        encoding="utf-8",
    )
    output = work / "output.json"
    merged = {
        **{k: v for k, v in os.environ.items() if not k.startswith("SFLY_")},
        "PYTHONPATH": os.pathsep.join([str(SDK_SRC), str(code)]),
        "SFLY_TASK": str(task),
        "SFLY_OUTPUT": str(output),
        "SFLY_ARTIFACTS": str(work / "artifacts"),
        **env,
    }
    subprocess.run(
        [sys.executable, "-m", "sfly.runner"],
        cwd=work,
        env=merged,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    parsed: dict[str, Any] = json.loads(output.read_text(encoding="utf-8"))
    return parsed


NODE = """
from sfly import ArtifactLimitExceeded, Context

def work(ctx: Context) -> dict:
    try:
        ctx.artifacts.save("big.bin", b"x" * 2000)
        saved = True
    except ArtifactLimitExceeded:
        saved = False
    return {"limit": ctx.artifacts.limit_bytes, "saved": saved}
"""


def test_the_executor_hands_the_limit_from_the_environment_to_the_node(tmp_path: Path) -> None:
    output = run_runner(tmp_path, NODE, {"SFLY_ARTIFACT_LIMIT_BYTES": "1500"})

    assert output == {"status": "success", "outputs": {"limit": 1500, "saved": False}}


def test_the_executor_without_the_variable_means_no_limit(tmp_path: Path) -> None:
    output = run_runner(tmp_path, NODE, {})

    assert output == {"status": "success", "outputs": {"limit": None, "saved": True}}
