"""节点对外的行为逐字不变（夹具 `node_behavior.json`，说明见 `node_behavior.py`）。

每个节点的典型输入（成功、失败、参数不合法、超时、被取消）经 `sfly.testing.run_node` 在真实的
执行器进程里跑，比较用户看得到的一切：状态、错误类型和信息、日志、输出、指标名、产物名。期望值是
用重构之前每个节点自己实现逻辑的版本生成的：辅助函数的签名和实现怎么改，节点的行为都不能变。
只有出错的位置（「出错位置：」「执行到」）和堆栈不比对。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from node_behavior import ERROR_PREFIXES, run_cases

GOLDEN = Path(__file__).with_name("node_behavior.json")
EXPECTED: dict[str, dict[str, Any]] = json.loads(GOLDEN.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def behavior(tmp_path_factory: pytest.TempPathFactory) -> dict[str, dict[str, Any]]:
    root = Path(os.path.realpath(tmp_path_factory.mktemp("behavior")))
    # JSON 往返一次：元组变成列表，和夹具里的写法一致。
    rounded: dict[str, dict[str, Any]] = json.loads(json.dumps(run_cases(root)))
    return rounded


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_the_node_behaves_exactly_as_before(behavior: dict[str, dict[str, Any]], name: str) -> None:
    if name not in behavior:
        pytest.skip("这个用例只在 Linux 上跑（监听文件要 inotify）")

    expected = dict(EXPECTED[name])
    message = expected["error_message"]
    if isinstance(message, str):
        for node_module, helper_module in ERROR_PREFIXES.items():
            message = message.replace(node_module, helper_module)
        expected["error_message"] = message
    assert behavior[name] == expected


def test_the_fixture_covers_every_node_and_the_kinds_of_outcome() -> None:
    from node_behavior import NODE_ENTRIES

    covered = {name.split("_")[0] for name in EXPECTED}
    prefixes = {
        "shell",
        "start",
        "stop",
        "wait",
        "follow",
        "sysmon",
        "procmon",
        "pull",
        "watch",
    }
    assert prefixes <= covered
    assert len(NODE_ENTRIES) == 11
    statuses = {case["status"] for case in EXPECTED.values()}
    assert statuses == {"success", "failed", "cancelled"}
