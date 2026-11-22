"""节点的元信息不能变：输入的名字、类型、默认值和说明，输出，指标，图表，主指标，超时……

节点包升级之后，已有的场景按这些元信息填参数、画图、取输出。夹具 `node_metadata.json` 来自
`python -m sfly.cli.scan` 扫重构之前的 `std/src`（0.3.0，每个节点自己实现逻辑）得到的节点列表
（`sfly build` 发布时写进节点包的就是它），只留下 0.4.0 起平台仍然提供的三个节点：`shell`、
`start_process`、`stop_process`（其余节点随 0.4.0 删除，见 ADR 0030）。这里扫现在的 `std/src`，
和它逐个节点比对。行为（运行出来的东西）另有夹具 `node_behavior.json`。

生成：对 0.3.0 的 `std/src`（`git archive std-v0.3.0 std/src` 解出来的目录）运行
`python -m sfly.cli.scan <src 的绝对路径> sfly_std`，只留上面三个节点的条目，写成
`std/tests/node_metadata.json`，再用 `pnpm exec biome format --write std/tests/node_metadata.json`
按仓库的格式整理（比对的是内容）。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

import sfly_std

SRC = Path(sfly_std.__file__).resolve().parent.parent
FIXTURE = Path(__file__).with_name("node_metadata.json")
EXPECTED: list[dict[str, Any]] = json.loads(FIXTURE.read_text(encoding="utf-8"))

#: 夹具里的节点名：0.4.0 起平台只提供这三个节点。
NODES = [node["name"] for node in EXPECTED]


def scanned() -> dict[str, dict[str, Any]]:
    """现在的 `std/src` 里的节点元信息，按节点名。"""
    done = subprocess.run(
        [sys.executable, "-m", "sfly.cli.scan", str(SRC), "sfly_std"],
        capture_output=True,
        text=True,
        check=True,
    )
    return {node["name"]: node for node in json.loads(done.stdout)}


@pytest.fixture(scope="module")
def current() -> dict[str, dict[str, Any]]:
    return scanned()


def test_the_package_has_exactly_the_nodes_of_the_fixture(
    current: dict[str, dict[str, Any]],
) -> None:
    assert sorted(current) == sorted(NODES)


@pytest.mark.parametrize("name", NODES)
def test_the_node_metadata_is_unchanged(current: dict[str, dict[str, Any]], name: str) -> None:
    expected = next(node for node in EXPECTED if node["name"] == name)

    assert current[name] == expected
