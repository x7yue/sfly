from pathlib import Path

from sfly.testing import run_node

from svc_logs.logs import level_counts


def test_counts_levels(tmp_path: Path) -> None:
    log = tmp_path / "app.log"
    log.write_text(
        "t1 INFO started\n"
        "t2 ERROR boom\n"
        "\n"
        "t3 INFO retry after ERROR\n"
        "Traceback (most recent call last):\n"
        "t4 WARN slow\n"
    )
    result = run_node(level_counts, {"path": str(log)})
    assert result.status == "success"
    assert result.outputs == {
        "total": 5,
        "counts": {"INFO": 2, "WARN": 1, "ERROR": 1},
        "error_ratio": 0.2,
    }
    assert [a.name for a in result.actions] == ["读取日志"]


def test_empty_file(tmp_path: Path) -> None:
    log = tmp_path / "empty.log"
    log.write_text("")
    result = run_node(level_counts, {"path": str(log)})
    assert result.outputs == {
        "total": 0,
        "counts": {"INFO": 0, "WARN": 0, "ERROR": 0},
        "error_ratio": 0,
    }


def test_missing_file_fails(tmp_path: Path) -> None:
    missing = tmp_path / "nope.log"
    result = run_node(level_counts, {"path": str(missing)})
    assert result.status == "failed"
    assert result.error is not None
    assert str(missing) in result.error.message
