"""`follow_log`：把日志文件新增的行实时转为任务日志（`sfly.testing.run_node`，真实的临时文件）。"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from sfly.testing import Execution, run_node
from sfly_std.follow_log import follow_log

Script = Callable[[], object]


@pytest.fixture
def once_following() -> Iterator[Callable[[Script], Callable[[Execution], bool]]]:
    """给 run_node 的 cancel_when：节点打出「跟随……」日志（已经记下从哪里开始读）后，
    在后台线程里执行一次脚本，从不取消。测试结束时等线程结束。"""
    threads: list[threading.Thread] = []

    def make(script: Script) -> Callable[[Execution], bool]:
        def tick(partial: Execution) -> bool:
            if not threads and any(line.message.startswith("跟随") for line in partial.logs):
                thread = threading.Thread(target=script)
                thread.start()
                threads.append(thread)
            return False

        return tick

    yield make
    for thread in threads:
        thread.join()


def append(path: Path, text: str) -> None:
    with path.open("a", encoding="utf-8") as f:
        f.write(text)


def forwarded(result: Execution) -> list[str]:
    return [line.message for line in result.logs if line.source == "stdout"]


def test_forwards_new_lines_until_duration_runs_out(
    tmp_path: Path, once_following: Callable[[Script], Callable[[Execution], bool]]
) -> None:
    log = tmp_path / "app.log"
    log.write_text("节点开始前的旧日志\n")

    started = time.monotonic()
    result = run_node(
        follow_log,
        {"path": str(log), "duration": 1},
        cancel_when=once_following(lambda: append(log, "第一行\n第二行\n")),
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    assert forwarded(result) == ["第一行", "第二行"]
    assert result.outputs == {"lines": 2}
    assert 1 <= time.monotonic() - started < 5


def test_read_from_start_forwards_existing_lines_first(tmp_path: Path) -> None:
    log = tmp_path / "app.log"
    log.write_text("已有一\n已有二\n")

    result = run_node(
        follow_log, {"path": str(log), "read_from": "start", "duration": 0.3}, work_dir=tmp_path
    )

    assert result.status == "success", result.error
    assert forwarded(result) == ["已有一", "已有二"]


def test_fails_when_a_line_matches_fail_on(
    tmp_path: Path, once_following: Callable[[Script], Callable[[Execution], bool]]
) -> None:
    log = tmp_path / "app.log"
    log.write_text("")

    result = run_node(
        follow_log,
        {"path": str(log), "fail_on": ["panic", r"ERROR\b"]},
        cancel_when=once_following(
            lambda: append(log, "ok\nERRORS: 0\nERROR 磁盘已满\nWARN 慢\nERROR 写入失败\n")
        ),
        work_dir=tmp_path,
    )

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message == (
        f"sfly_std.follow_log.FailOnMatched: 日志 {log} 出现匹配 fail_on ERROR\\b 的行"
        "（共 2 行匹配）：ERROR 磁盘已满"
    )
    # 同一批读到的行都已转发，失败的那一行之后的也在。
    assert forwarded(result) == ["ok", "ERRORS: 0", "ERROR 磁盘已满", "WARN 慢", "ERROR 写入失败"]
    fail_matches = [m.value for m in result.metrics if m.name == "fail_matches"]
    assert fail_matches[-1] == 2


def test_keeps_following_after_the_file_is_rotated(
    tmp_path: Path, once_following: Callable[[Script], Callable[[Execution], bool]]
) -> None:
    log = tmp_path / "app.log"
    log.write_text("")

    def rotate() -> None:
        append(log, "轮转前\n")
        os.rename(log, tmp_path / "app.log.1")
        append(tmp_path / "app.log.1", "旧文件里最后一行\n")
        time.sleep(0.5)
        append(log, "新文件第一行\n")
        time.sleep(0.5)
        append(log, "新文件第二行\n")

    result = run_node(
        follow_log,
        {"path": str(log), "duration": 2},
        cancel_when=once_following(rotate),
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    assert forwarded(result) == ["轮转前", "旧文件里最后一行", "新文件第一行", "新文件第二行"]


def test_keeps_following_after_the_file_is_truncated(
    tmp_path: Path, once_following: Callable[[Script], Callable[[Execution], bool]]
) -> None:
    log = tmp_path / "app.log"
    log.write_text("")

    def truncate() -> None:
        append(log, "截断前一\n截断前二\n")
        time.sleep(0.5)
        with log.open("r+") as f:  # 与 logrotate 的 copytruncate 相同：原地截断
            f.truncate(0)
        append(log, "截断后\n")

    result = run_node(
        follow_log,
        {"path": str(log), "duration": 1.5},
        cancel_when=once_following(truncate),
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    assert forwarded(result) == ["截断前一", "截断前二", "截断后"]


def test_cancelling_keeps_the_lines_already_forwarded(tmp_path: Path) -> None:
    log = tmp_path / "app.log"
    log.write_text("第一行\n第二行\n")

    result = run_node(
        follow_log,
        {"path": str(log), "read_from": "start"},
        cancel_when=lambda partial: "第二行" in forwarded(partial),
        work_dir=tmp_path,
    )

    assert result.status == "cancelled"
    assert forwarded(result) == ["第一行", "第二行"]


def test_reports_lines_per_second(
    tmp_path: Path, once_following: Callable[[Script], Callable[[Execution], bool]]
) -> None:
    log = tmp_path / "app.log"
    log.write_text("")

    result = run_node(
        follow_log,
        {"path": str(log), "duration": 2.5},
        cancel_when=once_following(lambda: append(log, "".join(f"{i}\n" for i in range(30)))),
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    rates = [m.value for m in result.metrics if m.name == "lines_per_s"]
    # 每秒上报一次：30 行落在某一秒里（这一秒的窗口至少 1 秒），其余秒为 0。
    assert len(rates) >= 2
    assert 20 <= max(rates) <= 30
    assert min(rates) == 0
    assert {m.kind for m in result.metrics if m.name == "fail_matches"} == {"counter"}


def test_an_invalid_fail_on_pattern_fails_at_once(tmp_path: Path) -> None:
    result = run_node(
        follow_log,
        {"path": str(tmp_path / "app.log"), "fail_on": ["ERROR", "("]},
        work_dir=tmp_path,
    )

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message.startswith(
        "ValueError: fail_on 第 2 条不是合法的正则表达式：'('（missing ), unterminated subpattern"
    ), result.error.message
