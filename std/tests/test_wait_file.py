"""`wait_file`：等文件出现，可选等它稳定（`sfly.testing.run_node`，真实的临时文件）。"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from sfly.testing import run_node
from sfly_std.wait_file import wait_file


@pytest.fixture
def later() -> Iterator[Callable[[float, Callable[[], object]], None]]:
    """`later(秒, 动作)`：在后台线程里过一会儿执行动作；测试结束时等线程结束。"""
    threads: list[threading.Thread] = []

    def schedule(delay: float, action: Callable[[], object]) -> None:
        def run() -> None:
            time.sleep(delay)
            action()

        thread = threading.Thread(target=run)
        thread.start()
        threads.append(thread)

    yield schedule
    for thread in threads:
        thread.join()


def test_succeeds_at_once_when_the_file_exists(tmp_path: Path) -> None:
    target = tmp_path / "ready"
    target.write_text("ok")

    result = run_node(wait_file, {"path": str(target)}, work_dir=tmp_path)

    assert result.status == "success", result.error


def test_waits_until_the_file_appears(
    tmp_path: Path, later: Callable[[float, Callable[[], object]], None]
) -> None:
    target = tmp_path / "ready"
    later(0.5, lambda: target.write_text("ok"))

    started = time.monotonic()
    result = run_node(wait_file, {"path": str(target), "poll": 0.1}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert time.monotonic() - started >= 0.5


def test_relative_paths_are_relative_to_the_task_work_dir(tmp_path: Path) -> None:
    (tmp_path / "out").mkdir()
    (tmp_path / "out" / "done.txt").write_text("ok")

    result = run_node(wait_file, {"path": "out/done.txt", "wait": 0}, work_dir=tmp_path)

    assert result.status == "success", result.error


def test_fails_after_wait_when_the_file_does_not_appear(tmp_path: Path) -> None:
    target = tmp_path / "never"

    result = run_node(wait_file, {"path": str(target), "wait": 0.3, "poll": 0.1}, work_dir=tmp_path)

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message.startswith(
        f"TimeoutError: 等待文件 {target} 出现超时：已等 0.3 秒，文件不存在"
    ), result.error.message


def append_for(target: Path, seconds: float) -> Callable[[], float]:
    """返回一个动作：在 `seconds` 秒内每 0.1 秒给文件追加一行，返回最后一次写入的时刻。"""

    def run() -> float:
        end = last_write = time.monotonic() + seconds
        with target.open("a") as f:
            while time.monotonic() < end:
                f.write("还在写\n")
                f.flush()
                last_write = time.monotonic()
                time.sleep(0.1)
        return last_write

    return run


def test_outputs_the_file_size(tmp_path: Path) -> None:
    target = tmp_path / "ready"
    target.write_text("12345")

    result = run_node(wait_file, {"path": str(target)}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert result.outputs == {"size": 5}


def test_stable_waits_until_the_file_stops_changing(
    tmp_path: Path, later: Callable[[float, Callable[[], object]], None]
) -> None:
    target = tmp_path / "report.csv"
    target.write_text("")
    last_write: list[float] = []
    later(0, lambda: last_write.append(append_for(target, 1.0)()))

    result = run_node(
        wait_file, {"path": str(target), "stable": 0.5, "poll": 0.1}, work_dir=tmp_path
    )
    finished = time.monotonic()

    assert result.status == "success", result.error
    assert result.outputs == {"size": target.stat().st_size}
    assert last_write and finished - last_write[0] >= 0.5


def test_fails_when_the_file_keeps_changing_until_wait_runs_out(
    tmp_path: Path, later: Callable[[float, Callable[[], object]], None]
) -> None:
    target = tmp_path / "report.csv"
    target.write_text("")
    later(0, append_for(target, 1.5))

    result = run_node(
        wait_file,
        {"path": str(target), "stable": 1, "wait": 0.8, "poll": 0.1},
        work_dir=tmp_path,
    )

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message.startswith(
        f"TimeoutError: 等待文件 {target} 出现并稳定 1 秒超时：已等 0.8 秒，文件仍在变化"
    ), result.error.message
