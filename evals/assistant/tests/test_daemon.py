"""题目「常驻」的判分：参考答案满分，什么都不做零分，各项缺了哪一样就判出哪一项。"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from aeval.tasks import summarize
from aeval.tasks.daemon import EXPECTED, Observed, checks_from, debugged


def success(outputs: dict[str, Any]) -> dict[str, Any]:
    return {"status": "success", "outputs": outputs}


REFERENCE = Observed(
    debug_outputs=[success(EXPECTED["A-100"]), success(EXPECTED["B-200"])],
    test_exists=True,
    test_mentions_stub=True,
    tests_passed=True,
    tests_detail="4 passed",
    stub_left_running=False,
)
NOTHING = Observed(
    debug_outputs=[],
    test_exists=False,
    test_mentions_stub=False,
    tests_passed=True,
    tests_detail="2 passed",
    stub_left_running=False,
)


def score(seen: Observed) -> float:
    return float(summarize(checks_from(seen))["score"])


def test_reference_gets_full_marks() -> None:
    assert summarize(checks_from(REFERENCE))["passed"]


def test_doing_nothing_scores_zero() -> None:
    assert score(NOTHING) == 0.0


def test_debugging_without_the_stub_running_does_not_count() -> None:
    refused = {"status": "failed", "error": {"message": "Connection refused"}}
    seen = replace(REFERENCE, debug_outputs=[refused, success(EXPECTED["B-200"]), None])
    assert debugged(seen.debug_outputs) == ["B-200"]
    assert [c.passed for c in checks_from(seen)] == [False, True, True]


def test_a_test_that_needs_an_outside_service_fails() -> None:
    seen = replace(REFERENCE, tests_passed=False, tests_detail="Connection refused")
    assert [c.passed for c in checks_from(seen)] == [True, False, False]


def test_a_test_that_leaves_the_stub_running_fails_one_check() -> None:
    seen = replace(REFERENCE, stub_left_running=True)
    assert [c.passed for c in checks_from(seen)] == [True, True, False]


def test_a_test_that_does_not_start_the_stub_fails() -> None:
    seen = replace(REFERENCE, test_mentions_stub=False)
    assert [c.passed for c in checks_from(seen)] == [True, False, True]
