"""题目「常驻」的判分：参考答案满分，什么都不做零分，各项缺了哪一样就判出哪一项。"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from aeval.tasks import summarize
from aeval.tasks.daemon import EXPECTED, Observed, checks_from, debugged


def run(sku: str, *, ok: bool = True) -> dict[str, Any]:
    result = (
        {"status": "success", "outputs": EXPECTED[sku]}
        if ok
        else {"status": "failed", "error": {"message": "Connection refused"}}
    )
    return {"inputs": {"sku": sku}, "result": result}


REFERENCE = Observed(
    debug_runs=[run("A-100"), run("B-200")],
    test_exists=True,
    test_passed=True,
    test_detail="2 passed",
    stub_left_running=False,
    fails_without_stub=True,
    without_stub_detail="AssertionError: 替身没起来",
)
NOTHING = Observed()


def score(seen: Observed) -> float:
    return float(summarize(checks_from(seen))["score"])


def passed(seen: Observed) -> list[bool]:
    return [c.passed for c in checks_from(seen)]


def test_reference_gets_full_marks() -> None:
    assert summarize(checks_from(REFERENCE))["passed"]


def test_doing_nothing_scores_zero() -> None:
    assert score(NOTHING) == 0.0


def test_debugging_without_the_stub_running_does_not_count() -> None:
    seen = replace(REFERENCE, debug_runs=[run("A-100", ok=False), run("B-200")])
    assert debugged(seen) == ["B-200"]
    assert passed(seen) == [False, True, True]


def test_a_run_for_another_sku_does_not_count() -> None:
    swapped = run("A-100")
    swapped["inputs"] = {"sku": "B-200"}
    seen = replace(REFERENCE, debug_runs=[swapped, run("B-200")])
    assert debugged(seen) == ["B-200"]


def test_a_fake_integration_test_that_passes_without_the_stub_scores_zero() -> None:
    # 只断言常量或者 mock 了请求：两遍都通过；也没有真的调试。
    seen = replace(NOTHING, test_exists=True, test_passed=True, test_detail="1 passed")
    assert passed(seen) == [False, False, False]
    assert score(seen) == 0.0


def test_a_test_that_needs_an_outside_service_fails() -> None:
    seen = replace(REFERENCE, test_passed=False, test_detail="Connection refused")
    assert passed(seen) == [True, False, False]


def test_a_test_that_leaves_the_stub_running_fails_one_check() -> None:
    seen = replace(REFERENCE, stub_left_running=True)
    assert passed(seen) == [True, True, False]
