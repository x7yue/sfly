"""`sfly scenario show` 里节点生效的超时（sdk/python/src/sfly/cli/node_timeouts.py，#476）和控制面
派发、画布用的 TypeScript 实现（`effectiveTimeout`、`nodeTimeoutProblem`）共用一张用例表：
testdata/effective-timeout-cases.json，TypeScript 一端在
packages/orchestration/test/effective-timeout-cases.test.ts。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from sfly.cli import node_timeouts
from sfly.cli.node_timeouts import (
    MAX_TIMEOUT_SECONDS,
    PLATFORM_TIMEOUT_SECONDS,
    effective_timeout,
    node_timeout_problem,
    timeout_text,
)

CASES: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "testdata" / "effective-timeout-cases.json").read_text(
        "utf-8"
    )
)
EFFECTIVE: list[dict[str, Any]] = CASES["effective_cases"]
PROBLEMS: list[dict[str, Any]] = CASES["problem_cases"]


def test_the_constants_are_the_ones_in_the_case_table() -> None:
    assert PLATFORM_TIMEOUT_SECONDS == CASES["platform_seconds"]
    assert MAX_TIMEOUT_SECONDS == CASES["max_seconds"]


@pytest.mark.parametrize("case", EFFECTIVE, ids=[c["name"] for c in EFFECTIVE])
def test_the_effective_timeout_is_what_the_shared_cases_say(case: dict[str, Any]) -> None:
    node = {"timeout": case["node"]} if "node" in case else {}
    declared = case["type"] if "type" in case else None

    assert effective_timeout(node, declared) == case["expect"]


@pytest.mark.parametrize("case", PROBLEMS, ids=[c["name"] for c in PROBLEMS])
def test_the_problem_with_a_written_timeout_is_the_sentence_the_shared_cases_say(
    case: dict[str, Any],
) -> None:
    assert node_timeout_problem(case["label"], case.get("written")) == case["problem"]


def test_a_found_node_type_that_is_missing_stays_unknown_instead_of_guessing() -> None:
    # 找不到节点类型：Python 独有（表里不比较），场景里没写超时的说不出生效的值。
    assert effective_timeout({}, node_timeouts.UNKNOWN) == {"seconds": None, "source": "unknown"}
    assert effective_timeout({"timeout": 120}, node_timeouts.UNKNOWN) == {
        "seconds": 120,
        "source": "node",
    }


def test_the_text_for_each_source() -> None:
    assert timeout_text({"seconds": 43200, "source": "type"}) == "43200（节点类型声明，秒）"
    assert timeout_text({"seconds": 3600, "source": "platform"}) == "3600（平台默认，秒）"
    assert timeout_text({"seconds": 120, "source": "node"}) == "120（节点上设置，秒）"
    assert timeout_text({"seconds": None, "source": "unknown"}) == "未知（找不到节点类型）"


def test_a_written_value_dispatch_would_refuse_is_shown_as_invalid_with_the_sentence() -> None:
    problem = node_timeout_problem("slow", 5_000_000_000)

    view = node_timeouts.timeout_view({"timeout": 5_000_000_000}, "slow", 43200)

    assert view == {"seconds": None, "source": "invalid", "problem": problem}
    assert timeout_text(view) == f"无效：{problem}（派发时这个任务会以配置错误失败）"
