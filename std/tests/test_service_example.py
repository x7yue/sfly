"""开发文档里的示例业务节点（`service_example.py`）：真的起一个服务、采样、收集日志、停掉。

文档（docs/guide/standard-nodes.md）里的代码块和这个文件一字不差，由最后一个测试比对。
"""

from __future__ import annotations

import re
import socket
import sys
import time
from pathlib import Path

import psutil
from service_example import service_check

from sfly.testing import run_node

REPO = Path(__file__).resolve().parents[2]
EXAMPLE = Path(__file__).with_name("service_example.py")
DOC = REPO / "docs" / "guide" / "standard-nodes.md"

#: 被测服务：一个监听端口、就绪时打日志的 HTTP 服务。
SERVICE = (
    'exec {python} -u -c "import http.server as h, sys; '
    "s = h.HTTPServer(('127.0.0.1', {port}), h.SimpleHTTPRequestHandler); "
    "print('服务就绪', flush=True); s.serve_forever()\""
)


def with_port(port: int) -> list[psutil.Process]:
    """命令行里带这个端口的进程：被测服务停掉之后不该再有。"""
    return [
        p
        for p in psutil.process_iter(["cmdline"])
        if str(port) in " ".join(p.info["cmdline"] or [])
    ]


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def test_the_example_starts_the_service_samples_it_collects_the_log_and_stops_it(
    tmp_path: Path,
) -> None:
    port = free_port()
    command = SERVICE.format(python=sys.executable, port=port)

    result = run_node(
        service_check,
        {"command": command, "port": port, "ready_line": "服务就绪", "observe": 1.5},
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["samples"] >= 1
    assert result.outputs["exit_code"] == 143
    assert (tmp_path / "artifacts" / "service.log").read_text().strip() == "服务就绪"
    assert result.metrics, "采样的指标上报了"
    assert not with_port(port)


def test_the_service_is_stopped_even_when_it_never_becomes_ready(tmp_path: Path) -> None:
    port = free_port()
    sleeper = "import time; print('启动中', flush=True); time.sleep(60)"
    command = f'exec {sys.executable} -c "{sleeper}" {port}'

    result = run_node(
        service_check,
        {"command": command, "port": port, "ready_line": "永远不会出现", "observe": 1},
        work_dir=tmp_path,
        cancel_after=3,
    )

    assert result.status != "success"
    assert not with_port(port)
    # 服务没就绪、节点失败的时候最需要日志：它在服务停掉之后存成了产物。
    assert (tmp_path / "artifacts" / "service.log").read_text().strip() == "启动中"


#: 忽略 SIGTERM、只能靠 SIGKILL 停掉的 HTTP 服务（真实的被测服务退出慢很常见）。
STUBBORN_SERVICE = (
    'exec {python} -u -c "import http.server as h, signal; '
    "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
    "s = h.HTTPServer(('127.0.0.1', {port}), h.SimpleHTTPRequestHandler); "
    "print('服务就绪', flush=True); s.serve_forever()\""
)


def test_a_cancelled_node_does_not_leave_a_service_that_ignores_sigterm_behind(
    tmp_path: Path,
) -> None:
    # 平台终止任务时只给节点 10 秒（grace 默认值）：停服务要在这段时间里发出 SIGKILL，
    # 不然节点自己先被杀掉，服务和它的看护进程都留下来。
    port = free_port()
    command = STUBBORN_SERVICE.format(python=sys.executable, port=port)
    started = time.monotonic()

    result = run_node(
        service_check,
        {"command": command, "port": port, "ready_line": "服务就绪", "observe": 60},
        work_dir=tmp_path,
        cancel_after=3,
    )

    assert result.status == "cancelled"
    assert not with_port(port), "服务或它的看护进程留了下来"
    assert time.monotonic() - started < 9, "取消后清理用了太久：平台的 10 秒宽限期快到了"
    # 清理里先停服务、再存日志：日志存下来了。
    assert (tmp_path / "artifacts" / "service.log").read_text().strip() == "服务就绪"
    assert any("宽限期" in log.message and "缩短" in log.message for log in result.logs)
    # #568：被终止时报的位置是业务节点里的那一行，辅助函数（真的 `sfly_std`）里的那一帧写在后面作补充。
    [terminated] = [log.message for log in result.logs if log.message.startswith("任务被终止")]
    assert re.fullmatch(
        r"任务被终止（SIGTERM），执行到 service_example\.service_check 第 \d+ 行"
        r"（正在 sfly_std\.\w+\.\w+ 第 \d+ 行）",
        terminated,
    ), terminated


def test_the_documentation_shows_exactly_this_example() -> None:
    blocks = re.findall(r"```python\n(.*?)```", DOC.read_text(encoding="utf-8"), re.DOTALL)

    assert EXAMPLE.read_text(encoding="utf-8") in blocks, (
        "docs/guide/standard-nodes.md 里的示例代码块要和 std/tests/service_example.py 一字不差"
    )
