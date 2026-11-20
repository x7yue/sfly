from pathlib import Path

from sfly.testing import run_node

from svc_probe.access import access_stats


def write_log(root: Path, text: str) -> None:
    log = root / "var/log/access.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(text)


def test_stats(tmp_path: Path) -> None:
    write_log(
        tmp_path,
        "t INFO GET /a 200 10.0ms\n\nt INFO GET /a 200 30.5ms\nt WARN GET /b 500 20.0ms\n",
    )
    result = run_node(
        access_stats, {"source": "box", "path": "/var/log/access.log"}, agents={"box": tmp_path}
    )
    assert result.status == "success", result.error
    assert result.outputs == {"total": 3, "status_counts": {"200": 2, "500": 1}, "p95_ms": 30.5}
    assert [a.name for a in result.actions] == ["读取访问日志"]


def test_missing_log(tmp_path: Path) -> None:
    result = run_node(
        access_stats, {"source": "box", "path": "/var/log/none.log"}, agents={"box": tmp_path}
    )
    assert result.status == "failed"
