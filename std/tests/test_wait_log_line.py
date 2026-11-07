"""`wait_log_line`：等日志文件里出现匹配的行（`sfly.testing.run_node`，真实的临时文件）。"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path

from sfly.testing import Execution, run_node
from sfly_std.wait_log_line import wait_log_line


def once_waiting(action: Callable[[], object]) -> Callable[[Execution], bool]:
    """给 run_node 的 cancel_when：节点打出「等待……」日志（已经记下从哪里开始读）后执行一次
    `action`，从不取消。"""
    done = False

    def tick(partial: Execution) -> bool:
        nonlocal done
        if not done and any(line.message.startswith("等待") for line in partial.logs):
            done = True
            action()
        return False

    return tick


def append(path: Path, text: str) -> Callable[[], None]:
    def run() -> None:
        with path.open("a", encoding="utf-8") as f:
            f.write(text)

    return run


def test_outputs_the_first_new_line_that_matches(tmp_path: Path) -> None:
    log = tmp_path / "app.log"
    log.write_text("")

    result = run_node(
        wait_log_line,
        {"path": str(log), "pattern": r"listening on :\d+", "poll": 0.1},
        cancel_when=once_waiting(
            append(log, "starting\nlistening on :8080 (worker 1)\nlistening on :8081\n")
        ),
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    assert result.outputs == {"line": "listening on :8080 (worker 1)"}


def test_ignores_lines_written_before_the_node_started_by_default(tmp_path: Path) -> None:
    log = tmp_path / "app.log"
    log.write_text("ready (上一次启动)\n")

    result = run_node(
        wait_log_line,
        {"path": str(log), "pattern": "ready", "poll": 0.1},
        cancel_when=once_waiting(append(log, "loading\nready (这一次)\n")),
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    assert result.outputs == {"line": "ready (这一次)"}


def test_read_from_start_also_matches_existing_lines(tmp_path: Path) -> None:
    log = tmp_path / "app.log"
    log.write_text("loading\nready (已有)\n")

    result = run_node(
        wait_log_line,
        {"path": str(log), "pattern": "ready", "read_from": "start", "wait": 0},
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    assert result.outputs == {"line": "ready (已有)"}


def test_a_file_that_appears_later_is_read_from_its_beginning(tmp_path: Path) -> None:
    log = tmp_path / "logs" / "app.log"

    def create() -> None:
        log.parent.mkdir()
        log.write_text("ready\n")

    result = run_node(
        wait_log_line,
        {"path": str(log), "pattern": "^ready$", "poll": 0.1},
        cancel_when=once_waiting(create),
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    assert result.outputs == {"line": "ready"}


def test_matches_only_complete_lines(tmp_path: Path) -> None:
    log = tmp_path / "app.log"
    log.write_text("")

    def write_slowly() -> None:
        append(log, "服务 已")()
        time.sleep(0.3)
        append(log, "启动\n")()

    result = run_node(
        wait_log_line,
        {"path": str(log), "pattern": "服务", "poll": 0.1},
        cancel_when=once_waiting(write_slowly),
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    assert result.outputs == {"line": "服务 已启动"}


def test_fails_after_wait_saying_what_it_waited_for(tmp_path: Path) -> None:
    log = tmp_path / "app.log"
    log.write_text("ready\n")

    result = run_node(
        wait_log_line,
        {"path": str(log), "pattern": "ready", "wait": 0.3, "poll": 0.1},
        work_dir=tmp_path,
    )

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message == (
        f"TimeoutError: 等待日志 {log} 出现匹配 ready 的行超时：已等 0.3 秒"
    )


def test_the_timeout_says_when_the_file_does_not_exist(tmp_path: Path) -> None:
    log = tmp_path / "missing.log"

    result = run_node(
        wait_log_line, {"path": str(log), "pattern": "ready", "wait": 0}, work_dir=tmp_path
    )

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message.startswith(
        f"TimeoutError: 等待日志 {log} 出现匹配 ready 的行超时：已等 0 秒，文件不存在"
    ), result.error.message


def test_an_invalid_pattern_fails_before_waiting(tmp_path: Path) -> None:
    result = run_node(
        wait_log_line, {"path": str(tmp_path / "app.log"), "pattern": "("}, work_dir=tmp_path
    )

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message.startswith(
        "ValueError: pattern 不是合法的正则表达式：'('（missing ), unterminated subpattern"
    ), result.error.message
