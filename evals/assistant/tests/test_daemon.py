"""题目「常驻」的判分：参考答案满分，什么都不做零分，伪造的结果判不过，各项缺了哪一样就判出哪一项。"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from aeval.tasks import summarize
from aeval.tasks.daemon import EXPECTED, Observed, checks_from, debugged

T0 = 1_800_000_000.0


def run(sku: str, started: float, *, ok: bool = True) -> dict[str, Any]:
    """一次调试运行：`started` 开始，一秒后结束。"""
    result = (
        {"status": "success", "outputs": EXPECTED[sku]}
        if ok
        else {"status": "failed", "error": {"message": "Connection refused"}}
    )
    return {"inputs": {"sku": sku}, "started": started, "result": result, "finished": started + 1}


REFERENCE = Observed(
    debug_runs=[run("A-100", T0), run("B-200", T0 + 10)],
    stub_requests=[{"sku": "A-100", "time": T0 + 0.5}, {"sku": "B-200", "time": T0 + 10.5}],
    test_exists=True,
    test_passed=True,
    test_detail="2 passed",
    stub_started=True,
    stub_left_running=False,
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
    seen = replace(
        REFERENCE,
        debug_runs=[run("A-100", T0, ok=False), run("B-200", T0 + 10)],
        stub_requests=[{"sku": "B-200", "time": T0 + 10.5}],
    )
    assert debugged(seen) == ["B-200"]
    assert passed(seen) == [False, True, True]


def test_forged_outputs_without_requests_to_the_stub_score_zero() -> None:
    # 只写了两份 output.json，替身没收到过请求；集成测试也没写。
    forged = replace(NOTHING, debug_runs=REFERENCE.debug_runs)
    assert debugged(forged) == []
    assert score(forged) == 0.0


def test_requests_outside_the_debug_run_do_not_count() -> None:
    # 替身确实收到过请求，但不在这两次调试运行的时间里（手写的 output.json 配上别的时候的请求）。
    seen = replace(
        REFERENCE,
        stub_requests=[{"sku": "A-100", "time": T0 + 100}, {"sku": "B-200", "time": T0 - 100}],
    )
    assert debugged(seen) == []


def test_a_run_for_another_sku_does_not_count() -> None:
    swapped = run("A-100", T0)
    swapped["inputs"] = {"sku": "B-200"}
    seen = replace(REFERENCE, debug_runs=[swapped, run("B-200", T0 + 10)])
    assert debugged(seen) == ["B-200"]


def test_a_test_that_mentions_the_stub_but_never_starts_it_scores_zero() -> None:
    # 测试文件在、跑得过（例如只断言常量、或者用 mock），替身没起来过；也没有真的调试。
    seen = replace(NOTHING, test_exists=True, test_passed=True, test_detail="1 passed")
    assert passed(seen) == [False, False, False]
    assert score(seen) == 0.0


def test_a_test_that_needs_an_outside_service_fails() -> None:
    seen = replace(REFERENCE, test_passed=False, test_detail="Connection refused")
    assert passed(seen) == [True, False, False]


def test_a_test_that_leaves_the_stub_running_fails_one_check() -> None:
    seen = replace(REFERENCE, stub_left_running=True)
    assert passed(seen) == [True, True, False]
