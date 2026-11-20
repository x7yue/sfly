"""题目「写」里助手看不到的断言：按节点名找到助手写的节点，用 sfly.testing 执行。

由判分在节点包的 venv 里运行：`AEVAL_PROJECT` 是节点包目录。
"""

import os
from pathlib import Path
from typing import Any

import pytest
from sfly.cli.build import load_project, scan_nodes
from sfly.testing import run_node

PROJECT = Path(os.environ["AEVAL_PROJECT"])


@pytest.fixture(scope="module")
def meta() -> dict[str, Any]:
    nodes = scan_nodes(load_project(PROJECT))
    found = next((n for n in nodes if n["name"] == "level_counts"), None)
    assert found is not None, "节点包里没有名为 level_counts 的节点"
    return found


def run(meta: dict[str, Any], path: Path) -> Any:
    return run_node(meta["entry"], {"path": str(path)})


def test_title(meta: dict[str, Any]) -> None:
    assert meta["title"] == "统计日志级别"


def test_counts_by_field_not_substring(meta: dict[str, Any], tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_text(
        "2026-01-01T00:00:00Z INFO GET / 200\n"
        "2026-01-01T00:00:01Z INFO retry after ERROR from upstream\n"
        "2026-01-01T00:00:02Z ERROR upstream timeout\n"
        "\n"
        "   \n"
        "2026-01-01T00:00:03Z DEBUG tick\n"
        "Traceback (most recent call last):\n"
        "2026-01-01T00:00:04Z WARN slow 900ms\n"
        "2026-01-01T00:00:05Z WARN slow 950ms\n"
        "2026-01-01T00:00:06Z ERROR boom"
    )
    result = run(meta, log)
    assert result.status == "success", result.error
    assert result.outputs["total"] == 8
    assert result.outputs["counts"] == {"INFO": 2, "WARN": 2, "ERROR": 2}
    assert result.outputs["error_ratio"] == pytest.approx(0.25)


def test_rounds_ratio_to_four_places(meta: dict[str, Any], tmp_path: Path) -> None:
    log = tmp_path / "b.log"
    log.write_text("t ERROR a\nt INFO b\nt INFO c\n")
    result = run(meta, log)
    assert result.outputs["error_ratio"] == pytest.approx(0.3333, abs=1e-9)


def test_missing_levels_are_zero(meta: dict[str, Any], tmp_path: Path) -> None:
    log = tmp_path / "c.log"
    log.write_text("t INFO a\n")
    result = run(meta, log)
    assert result.outputs["counts"] == {"INFO": 1, "WARN": 0, "ERROR": 0}
    assert result.outputs["error_ratio"] == 0


def test_empty_file(meta: dict[str, Any], tmp_path: Path) -> None:
    log = tmp_path / "d.log"
    log.write_text("\n\n")
    result = run(meta, log)
    assert result.status == "success", result.error
    assert result.outputs == {
        "total": 0,
        "counts": {"INFO": 0, "WARN": 0, "ERROR": 0},
        "error_ratio": 0,
    }


def test_missing_file_fails_with_path(meta: dict[str, Any], tmp_path: Path) -> None:
    missing = tmp_path / "missing" / "e.log"
    result = run(meta, missing)
    assert result.status == "failed"
    assert result.error is not None
    assert str(missing) in result.error.message


def test_records_an_action(meta: dict[str, Any], tmp_path: Path) -> None:
    log = tmp_path / "f.log"
    log.write_text("t INFO a\n")
    result = run(meta, log)
    assert [a for a in result.actions if a.kind == "action"], "没有用 ctx.action 记录动作"
