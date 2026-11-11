"""`watch_files`：持续把另一台 Agent 上符合条件的文件拉到本地目录（`sfly.testing.run_node`）。

来源 Agent `a-01` 映射到临时目录（`run_node(agents=...)`）：它上面的 `/var/log/app` 落在
`<临时目录>/a/var/log/app`，节点看到的路径仍是 `/var/log/app/...`。监听用本机的 inotify。
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from sfly.testing import Execution, run_node
from sfly_std.watch_files import watch_files

SOURCE = "a-01"
#: 来源 Agent 上的目录（那台 Agent 上的绝对路径）。
LOGS = "/var/log/app"


def source_dir(tmp_path: Path, files: dict[str, bytes] | None = None) -> Path:
    """来源 Agent 上的 `LOGS` 在本机上的位置，先建好 `files`。"""
    logs = tmp_path / "a" / LOGS.lstrip("/")
    logs.mkdir(parents=True, exist_ok=True)
    for name, data in (files or {}).items():
        (logs / name).write_bytes(data)
    return logs


def run(tmp_path: Path, **kwargs: Any) -> Execution:
    inputs = {"source": SOURCE, "directory": LOGS, "local_dir": str(tmp_path / "pulled")}
    inputs.update(kwargs.pop("inputs", {}))
    return run_node(
        watch_files,
        inputs,
        work_dir=tmp_path / "task",
        agents={SOURCE: tmp_path / "a"},
        **kwargs,
    )


Script = Callable[[], object]
OnceWatching = Callable[[Script, Callable[[Execution], bool]], Callable[[Execution], bool]]


@pytest.fixture
def once_watching() -> Iterator[OnceWatching]:
    """给 run_node 的 cancel_when：节点打出「监听……」日志后在后台线程里执行一次脚本；
    脚本执行完、`done(到目前为止的结果)` 为真时取消（模拟被停止子流程节点停止）。
    测试结束时等线程结束。"""
    threads: list[threading.Thread] = []

    def make(script: Script, done: Callable[[Execution], bool]) -> Callable[[Execution], bool]:
        def tick(partial: Execution) -> bool:
            if not threads and any(line.message.startswith("监听") for line in partial.logs):
                thread = threading.Thread(target=script)
                thread.start()
                threads.append(thread)
            return bool(threads) and not threads[0].is_alive() and done(partial)

        return tick

    yield make
    for thread in threads:
        thread.join()


def pulled_logs(result: Execution) -> list[str]:
    """「拉取了 <路径>（…）」日志里的源文件路径，按拉取的顺序。"""
    return [
        line.message.removeprefix("拉取了 ").split("（", 1)[0]
        for line in result.logs
        if line.message.startswith("拉取了 /")
    ]


def test_pulls_the_matching_files_already_there_and_outputs_the_counts_when_duration_ends(
    tmp_path: Path,
) -> None:
    source_dir(
        tmp_path,
        {"app.log.1": b"first\n", "app.log.2": "第二个\n".encode(), "app.log": b"writing"},
    )

    result = run(tmp_path, inputs={"pattern": "app.log.*", "duration": 1})

    assert result.status == "success", result.error
    local = tmp_path / "pulled"
    assert sorted(p.name for p in local.iterdir()) == ["app.log.1", "app.log.2"]
    assert (local / "app.log.1").read_bytes() == b"first\n"
    assert (local / "app.log.2").read_text(encoding="utf-8") == "第二个\n"
    assert result.outputs == {"count": 2, "total_bytes": 6 + len("第二个\n".encode())}


def test_files_rotated_while_watching_are_pulled_once_until_stopped(
    tmp_path: Path,
    once_watching: OnceWatching,
) -> None:
    # 按序号轮转：app.log 写满后改名为 app.log.1（之前的 app.log.1 先改名为 app.log.2），
    # 再新建 app.log 接着写。改名不改变文件标识，所以 app.log.1 → app.log.2 不会再拉一次。
    logs = source_dir(tmp_path, {"app.log": b"round 1\n"})
    local = tmp_path / "pulled"

    def rotate() -> None:
        (logs / "app.log").rename(logs / "app.log.1")
        (logs / "app.log").write_bytes(b"round 2\n")
        wait_for(lambda: (local / "app.log.1").exists())
        (logs / "app.log.1").rename(logs / "app.log.2")
        (logs / "app.log").rename(logs / "app.log.1")
        (logs / "app.log").write_bytes(b"round 3\n")

    result = run(
        tmp_path,
        inputs={"pattern": "app.log.*"},
        cancel_when=once_watching(rotate, lambda partial: len(pulled_logs(partial)) == 2),
    )

    # 被停止（这里是取消）时节点正常结束：已经拉下来的文件都在。
    assert result.status == "cancelled", result.error
    assert pulled_logs(result) == [f"{LOGS}/app.log.1", f"{LOGS}/app.log.1"]
    # 第二次的 app.log.1 是另一个文件，本次拉下来的第一个还在本地，不覆盖它。
    assert sorted(p.name for p in local.iterdir()) == ["app.log.1", "app.log.1.~1~"]
    assert (local / "app.log.1").read_bytes() == b"round 1\n"
    assert (local / "app.log.1.~1~").read_bytes() == b"round 2\n"


def test_a_file_still_being_written_is_pulled_only_after_it_has_not_changed_for_stable_seconds(
    tmp_path: Path, once_watching: OnceWatching
) -> None:
    # app.log 每 0.1 秒追加一行、共 1.5 秒，stable 为 0.5：写入期间一直不满足条件，
    # 停止写入 0.5 秒后才拉取，拉下来的是完整的内容，只拉一次。
    logs = source_dir(tmp_path, {"app.log": b""})
    lines = [f"line {i}\n".encode() for i in range(15)]

    def write() -> None:
        for line in lines:
            with (logs / "app.log").open("ab") as f:
                f.write(line)
            time.sleep(0.1)

    local = tmp_path / "pulled" / "app.log"

    def complete(partial: Execution) -> bool:
        full = b"".join(lines)
        return bool(pulled_logs(partial)) and local.exists() and local.read_bytes() == full

    result = run(
        tmp_path,
        inputs={"pattern": "*.log", "stable": 0.5},
        cancel_when=once_watching(write, lambda partial: complete(partial)),
    )

    assert result.status == "cancelled", result.error
    assert pulled_logs(result) == [f"{LOGS}/app.log"]
    assert local.read_bytes() == b"".join(lines)


def test_delete_source_deletes_each_file_after_pulling_it(tmp_path: Path) -> None:
    logs = source_dir(tmp_path, {"app.log.1": b"1", "app.log.2": b"22", "app.log": b"now"})

    result = run(tmp_path, inputs={"pattern": "app.log.*", "delete_source": True, "duration": 1})

    assert result.status == "success", result.error
    assert sorted(p.name for p in (tmp_path / "pulled").iterdir()) == ["app.log.1", "app.log.2"]
    assert sorted(p.name for p in logs.iterdir()) == ["app.log"]
    assert result.outputs == {"count": 2, "total_bytes": 3}


def test_a_pulled_file_that_grows_is_pulled_again_and_replaces_the_local_copy(
    tmp_path: Path, once_watching: OnceWatching
) -> None:
    # 去重按「文件标识 + 大小」：同一个文件变大了算新的内容，再拉一次，替换本地的那份。
    logs = source_dir(tmp_path, {"data.csv": b"a\n"})
    local = tmp_path / "pulled" / "data.csv"

    def append() -> None:
        wait_for(local.exists)
        with (logs / "data.csv").open("ab") as f:
            f.write(b"b\n")

    result = run(
        tmp_path,
        cancel_when=once_watching(append, lambda partial: len(pulled_logs(partial)) == 2),
    )

    assert result.status == "cancelled", result.error
    assert pulled_logs(result) == [f"{LOGS}/data.csv", f"{LOGS}/data.csv"]
    assert [p.name for p in local.parent.iterdir()] == ["data.csv"]
    assert local.read_bytes() == b"a\nb\n"


def test_reports_the_pulled_files_bytes_and_rate_as_metrics(tmp_path: Path) -> None:
    source_dir(tmp_path, {"a.log": b"a" * 1000, "b.log": b"b" * 24})

    result = run(tmp_path, inputs={"duration": 1.5})

    assert result.status == "success", result.error
    series: dict[str, list[float]] = {}
    for point in result.metrics:
        series.setdefault(point.name, []).append(point.value)
    assert set(series) == {"pulled_files", "pulled_bytes", "bytes_per_s"}
    assert series["pulled_files"][-1] == 2
    assert series["pulled_bytes"][-1] == 1024
    assert sum(series["bytes_per_s"]) > 0
    assert {p.kind for p in result.metrics if p.name != "bytes_per_s"} == {"counter"}


#: 取消测试里拉取的大文件：稀疏文件，在来源上不占磁盘；取消前只写下开头的一小部分。
BIG = 2 * 1024 * 1024 * 1024


def test_stopping_in_the_middle_of_a_download_leaves_no_partial_file(tmp_path: Path) -> None:
    logs = source_dir(tmp_path, {"a.log": b"a" * 100})
    with open(logs / "b.log", "wb") as f:
        f.truncate(BIG)
    local = tmp_path / "pulled"

    result = run(
        tmp_path,
        inputs={"delete_source": True},
        # a.log 拉完之后、b.log 的临时文件已经出现（正在下载）时取消。
        cancel_when=lambda partial: (
            bool(pulled_logs(partial)) and any(local.glob(".b.log.sfly-*.tmp"))
        ),
    )

    assert result.status == "cancelled", result.error
    assert sorted(p.name for p in local.iterdir()) == ["a.log"]
    assert sorted(p.name for p in logs.iterdir()) == ["b.log"]


def test_fails_when_the_directory_does_not_exist_on_the_source_agent(tmp_path: Path) -> None:
    (tmp_path / "a").mkdir()

    result = run(tmp_path, inputs={"duration": 1})

    assert result.status == "failed"
    assert result.error is not None
    assert "AgentFileNotFound" in result.error.message, result.error.message
    assert "/var/log/app" in result.error.message, result.error.message


@pytest.mark.parametrize(
    ("inputs", "message"),
    [
        ({"duration": 0}, "duration 必须大于 0"),
        ({"stable": -1}, "stable 不能小于 0"),
        ({"local_dir": ""}, "local_dir 不能为空"),
    ],
)
def test_rejects_invalid_parameters(tmp_path: Path, inputs: dict[str, Any], message: str) -> None:
    source_dir(tmp_path)

    result = run(tmp_path, inputs=inputs)

    assert result.status == "failed"
    assert result.error is not None
    assert message in result.error.message, result.error.message


def wait_for(check: Callable[[], bool], timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)
