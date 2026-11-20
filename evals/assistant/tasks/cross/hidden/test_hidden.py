"""题目「跨机器」里助手看不到的断言：按节点名找到 access_stats，用 sfly.testing 模拟另一台 Agent。

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
    found = next((n for n in nodes if n["name"] == "access_stats"), None)
    assert found is not None, "节点包里没有名为 access_stats 的节点"
    return found


def run(meta: dict[str, Any], root: Path, text: str | None) -> Any:
    if text is not None:
        log = root / "logs/access.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(text)
    return run_node(
        meta["entry"], {"source": "far", "path": "/logs/access.log"}, agents={"far": root}
    )


def test_title(meta: dict[str, Any]) -> None:
    assert meta["title"] == "统计访问日志"


def test_reads_from_the_other_agent(meta: dict[str, Any], tmp_path: Path) -> None:
    lines = [f"t INFO GET /x 200 {n}.0ms" for n in range(1, 21)]
    lines[3] = "t WARN GET /y 404 4.0ms"
    result = run(meta, tmp_path, "\n".join(lines) + "\n\n")
    assert result.status == "success", result.error
    assert result.outputs["total"] == 20
    assert result.outputs["status_counts"] == {"200": 19, "404": 1}
    # ⌈0.95 × 20⌉ = 19，第 19 小的是 19.0
    assert result.outputs["p95_ms"] == pytest.approx(19.0)


def test_p95_rank_rounds_up(meta: dict[str, Any], tmp_path: Path) -> None:
    lines = [f"t INFO GET /x 200 {n}.5ms" for n in (7, 3, 9, 1, 5)]
    result = run(meta, tmp_path, "\n".join(lines))
    # ⌈0.95 × 5⌉ = 5，取最大的 9.5
    assert result.outputs["p95_ms"] == pytest.approx(9.5)


def test_empty_log(meta: dict[str, Any], tmp_path: Path) -> None:
    result = run(meta, tmp_path, "")
    assert result.status == "success", result.error
    assert result.outputs["total"] == 0
    assert result.outputs["status_counts"] == {}
    assert result.outputs["p95_ms"] == 0


def test_missing_log_fails(meta: dict[str, Any], tmp_path: Path) -> None:
    assert run(meta, tmp_path, None).status == "failed"


def test_records_an_action(meta: dict[str, Any], tmp_path: Path) -> None:
    result = run(meta, tmp_path, "t INFO GET /x 200 1.0ms\n")
    assert [a for a in result.actions if a.kind == "action"]
