"""节点类型的指标与图表声明：`@node` 接收声明，`sfly build` 校验并写入元信息。"""

from __future__ import annotations

import json
import shutil
import socket
import tempfile
import threading
import zipfile
from pathlib import Path
from typing import Any

import pytest

import sfly
from sfly.cli import main

PYPROJECT = """\
[project]
name = "demo-perf"
version = "0.1.0"
"""

ORDER_GEN = """\
from sfly import Chart, Metric, node


@node(
    title="下单压测",
    metrics=[
        Metric("tps", unit="笔/s", description="每秒成交笔数"),
        Metric("p99", unit="ms"),
        Metric("rejected", kind="counter"),
        Metric("conn_tps", unit="笔/s", labels=["host", "port"]),
    ],
    charts=[
        Chart("TPS", type="area", metrics=["tps"]),
        Chart("延迟", metrics=["p99"]),
        Chart("按连接", metrics=["tps", "conn_tps"]),
    ],
    primary_metric="tps",
)
def order_gen(ctx, rate: int) -> dict:
    return {}


@node
def report() -> dict:
    return {}
"""


def write_module(root: Path, module: str) -> Path:
    (root / "pyproject.toml").write_text(PYPROJECT, encoding="utf-8")
    (root / "demo_perf.py").write_text(module, encoding="utf-8")
    return root


def build_nodes(root: Path, capsys: pytest.CaptureFixture[str]) -> dict[str, dict[str, Any]]:
    code = main(["build", str(root)])
    _, err = capsys.readouterr()
    assert code == 0, err
    with zipfile.ZipFile(root / "dist" / "demo-perf-0.1.0.sflypkg") as zf:
        meta = json.loads(zf.read("sfly-package.json"))
    return {n["name"]: n for n in meta["nodes"]}


def test_build_writes_declared_metrics_charts_and_primary_metric(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    nodes = build_nodes(write_module(tmp_path, ORDER_GEN), capsys)

    order_gen = nodes["order_gen"]
    assert order_gen["metrics"] == [
        {"name": "tps", "unit": "笔/s", "kind": "gauge", "description": "每秒成交笔数"},
        {"name": "p99", "unit": "ms", "kind": "gauge"},
        {"name": "rejected", "unit": "", "kind": "counter"},
        {"name": "conn_tps", "unit": "笔/s", "kind": "gauge", "labels": ["host", "port"]},
    ]
    assert order_gen["charts"] == [
        {"title": "TPS", "type": "area", "metrics": ["tps"]},
        {"title": "延迟", "type": "line", "metrics": ["p99"]},
        {"title": "按连接", "type": "line", "metrics": ["tps", "conn_tps"]},
    ]
    assert order_gen["primary_metric"] == "tps"

    # 没有声明指标的节点类型：元信息里没有指标和图表，也没有主指标。
    assert nodes["report"]["metrics"] == []
    assert nodes["report"]["charts"] == []
    assert "primary_metric" not in nodes["report"]


def node_with(declarations: str) -> str:
    return (
        "from sfly import Chart, Metric, node\n\n"
        f"@node({declarations})\n"
        "def probe() -> dict:\n"
        "    return {}\n"
    )


@pytest.mark.parametrize(
    ("declarations", "message"),
    [
        (
            "metrics=[Metric(f'm{i}') for i in range(51)]",
            "最多 50 个指标",
        ),
        (
            "metrics=[Metric('m')], charts=[Chart(f'c{i}', metrics=['m']) for i in range(21)]",
            "最多 20 张图表",
        ),
        (
            "metrics=[Metric('p50')], charts=[Chart('延迟', metrics=['p50', 'p99'])]",
            "图表 延迟 引用了未声明的指标 p99",
        ),
        ("metrics=[Metric('tps'), Metric('tps', unit='笔/s')]", "指标名 tps 重复"),
        ("metrics=[Metric('tps')], primary_metric='latency'", "主指标 latency 未声明"),
        ("metrics=[Metric('9lives')]", "9lives"),
        ("metrics=[Metric('m', kind='histogram')]", "histogram"),
        ("metrics=[Metric('m')], charts=[Chart('c', type='pie', metrics=['m'])]", "pie"),
        ("metrics=[Metric('m')], charts=[Chart('空图表', metrics=[])]", "空图表"),
        ("metrics=[Metric('m', labels=['a', 'b', 'c', 'd'])]", "最多 3 个标签键"),
        ("metrics=[Metric('m', labels=['pid', 'pid'])]", "标签键 pid 重复"),
        ("metrics=[Metric('m', labels=['2nd'])]", "2nd"),
        ("metrics=[Metric('m', labels=['a-b'])]", "a-b"),
        ("metrics=[Metric('m', labels='pid')]", "标签键"),
        (
            "metrics=[Metric('cpu', labels=['pid'])], primary_metric='cpu'",
            "主指标 cpu 带标签键",
        ),
        (
            "metrics=[Metric('cpu', labels=['pid'])], "
            "charts=[Chart('CPU', type='stat', metrics=['cpu'])]",
            "图表 CPU 是 stat，不能引用带标签键的指标 cpu",
        ),
        (
            "metrics=[Metric('total'), Metric('cpu', labels=['pid'])], "
            "charts=[Chart('CPU', type='bar', metrics=['total', 'cpu'])]",
            "图表 CPU 是 bar，不能引用带标签键的指标 cpu",
        ),
    ],
)
def test_build_rejects_invalid_declarations(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], declarations: str, message: str
) -> None:
    root = write_module(tmp_path, node_with(declarations))
    assert main(["build", str(root)]) == 1
    _, err = capsys.readouterr()
    assert "probe" in err
    assert message in err
    assert not (root / "dist").exists()


def test_dev_sends_declarations_to_agent(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = write_module(tmp_path, ORDER_GEN)
    # Unix socket 路径有长度限制，放在短的临时目录里。
    sock_dir = Path(tempfile.mkdtemp(prefix="sfly-"))
    sock_path = sock_dir / "agent.sock"
    requests: list[dict[str, Any]] = []

    def fake_agent(server: socket.socket) -> None:
        conn, _ = server.accept()
        with conn:
            data = b""
            while chunk := conn.recv(65536):
                data += chunk
            requests.append(json.loads(data))
            conn.sendall(b'{"ok": true, "message": "loaded", "output": ""}\n')

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(str(sock_path))
        server.listen(1)
        agent = threading.Thread(target=fake_agent, args=(server,))
        agent.start()
        code = main(["dev", str(root), "--socket", str(sock_path)])
        agent.join(timeout=10)
    shutil.rmtree(sock_dir)
    _, err = capsys.readouterr()
    assert code == 0, err

    [request] = requests
    assert request["metadata"]["version"] == "dev"
    # 开发版本和 sfly build 一样声明最低 SDK 版本，控制面派发时同样检查（#79）。
    assert request["metadata"]["requires_sdk"] == f">={sfly.__version__}"
    order_gen = {n["name"]: n for n in request["metadata"]["nodes"]}["order_gen"]
    assert [m["name"] for m in order_gen["metrics"]] == ["tps", "p99", "rejected", "conn_tps"]
    assert [c["title"] for c in order_gen["charts"]] == ["TPS", "延迟", "按连接"]
    assert order_gen["primary_metric"] == "tps"


def test_dev_rejects_invalid_declarations_like_build(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = write_module(tmp_path, node_with("metrics=[Metric('tps')], primary_metric='p99'"))
    assert main(["dev", str(root), "--socket", str(tmp_path / "none.sock")]) == 1
    _, err = capsys.readouterr()
    assert "主指标 p99 未声明" in err
