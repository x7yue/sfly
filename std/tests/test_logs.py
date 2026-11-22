"""`sfly_std.logs`：直接调用读日志的辅助函数。"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import pytest
from direct_context import DirectRun

from sfly_std.logs import FOLLOW_METRICS, FailOnMatched, LogFile, follow_log_file, wait_for_log_line


def test_log_file_returns_only_new_complete_lines_and_keeps_a_half_line_for_later(
    tmp_path: Path,
) -> None:
    path = tmp_path / "app.log"
    path.write_text("旧的一行\n")
    log = LogFile(str(path), from_start=False)

    with path.open("a") as f:
        f.write("新的一行\n半")
    assert list(log.lines()) == ["新的一行"]
    with path.open("a") as f:
        f.write("行\n")
    assert list(log.lines()) == ["半行"]


def test_log_file_reads_the_rest_of_the_old_file_and_then_the_new_one_after_rotation(
    tmp_path: Path,
) -> None:
    path = tmp_path / "app.log"
    path.write_text("")
    log = LogFile(str(path), from_start=True)
    with path.open("a") as f:
        f.write("轮转前\n")
    os.rename(path, tmp_path / "app.log.1")
    with (tmp_path / "app.log.1").open("a") as f:
        f.write("旧文件里最后写的\n")
    path.write_text("新文件第一行\n")

    assert list(log.lines()) == ["轮转前", "旧文件里最后写的", "新文件第一行"]


def test_log_file_starts_from_the_beginning_when_the_file_is_truncated(tmp_path: Path) -> None:
    path = tmp_path / "app.log"
    path.write_text("很长的一段旧内容\n" * 5)
    log = LogFile(str(path), from_start=False)
    path.write_text("截断后\n")

    assert list(log.lines()) == ["截断后"]


def test_follow_log_file_forwards_lines_and_returns_the_total(tmp_path: Path) -> None:
    run = DirectRun(tmp_path, metrics=FOLLOW_METRICS)
    path = tmp_path / "app.log"
    path.write_text("已有\n")

    def append() -> None:
        time.sleep(0.4)
        with path.open("a") as f:
            f.write("新一\n新二\n")

    writer = threading.Thread(target=append)
    writer.start()
    try:
        total = follow_log_file(run.ctx, str(path), read_from="start", duration=1.5)
    finally:
        writer.join()

    assert total == 3
    assert run.metric("lines_per_s")


def test_follow_log_file_fails_on_the_first_matching_line(tmp_path: Path) -> None:
    run = DirectRun(tmp_path, metrics=FOLLOW_METRICS)
    path = tmp_path / "app.log"
    path.write_text("一切正常\nERROR 连接断开\n之后的行\n")

    with pytest.raises(FailOnMatched, match="ERROR 连接断开"):
        follow_log_file(run.ctx, str(path), read_from="start", fail_on=["ERROR"], duration=5)
    with pytest.raises(ValueError):
        follow_log_file(run.ctx, str(path), fail_on=["("])


def test_wait_for_log_line_returns_the_first_matching_line(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)
    path = tmp_path / "app.log"

    def append() -> None:
        time.sleep(0.4)
        with path.open("a") as f:
            f.write("启动中\n服务就绪 端口 8080\n")

    writer = threading.Thread(target=append)
    writer.start()
    try:
        line = wait_for_log_line(run.ctx, str(path), r"就绪 端口 (\d+)", wait=10, poll=0.1)
    finally:
        writer.join()

    assert line == "服务就绪 端口 8080"


def test_wait_for_log_line_times_out_naming_the_file_and_the_pattern(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)
    path = tmp_path / "missing.log"

    with pytest.raises(TimeoutError, match=r"missing\.log.*不会出现.*文件不存在"):
        wait_for_log_line(run.ctx, str(path), "不会出现", wait=0.3, poll=0.1)
    with pytest.raises(ValueError):
        wait_for_log_line(run.ctx, str(path), "(", wait=0.1)
