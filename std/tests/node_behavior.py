"""节点对外行为的夹具：对每个节点的典型输入（成功、失败、超时、被取消），经 `sfly.testing.run_node`
在真实的执行器进程里跑，记下用户看得到的一切：状态、错误类型和信息、日志、输出、指标名、产物名。

期望值（`node_behavior.json`）是用重构之前的实现（`origin/dev` 上 0.3.0 的节点代码，每个节点自己
实现逻辑）生成的，提交进仓库：之后节点改成辅助函数上的薄封装、辅助函数的签名和实现再怎么改，
`test_node_behavior.py` 都要求节点的行为逐字不变。出错的位置（`location`）和堆栈不比对：
逻辑搬进辅助函数模块后位置本来就会变，这是用户改不了的内部细节。

生成期望值：`python std/tests/node_behavior.py <含 sfly_std 的 src 目录> <输出 json>`
（对 `git archive origin/dev std/src` 解出来的目录运行，最好在 Linux 上：只有 Linux 上有监听文件的
用例；写完用 `pnpm exec biome format --write std/tests/node_behavior.json` 按仓库的格式整理，
比对的是内容，不是文本）。临时目录名、数字（耗时、进程号）、本机的网卡磁盘列表都抹成占位符再比较。
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any

#: 节点名 → 入口。0.4.0 起平台只提供 shell、start_process、stop_process 三个节点：其余节点的夹具
#: 用测试用的外壳（`helper_nodes.py`，参数、输出和 0.3.0 里的节点一致）跑，守着辅助函数的行为。
NODE_ENTRIES: dict[str, str] = {
    "shell": "sfly_std.shell:shell",
    "start_process": "sfly_std.start_process:start_process",
    "stop_process": "sfly_std.stop_process:stop_process",
    "system_monitor": "helper_nodes:system_monitor",
    "process_monitor": "helper_nodes:process_monitor",
    "wait_port": "helper_nodes:wait_port",
    "wait_file": "helper_nodes:wait_file",
    "wait_log_line": "helper_nodes:wait_log_line",
    "follow_log": "helper_nodes:follow_log",
    "pull_files": "helper_nodes:pull_files",
    "watch_files": "helper_nodes:watch_files",
}

#: 夹具里的错误信息以「节点模块.异常类名」开头（0.3.0 的节点模块里定义了同名的异常子类）；外壳里
#: 失败时抛出的是辅助函数的异常，前缀是函数所在的模块：比对时把夹具里的前缀换成这里的。
ERROR_PREFIXES: dict[str, str] = {
    "sfly_std.process_monitor.": "sfly_std.resources.",
    "sfly_std.follow_log.": "sfly_std.logs.",
}

LINUX = sys.platform.startswith("linux")

#: 「执行到 …… 第 N 行」「出错位置：…… 第 N 行」：逻辑搬进辅助函数模块后位置会变。被终止时
#: 业务节点调用辅助函数的那一行后面还会补一句「（正在 sfly_std.… 第 N 行）」（#568：用户直接
#: 调用的那个辅助函数，行号随 `sfly-std` 的版本变），一起不比对。
_WHERE = re.compile(r"(执行到|出错位置：) ?\S+ 第 \d+ 行(（正在 \S+ 第 \d+ 行）)?")
#: 每次运行都不一样的数：小数（耗时、间隔）和四位以上的整数（端口、进程号、字节数的大数）；
#: 小整数（退出码、个数、秒数、宽限期）逐字比较，写错一个数夹具就红。
_DECIMAL = re.compile(r"\d+\.\d+")
_BIG = re.compile(r"\d{4,}")
#: 进程号、进程组号（容器里可能是三位以下的小数）和采样次数：随机，也抹掉。
_PIDS = re.compile(r"(pid |进程 |进程组 )\d+")
_SAMPLES = re.compile(r"(共采样 )\d+( 次)")
#: 进程名：macOS 上 `sh` 是 bash，Linux 上常是 dash（日志里写「pid N 进程名：命令行」）。
_SHELL_NAME = re.compile(r"(pid N )(?:bash|dash|zsh)(：)")
#: 输出里每次运行都不一样的键：进程号、采样次数；其余的值逐字比较。
_VARIABLE_KEYS = {"pid", "samples"}
#: 输出里命令的输出、日志里匹配的那一行：内容就是被测的东西，只抹临时目录，不动数字。
_VERBATIM_KEYS = {"stdout", "stderr", "line"}
#: 因机器而异的指标：磁盘、网卡的个数不同；按进程的磁盘读写只有 Linux 上读得到。
_MACHINE_METRICS = re.compile(r"_by_(nic|disk)$|^io_(read|write)_bytes_per_s_by_process$")
#: 错误信息里列出的本机的网卡、磁盘（每台机器不同）。
_MACHINE_LISTS = re.compile(r"(本机的(?:网卡|磁盘)有：).*")


def first_metric(partial: Any) -> bool:
    """取消的时机：第一个指标上报之后。不按「开始后几秒」：执行器启动的快慢不同，取消正好卡在
    每秒上报一次指标的边上时，有没有指标就不稳定。"""
    return bool(partial.metrics)


def wait_for_text(path: Path, text: str, seconds: float = 20) -> None:
    """等 `path` 里出现 `text`（被测的进程已经装好信号处理，再去停它）。"""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists() and text in path.read_text(errors="replace"):
            return
        time.sleep(0.05)  # noqa: TID251 生成夹具时作为脚本单独运行，用不了 sdk/python/tests 的等待辅助
    raise TimeoutError(f"{path} 里 {seconds} 秒内没有出现 {text!r}")


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = int(s.getsockname()[1])
    s.close()
    return port


class Normalizer:
    """抹掉临时目录名和数字：让两次运行的结果可以逐字比较。"""

    def __init__(self, tmp: Path) -> None:
        self._tmp = [str(tmp), str(tmp.resolve())]

    def text(self, text: str) -> str:
        for tmp in self._tmp:
            text = text.replace(tmp, "<TMP>")
        text = _MACHINE_LISTS.sub(r"\1<列表>", text)
        text = re.sub(r"/(?:private/)?(?:var|tmp)/[^\s'\"]*?(?=[\s'\"]|$)", "<TMPPATH>", text)
        text = _WHERE.sub(r"\1 <位置>", text)
        text = _PIDS.sub(r"\1N", _SAMPLES.sub(r"\1N\2", text))
        text = _SHELL_NAME.sub(r"\1sh\2", text)
        return _BIG.sub("N", _DECIMAL.sub("F", text))

    def outputs(self, value: Any, key: str = "") -> Any:
        if isinstance(value, dict):
            return {k: self.outputs(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [self.outputs(v, key) for v in value]
        if isinstance(value, bool) or value is None:
            return value
        if isinstance(value, (int, float)):
            return "N" if key in _VARIABLE_KEYS else value
        if isinstance(value, str):
            if key in _VERBATIM_KEYS:
                for tmp in self._tmp:
                    value = value.replace(tmp, "<TMP>")
                return value
            return self.text(value)  # 路径、产物引用：临时目录、进程号这些抹掉
        return value


def summarize(result: Any, norm: Normalizer) -> dict[str, Any]:
    """一次执行里用户看得到的内容。"""
    error = result.error
    # 失败时执行器把堆栈写到 stderr（文件路径、代码行都随实现变）：堆栈本身不比对。
    traceback = set(error.traceback.splitlines()) if error and error.traceback else set()
    # 日志按来源（sdk、stdout、stderr）分开，各自保持顺序、不去重：条数和顺序都比；
    # 不同来源之间走各自的管道，先后不一定。
    logs: dict[str, list[list[str]]] = {}
    for log in result.logs:
        if log.source == "stderr" and log.message in traceback:
            continue
        logs.setdefault(log.source, []).append([log.level, norm.text(log.message)])
    return {
        "status": result.status,
        "error_type": error.type if error else None,
        "error_kind": error.kind if error else None,
        "error_message": norm.text(error.message) if error and error.message else None,
        "logs": logs,
        "outputs": norm.outputs(result.outputs) if result.outputs is not None else None,
        "metric_names": sorted(
            {m.name for m in result.metrics if not _MACHINE_METRICS.search(m.name)}
        ),
        "artifacts": sorted(result.artifacts),
    }


def run_cases(tmp: Path, *, only: set[str] | None = None) -> dict[str, dict[str, Any]]:
    """跑全部用例，返回 用例名 → 摘要。`only` 给出时只跑这些。"""
    from sfly.testing import run_node

    norm = Normalizer(tmp)
    cases: dict[str, dict[str, Any]] = {}

    def case(
        name: str,
        node: str,
        inputs: Mapping[str, Any],
        *,
        work: str | None = None,
        **run_kwargs: Any,
    ) -> None:
        if only is not None and name not in only:
            return
        result = run_node(
            NODE_ENTRIES[node], dict(inputs), work_dir=tmp / (work or name), **run_kwargs
        )
        cases[name] = summarize(result, norm)

    # ---- shell ----
    case("shell_ok", "shell", {"command": "echo hi; echo err >&2"})
    case("shell_save_output", "shell", {"command": "echo hi; echo err >&2", "save_output": True})
    case("shell_fail", "shell", {"command": "echo boom >&2; exit 3"})
    case("shell_ok_exit_codes", "shell", {"command": "exit 3", "ok_exit_codes": [0, 3]})
    case("shell_signal", "shell", {"command": "kill -9 $$"})
    case("shell_no_interpreter", "shell", {"command": "true", "shell": "/nonexistent/sh"})
    case("shell_bad_cwd", "shell", {"command": "true", "cwd": str(tmp / "no-such-dir")})
    case("shell_env", "shell", {"command": "echo $GREETING", "env": {"GREETING": "hello"}})
    case("shell_cancel", "shell", {"command": "sleep 30"}, cancel_after=2.0, grace=3)

    # ---- start_process / stop_process ----
    case("start_ok", "start_process", {"command": "echo started"})
    case("start_no_interpreter", "start_process", {"command": "true", "shell": "/nonexistent/sh"})
    case("start_bad_cwd", "start_process", {"command": "true", "cwd": str(tmp / "no-such-dir")})
    case(
        "start_log_file",
        "start_process",
        {"command": "echo started", "log_file": str(tmp / "logs" / "own.log")},
    )
    case("stop_none", "stop_process", {})
    case("stop_negative", "stop_process", {"pid": -5})
    case("stop_gone", "stop_process", {"pid": 999999})
    sleeper = subprocess.Popen(["sleep", "30"], start_new_session=True)
    case("stop_real", "stop_process", {"pid": sleeper.pid, "grace": 2})
    sleeper.wait()
    # 服务忽略 SIGTERM（SIGKILL 的路径）：用 start_process 起（看护进程记退出码），再用
    # stop_process 停，两个节点用同一个 work_dir，相当于同一次运行里的两个节点。
    stubborn = tmp / "stop_sigkill"
    if only is None or "stop_sigkill" in only:
        started = run_node(
            NODE_ENTRIES["start_process"],
            {"command": "trap '' TERM; echo ready; while true; do sleep 0.2; done"},
            work_dir=stubborn,
        )
        assert started.outputs is not None, started.error
        wait_for_text(Path(started.outputs["log_file"]), "ready")
        case(
            "stop_sigkill",
            "stop_process",
            {"pid": started.outputs["pid"], "grace": 1},
            work="stop_sigkill",
        )

    # ---- wait_port ----
    port = free_port()
    case("wait_port_timeout", "wait_port", {"port": port, "wait": 0.5, "poll": 0.2})
    case("wait_port_bad_port", "wait_port", {"port": 70000})
    case("wait_port_negative_wait", "wait_port", {"port": port, "wait": -1})
    case("wait_port_cancel", "wait_port", {"port": port, "wait": 30, "poll": 0.2}, cancel_after=2.0)
    with listening() as open_port:
        case("wait_port_ok", "wait_port", {"port": open_port, "wait": 5, "poll": 0.2})

    # ---- wait_file ----
    case("wait_file_timeout", "wait_file", {"path": str(tmp / "nofile"), "wait": 0.5, "poll": 0.2})
    case("wait_file_negative_stable", "wait_file", {"path": str(tmp / "nofile"), "stable": -1})
    existing = tmp / "report.txt"
    existing.write_text("report\n")
    case("wait_file_ok", "wait_file", {"path": str(existing), "wait": 5, "poll": 0.2})
    case(
        "wait_file_stable",
        "wait_file",
        {"path": str(existing), "stable": 0.4, "wait": 5, "poll": 0.1},
    )
    case("wait_file_is_dir", "wait_file", {"path": str(tmp), "wait": 0.5, "poll": 0.2})

    # ---- wait_log_line ----
    log = tmp / "app.log"
    log.write_text("starting\nready now\nERROR bad\n")
    case(
        "wait_log_timeout",
        "wait_log_line",
        {"path": str(tmp / "nolog"), "pattern": "x", "wait": 0.5, "poll": 0.2},
    )
    case("wait_log_bad_regex", "wait_log_line", {"path": str(log), "pattern": "("})
    case(
        "wait_log_ok",
        "wait_log_line",
        {"path": str(log), "pattern": "ready", "read_from": "start", "poll": 0.2},
    )
    case(
        "wait_log_from_end_timeout",
        "wait_log_line",
        {"path": str(log), "pattern": "ready", "wait": 0.5, "poll": 0.2},
    )

    case(
        "wait_log_cancel",
        "wait_log_line",
        {"path": str(tmp / "nolog"), "pattern": "x", "wait": 30, "poll": 0.2},
        cancel_after=2.0,
    )

    # ---- follow_log ----
    case(
        "follow_fail_on",
        "follow_log",
        {"path": str(log), "read_from": "start", "fail_on": ["ERROR"]},
    )
    case("follow_duration", "follow_log", {"path": str(log), "read_from": "start", "duration": 0.6})
    case("follow_bad_regex", "follow_log", {"path": str(log), "fail_on": ["("]})
    case("follow_negative_duration", "follow_log", {"path": str(log), "duration": -1})
    case("follow_cancel", "follow_log", {"path": str(log)}, cancel_when=first_metric)

    # ---- system_monitor ----
    case("sysmon_bad_nic", "system_monitor", {"nic": "nonexistent0", "duration": 0.3})
    case("sysmon_bad_disk_path", "system_monitor", {"disk_path": "/nonexistent", "duration": 0.3})
    case("sysmon_bad_disk", "system_monitor", {"disk": "nonexistent-disk", "duration": 0.3})
    case("sysmon_bad_interval", "system_monitor", {"interval": 0})
    case("sysmon_duration", "system_monitor", {"interval": 0.2, "duration": 0.7})
    case("sysmon_cancel", "system_monitor", {"interval": 0.2}, cancel_when=first_metric)

    # ---- process_monitor ----
    case("procmon_no_target", "process_monitor", {})
    case(
        "procmon_not_found",
        "process_monitor",
        {"name": "no-such-process-sfly-golden", "wait_for_process": 0.3},
    )
    with sleeping(1.5) as pid:
        case("procmon_exit_fails", "process_monitor", {"pid": pid, "interval": 0.2})
    with sleeping(1.0) as pid:
        case(
            "procmon_exit_succeeds",
            "process_monitor",
            {"pid": pid, "interval": 0.2, "on_exit": "succeed"},
        )
    with sleeping(29.7):
        case(
            "procmon_match",
            "process_monitor",
            {"match": "sleep 29\\.7", "interval": 0.2, "duration": 0.7},
        )
    with sleeping(28.9) as first, sleeping(28.8) as second:
        case(
            "procmon_two_pids",
            "process_monitor",
            {"pid": [first, second], "interval": 0.2, "duration": 0.7},
        )
    parent = subprocess.Popen(["sh", "-c", "sleep 28.3 & wait"])
    try:
        time.sleep(0.5)  # noqa: TID251 等 sh 起好子进程；生成夹具时作为脚本单独运行，用不了等待辅助
        for children in (True, False):
            case(
                f"procmon_children_{str(children).lower()}",
                "process_monitor",
                {"pid": parent.pid, "include_children": children, "interval": 0.2, "duration": 0.7},
            )
    finally:
        subprocess.run(["pkill", "-P", str(parent.pid)], check=False)
        parent.kill()
        parent.wait()
    with sleeping(30) as pid:
        case("procmon_duration", "process_monitor", {"pid": pid, "interval": 0.2, "duration": 0.7})
        case(
            "procmon_cancel",
            "process_monitor",
            {"pid": pid, "interval": 0.2},
            cancel_when=first_metric,
        )

    # ---- pull_files / watch_files（agents：本地目录模拟另一台 Agent）----
    agent_root = tmp / "agentA"
    (agent_root / "srv" / "sub").mkdir(parents=True)
    (agent_root / "srv" / "a.log").write_text("a\n")
    (agent_root / "srv" / "b.txt").write_text("bb\n")
    (agent_root / "srv" / "sub" / "c.log").write_text("ccc\n")
    agents = {"A": agent_root}
    case(
        "pull_ok",
        "pull_files",
        {"source": "A", "directory": "/srv", "local_dir": "got"},
        agents=agents,
    )
    case(
        "pull_pattern_recursive",
        "pull_files",
        {
            "source": "A",
            "directory": "/srv",
            "pattern": "*.log",
            "recursive": True,
            "local_dir": "got2",
        },
        agents=agents,
    )
    case(
        "pull_no_directory",
        "pull_files",
        {"source": "A", "directory": "/nope", "local_dir": "got"},
        agents=agents,
    )
    case(
        "pull_empty_local_dir",
        "pull_files",
        {"source": "A", "directory": "/srv", "local_dir": ""},
        agents=agents,
    )
    case(
        "pull_delete_source",
        "pull_files",
        {
            "source": "A",
            "directory": "/srv",
            "pattern": "b.txt",
            "local_dir": "got3",
            "delete_source": True,
        },
        agents=agents,
    )
    case(
        "watch_negative_stable",
        "watch_files",
        {"source": "A", "directory": "/srv", "local_dir": "got", "stable": -1},
        agents=agents,
    )
    # 监听文件的用例看到的是「b.txt 已经被 pull_delete_source 删掉」之后的目录（夹具就是这样
    # 生成的）。前提在这里自己准备好，不靠前一个用例的副作用：只挑 `watch_*` 单独跑（`only`）
    # 时结果也一样。
    (agent_root / "srv" / "b.txt").unlink(missing_ok=True)
    if LINUX:
        case(
            "watch_no_directory",
            "watch_files",
            {"source": "A", "directory": "/nope", "local_dir": "got"},
            agents=agents,
        )
        case(
            "watch_duration",
            "watch_files",
            {
                "source": "A",
                "directory": "/srv",
                "local_dir": "gotw",
                "stable": 0.3,
                "duration": 2.5,
            },
            agents=agents,
        )
        case(
            "watch_cancel",
            "watch_files",
            {"source": "A", "directory": "/srv", "local_dir": "gotc"},
            agents=agents,
            cancel_when=first_metric,
        )
    return cases


@contextmanager
def listening() -> Iterator[int]:
    """本进程里监听一个端口，`with` 里连得上。"""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen()
    try:
        yield server.getsockname()[1]
    finally:
        server.close()


@contextmanager
def sleeping(seconds: float) -> Iterator[int]:
    """一个 `sleep` 进程：`with` 结束时终止它。"""
    proc = subprocess.Popen(["sleep", str(seconds)])
    try:
        yield proc.pid
    finally:
        proc.kill()
        proc.wait()


def main(argv: list[str]) -> int:
    """`python node_behavior.py <含 sfly_std 的 src 目录> <输出 json>`。"""
    src, out = os.path.abspath(argv[0]), argv[1]
    # 执行器子进程从任务目录启动，模块搜索路径要是绝对路径。
    sys.path.insert(0, src)
    import sfly_std

    assert str(Path(sfly_std.__file__).resolve()).startswith(str(Path(src).resolve())), (
        sfly_std.__file__
    )
    with tempfile.TemporaryDirectory(prefix="sfly-golden-") as tmp:
        cases = run_cases(Path(os.path.realpath(tmp)))
    Path(out).write_text(
        json.dumps(cases, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8"
    )
    print("ok", len(cases), "cases")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
