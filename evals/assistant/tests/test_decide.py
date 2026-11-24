"""对照实验的判定：照事先定下的三条标准算。"""

from typing import Any

from aeval.decide import decide


def session(
    arm: str, task: str, passed: bool, turns: int, failure: str | None = None
) -> dict[str, Any]:
    return {
        "model": "m",
        "arm": arm,
        "task": task,
        "grade": {"passed": passed},
        "driver": {"turns": turns},
        "failure": {"primary": failure} if failure else None,
    }


def test_within_all_three_limits_is_not_worse() -> None:
    records = [session("a", "write", True, 10)] * 5 + [session("p", "write", True, 12)] * 4
    records += [session("p", "write", False, 13, "超时")]
    result = decide(records, "m")
    assert result["verdict"] == "平台臂没有明显变差"


def test_too_many_turns_is_worse() -> None:
    records = [session("a", "write", True, 10)] * 5 + [session("p", "write", True, 14)] * 5
    result = decide(records, "m")
    assert result["criteria"]["轮数的中位数不超过臂 A 的 1.3 倍"] is False
    assert result["verdict"].startswith("平台臂明显变差")


def test_failure_type_only_in_the_platform_arm_twice_is_worse() -> None:
    records = [session("a", "write", True, 10)] * 5
    records += [session("p", "write", True, 10)] * 3 + [
        session("p", "write", False, 10, "超时")
    ] * 2
    result = decide(records, "m")
    assert result["only_in_remote"] == {"超时": 2}
    assert result["verdict"].startswith("平台臂明显变差")


def test_unbalanced_arms_give_no_verdict() -> None:
    records = [session("a", "write", True, 10)] * 3 + [session("p", "write", True, 10)] * 2
    assert decide(records, "m")["verdict"] is None


def test_tasks_only_in_arm_a_are_ignored() -> None:
    records = [session("a", "write", True, 10)] * 3 + [session("a", "fix", False, 10)] * 3
    records += [session("p", "write", True, 10)] * 3
    result = decide(records, "m")
    assert result["tasks"] == ["write"]
    assert result["passed"] == {"a": 3, "p": 3}


def test_exactly_one_fewer_pass_still_satisfies_criterion_one() -> None:
    records = [session("a", "write", True, 10)] * 5
    records += [session("p", "write", True, 10)] * 4 + [session("p", "write", False, 10, "其他")]
    assert decide(records, "m")["criteria"]["通过的题数比臂 A 少不超过 1 题"] is True


def test_two_fewer_passes_breaks_criterion_one() -> None:
    records = [session("a", "write", True, 10)] * 5
    records += [session("p", "write", True, 10)] * 3 + [session("p", "write", False, 10)] * 2
    assert decide(records, "m")["criteria"]["通过的题数比臂 A 少不超过 1 题"] is False


def test_exactly_one_point_three_times_the_turns_still_satisfies_criterion_two() -> None:
    records = [session("a", "write", True, 10)] * 5 + [session("p", "write", True, 13)] * 5
    assert decide(records, "m")["criteria"]["轮数的中位数不超过臂 A 的 1.3 倍"] is True
    records = [session("a", "write", True, 10)] * 5 + [session("p", "write", True, 14)] * 5
    assert decide(records, "m")["criteria"]["轮数的中位数不超过臂 A 的 1.3 倍"] is False


def test_turn_ratio_is_exact_with_half_medians() -> None:
    from aeval.decide import turns_within

    assert turns_within(13, 10) is True
    assert turns_within(13.5, 10.5) is True  # 13.5 <= 13.65
    assert turns_within(6.5, 5) is True  # 恰好 1.3 倍
    assert turns_within(7, 5) is False


def test_exactly_two_failures_only_in_the_platform_arm_count_and_one_does_not() -> None:
    records = [session("a", "write", True, 10)] * 5
    records += [session("p", "write", True, 10)] * 4 + [session("p", "write", False, 10, "超时")]
    assert decide(records, "m")["criteria"]["没有只在平台臂出现两次以上的失败类型"] is True


def test_invalid_sessions_are_counted_but_not_judged() -> None:
    from aeval.decide import render_decision

    records = [session("a", "write", True, 10)] * 5 + [session("p", "write", True, 10)] * 5
    voided = {**session("p", "write", False, 1), "invalid": True}
    result = decide([*records, voided, voided, voided], "m")
    assert result["invalid"] == {"a": 0, "p": 3}
    assert result["passed"]["p"] == 5
    assert "相差悬殊" in render_decision(result)
    assert "样本不足" in render_decision(result)


def test_platform_arm_is_compared_with_arm_a_by_the_same_three_criteria() -> None:
    from aeval.decide import render_decision

    records = [session("a", "write", True, 10)] * 3 + [session("p", "write", True, 13)] * 3
    result = decide(records, "m", "p")
    assert result["passed"] == {"a": 3, "p": 3}
    assert result["criteria"] == {
        "通过的题数比臂 A 少不超过 1 题": True,
        "轮数的中位数不超过臂 A 的 1.3 倍": True,
        "没有只在平台臂出现两次以上的失败类型": True,
    }
    assert result["verdict"] == "平台臂没有明显变差"
    text = render_decision(result)
    assert "臂 A 对平台臂" in text and "| | 臂 A（本地） | 平台臂 |" in text
    records += [session("p", "write", False, 10, "超时")] * 2
    records += [session("a", "write", True, 10)] * 2
    assert decide(records, "m", "p")["verdict"].startswith("平台臂明显变差")
    # 以前结果目录里臂 B 的会话不算进平台臂的判定。
    assert decide(records + [session("b", "write", False, 99)], "m", "p") == decide(
        records, "m", "p"
    )
