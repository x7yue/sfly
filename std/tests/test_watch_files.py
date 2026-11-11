"""`watch_files`：持续把另一台 Agent 上符合条件的文件拉到本地目录（`sfly.testing.run_node`）。

来源 Agent `a-01` 映射到临时目录（`run_node(agents=...)`）：它上面的 `/var/log/app` 落在
`<临时目录>/a/var/log/app`，节点看到的路径仍是 `/var/log/app/...`。监听用本机的 inotify。
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from sfly import Agent, AgentError, AgentUnreachable, Context, FileId, FileInfo
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


def test_pulls_the_matching_files_already_there(tmp_path: Path) -> None:
    source_dir(
        tmp_path,
        {"app.log.1": b"first\n", "app.log.2": "第二个\n".encode(), "app.log": b"writing"},
    )

    result = run(
        tmp_path,
        inputs={"pattern": "app.log.*"},
        cancel_when=lambda partial: len(pulled_logs(partial)) == 2,
    )

    assert result.status == "cancelled", result.error
    local = tmp_path / "pulled"
    assert sorted(p.name for p in local.iterdir()) == ["app.log.1", "app.log.2"]
    assert (local / "app.log.1").read_bytes() == b"first\n"
    assert (local / "app.log.2").read_text(encoding="utf-8") == "第二个\n"


def test_ends_successfully_when_duration_ends_and_outputs_what_it_pulled(tmp_path: Path) -> None:
    # 到期时拉了几个文件取决于机器快慢：输出和拉下来的文件一致就行。
    source_dir(tmp_path, {"app.log.1": b"first\n", "app.log.2": "第二个\n".encode()})

    result = run(tmp_path, inputs={"pattern": "app.log.*", "duration": 0.5})

    assert result.status == "success", result.error
    local = [p for p in (tmp_path / "pulled").glob("*") if not p.name.startswith(".")]
    assert result.outputs == {
        "count": len(pulled_logs(result)),
        "total_bytes": sum(p.stat().st_size for p in local),
    }
    assert len(local) == len(pulled_logs(result))


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
    # 监听开始后新建 app.log，每隔约 0.05 秒追加一行，stable 为 1：写入期间不满足条件，
    # 停止写入 1 秒后才拉取，拉下来的是完整的内容，只拉一次。
    # 节点只在文件确实有 stable 秒没变时才拉：只有写入线程自己卡住超过 stable 秒（机器负载
    # 很高时），节点才会在中途拉一次，那样时只检查最后拉下来的内容。
    stable = 1.0
    logs = source_dir(tmp_path)
    lines = [f"line {i}\n".encode() for i in range(10)]
    # 相邻两次写入最长隔了多久（从上一次开始写到这一次写完：不短于实际的间隔）。
    longest = [0.0]

    def write() -> None:
        previous: float | None = None
        for line in lines:
            started = time.monotonic()
            with (logs / "app.log").open("ab") as f:
                f.write(line)
            if previous is not None:
                longest[0] = max(longest[0], time.monotonic() - previous)
            previous = started
            time.sleep(0.05)

    local = tmp_path / "pulled" / "app.log"

    def complete(partial: Execution) -> bool:
        full = b"".join(lines)
        return bool(pulled_logs(partial)) and local.exists() and local.read_bytes() == full

    result = run(
        tmp_path,
        inputs={"pattern": "*.log", "stable": stable},
        cancel_when=once_watching(write, lambda partial: complete(partial)),
    )

    assert result.status == "cancelled", result.error
    assert local.read_bytes() == b"".join(lines)
    if longest[0] < stable:
        assert pulled_logs(result) == [f"{LOGS}/app.log"]


def test_delete_source_deletes_each_file_after_pulling_it(tmp_path: Path) -> None:
    logs = source_dir(tmp_path, {"app.log.1": b"1", "app.log.2": b"22", "app.log": b"now"})

    result = run(
        tmp_path,
        inputs={"pattern": "app.log.*", "delete_source": True},
        cancel_when=lambda _: sorted(p.name for p in logs.iterdir()) == ["app.log"],
    )

    assert result.status == "cancelled", result.error
    assert sorted(p.name for p in (tmp_path / "pulled").iterdir()) == ["app.log.1", "app.log.2"]
    assert sorted(p.name for p in logs.iterdir()) == ["app.log"]


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

    result = run(
        tmp_path,
        cancel_when=lambda partial: any(
            p.name == "pulled_files" and p.value == 2 for p in partial.metrics
        ),
    )

    assert result.status == "cancelled", result.error
    series: dict[str, list[float]] = {}
    for point in result.metrics:
        series.setdefault(point.name, []).append(point.value)
    assert set(series) == {"pulled_files", "pulled_bytes", "bytes_per_s"}
    assert series["pulled_files"][-1] == 2
    assert series["pulled_bytes"][-1] == 1024
    assert sum(series["bytes_per_s"]) > 0
    assert {p.kind for p in result.metrics if p.name != "bytes_per_s"} == {"counter"}


class _ChangedThenUnreachable:
    """来源 Agent 的 files：下载时报「源文件在下载期间变了」（kind 为 failed），接着查看它是什么
    原因时连不上了。"""

    def download(self, path: str, target: Path, *, progress: object = None) -> FileInfo:
        raise AgentError(f"Agent {SOURCE}：{path} 在下载期间被截短，下载作废", agent=SOURCE)

    def stat(self, path: str) -> FileInfo:
        raise AgentUnreachable(f"从本机连不上 Agent {SOURCE}", agent=SOURCE)


def test_losing_the_connection_while_checking_why_a_download_failed_retries_later(
    tmp_path: Path,
) -> None:
    # 连不上来源 Agent 时节点不失败（standard-nodes 的 watch_files 一节），之后再拉这个文件。
    from sfly_std.watch_files import RETRY_DELAY, _Files, _LocalNames, _Puller, _Stats

    ctx = Context(events_path=None, cancel_path=None, artifacts_dir=None, artifacts_url=None)
    agent = SimpleNamespace(files=_ChangedThenUnreachable())
    file = FileInfo(f"{LOGS}/app.log.1", 10, 1, FileId(1, 2))
    files = _Files(0.0)
    files.saw(file, changed=True)
    started = time.monotonic()
    puller = _Puller(
        ctx, cast(Agent, agent), files, _Stats(ctx, started), _LocalNames(tmp_path, LOGS), False
    )

    puller.pull(file)

    assert files.next_ready(time.monotonic()) is None
    assert files.next_wake(started) >= started + RETRY_DELAY


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

    result = run(tmp_path)

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


# ---- 在 Agent 上：拉取期间改名 ----
#
# 改名发生在 Agent 下载的途中，本地调试时很难卡准时机：这里让节点照在 Agent 上那样
# 经本地 socket 调用能力，由一个按脚本回复的假 Agent 给出「下载期间被改名」时 Agent 的回复
# （Agent 一侧见 agent/tests/file_read.rs）。

ROTATED = f"{LOGS}/app.log.2"


def info(path: str, size: int = 6) -> dict[str, Any]:
    """那台 Agent 上的一个文件（文件标识固定：改名不变）。"""
    return {"path": path, "size": size, "mtime_ns": 1, "device": 1, "inode": 42}


class ScriptedAgent:
    """假的 Agent 本地 socket：`files.watch` 先给出一份只有 app.log.1 的快照，下载结束后
    再推送 `events`；`files.download` 按 `download` 回复（成功时像 Agent 一样先写好本地文件）；
    记下每个请求。"""

    def __init__(self, path: Path, download: list[dict[str, Any]], events: list[dict[str, Any]]):
        self.path = path
        self.requests: list[dict[str, Any]] = []
        self._download = download
        self._events = events
        self._downloaded = threading.Event()
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(str(path))
        self._server.listen()
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self._server.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn: socket.socket) -> None:
        with conn, conn.makefile("rb") as reader:
            request = json.loads(reader.readline())
            self.requests.append(request)
            method, args = request["method"], request["args"]

            def send(*frames: dict[str, Any]) -> None:
                for value in frames:
                    conn.sendall(json.dumps(value, ensure_ascii=False).encode() + b"\n")

            if method == "files.watch":
                snapshot = {"files": [info(f"{LOGS}/app.log.1")], "first": True, "last": True}
                send({"item": {"snapshot": {**snapshot, "missed": False}}})
                self._downloaded.wait()
                send(*({"item": {"event": event}} for event in self._events))
                reader.read()  # 一直监听，直到节点结束
            elif method == "files.download":
                if "result" in self._download[-1]:
                    local = Path(args["local_path"])
                    local.parent.mkdir(parents=True, exist_ok=True)
                    local.write_bytes(b"round1")
                send({"item": {"downloaded": 6, "size": 6}}, *self._download)
                self._downloaded.set()
            elif method == "files.stat":
                send({"result": info(args["path"])})
            else:
                send({"result": None})

    def methods(self, name: str) -> list[dict[str, Any]]:
        return [r["args"] for r in self.requests if r["method"] == name]

    def close(self) -> None:
        self._server.close()


def run_on_agent(work: Path, agent: Path, **inputs: Any) -> tuple[dict[str, Any], list[str]]:
    """像 Agent 那样在子进程里执行 watch_files（节点经 `agent` 这个本地 socket 调用能力），
    返回 output.json 和日志。"""
    work.mkdir()
    task = {
        "task_id": "t-1",
        "attempt": 1,
        "entry": "sfly_std.watch_files:watch_files",
        "inputs": {
            "source": SOURCE,
            "directory": LOGS,
            "local_dir": str(work / "pulled"),
            **inputs,
        },
    }
    (work / "task.json").write_text(json.dumps(task), encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith("SFLY_")}
    env.update(
        SFLY_TASK=str(work / "task.json"),
        SFLY_OUTPUT=str(work / "output.json"),
        SFLY_EVENTS=str(work / "events.jsonl"),
        SFLY_CANCEL=str(work / "cancel"),
        SFLY_AGENT_SOCKET=str(agent),
    )
    subprocess.run([sys.executable, "-m", "sfly.runner"], cwd=work, env=env, timeout=60)
    output = json.loads((work / "output.json").read_text(encoding="utf-8"))
    events = [json.loads(line) for line in (work / "events.jsonl").read_text().splitlines()]
    return output, [e["message"] for e in events if e.get("type") == "log"]


@pytest.fixture
def short_dir() -> Iterator[Path]:
    """socket 路径不能太长（AF_UNIX 108 字节），放在 TMPDIR 下的短目录里。"""
    with tempfile.TemporaryDirectory(prefix="sfly-") as tmp:
        yield Path(tmp)


def test_a_file_rotated_while_it_is_being_pulled_is_pulled_once_and_deleted_at_its_new_path(
    short_dir: Path,
) -> None:
    # 拉取 app.log.1 的途中它被轮转成 app.log.2：下载照常完成，结果里是它现在的路径；
    # 之后的 moved 事件是同一个文件（文件标识不变），不再拉一次；删除源文件删的是新路径。
    agent = ScriptedAgent(
        short_dir / "agent.sock",
        download=[{"result": info(ROTATED)}],
        events=[{"kind": "moved", "file": info(ROTATED), "old_path": f"{LOGS}/app.log.1"}],
    )
    try:
        output, logs = run_on_agent(
            short_dir / "work", agent.path, delete_source=True, pattern="app.log.*", duration=1.5
        )
    finally:
        agent.close()

    pulled = short_dir / "work" / "pulled"
    assert output == {"status": "success", "outputs": {"count": 1, "total_bytes": 6}}, logs
    assert [args["path"] for args in agent.methods("files.download")] == [f"{LOGS}/app.log.1"]
    assert [args["path"] for args in agent.methods("files.delete")] == [ROTATED]
    assert f"拉取了 {ROTATED}（6 字节）→ {pulled / 'app.log.1'}" in logs
    assert sorted(p.name for p in pulled.iterdir()) == ["app.log.1"]


def test_a_file_moved_elsewhere_while_resuming_its_download_is_skipped_until_seen_again(
    short_dir: Path,
) -> None:
    # 拉取途中连接中断、它被移到了别的目录（Agent 续传时找不到它，回复 moved）：节点不失败，
    # 等监听告诉它去了哪里（这里移出了监听范围，是 deleted），不从头重拉。
    message = (
        f"Agent {SOURCE}：{LOGS}/app.log.1 在下载期间被移走（路径上换成了另一个文件），下载作废"
    )
    agent = ScriptedAgent(
        short_dir / "agent.sock",
        download=[{"error": {"kind": "moved", "message": message, "agent": SOURCE}}],
        events=[{"kind": "deleted", "file": info(f"{LOGS}/app.log.1")}],
    )
    try:
        output, logs = run_on_agent(
            short_dir / "work", agent.path, pattern="app.log.*", duration=1.5
        )
    finally:
        agent.close()

    assert output == {"status": "success", "outputs": {"count": 0, "total_bytes": 0}}, logs
    assert [args["path"] for args in agent.methods("files.download")] == [f"{LOGS}/app.log.1"]
    assert f"{LOGS}/app.log.1 已经不在这个路径上，跳过" in logs
