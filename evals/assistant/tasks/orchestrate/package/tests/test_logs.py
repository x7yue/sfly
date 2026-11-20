from pathlib import Path

from sfly.testing import run_node

from svc_probe.logs import scan_remote_log


def test_counts_matches_on_other_agent(tmp_path: Path) -> None:
    log = tmp_path / "var/log/app.log"
    log.parent.mkdir(parents=True)
    log.write_text("t INFO a\nt ERROR b\nt ERROR c\nt INFO d")
    result = run_node(
        scan_remote_log,
        {"source": "box", "path": "/var/log/app.log"},
        agents={"box": tmp_path},
    )
    assert result.status == "success", result.error
    assert result.outputs["lines"] == 4
    assert result.outputs["matches"] == 2
    assert result.outputs["samples"] == ["t ERROR b", "t ERROR c"]


def test_missing_file(tmp_path: Path) -> None:
    result = run_node(
        scan_remote_log,
        {"source": "box", "path": "/var/log/none.log"},
        agents={"box": tmp_path},
    )
    assert result.status == "failed"
