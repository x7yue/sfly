"""判分的汇总规则和「sfly debug」输出的解析。"""

from typing import Any

from aeval.tasks import GOAL, GUARD, INFO, Check, summarize
from aeval.tasks.fix import keeps_structure
from aeval.tasks.write import parse_debug_output


def test_all_goals_pass() -> None:
    result = summarize(
        [Check("a", True), Check("b", True, kind=GUARD), Check("c", False, kind=INFO)]
    )
    assert result["passed"] is True
    assert result["score"] == 1.0


def test_partial_goals() -> None:
    result = summarize([Check("a", True), Check("b", False), Check("c", True, kind=GUARD)])
    assert result["passed"] is False
    assert result["score"] == 0.5


def test_broken_guard_zeroes_the_score() -> None:
    result = summarize([Check("a", True), Check("b", False, kind=GUARD)])
    assert result == {
        "passed": False,
        "score": 0.0,
        "checks": [
            {"name": "a", "passed": True, "detail": "", "kind": GOAL},
            {"name": "b", "passed": False, "detail": "", "kind": GUARD},
        ],
    }


def test_parse_debug_output() -> None:
    stdout = '输出：\n{\n  "total": 2,\n  "counts": {"INFO": 2}\n}\n指标：\nx\n运行目录：/tmp/r\n'
    assert parse_debug_output(stdout) == {"total": 2, "counts": {"INFO": 2}}


def test_parse_debug_output_without_success() -> None:
    assert parse_debug_output("运行目录：/tmp/r\n") is None


ORIGINAL: dict[str, Any] = {
    "nodes": [
        {"id": "entry", "kind": "entry", "params": []},
        {
            "id": "a",
            "kind": "package",
            "package": "p",
            "node": "n",
            "display_name": "甲",
            "inputs": {"x": 1},
        },
    ],
    "edges": [{"from": "entry", "to": "a", "kind": "chain"}],
    "packages": {"p": "dev"},
    "annotations": [{"id": "an", "title": "框", "note": "说明", "nodes": ["a"]}],
}


def test_keeps_structure_allows_additions() -> None:
    document = {
        **ORIGINAL,
        "nodes": [*ORIGINAL["nodes"], {"id": "b", "kind": "package"}],
        "edges": [*ORIGINAL["edges"], {"from": "a", "to": "b", "kind": "chain"}],
        "annotations": [{"id": "an", "title": "框", "note": "说明", "nodes": ["a", "b"]}],
    }
    assert keeps_structure(document, ORIGINAL, {"p": "dev"}) == []


def test_keeps_structure_reports_weakened_input_and_lost_note() -> None:
    document = {
        **ORIGINAL,
        "nodes": [ORIGINAL["nodes"][0], {**ORIGINAL["nodes"][1], "inputs": {"x": 0}}],
        "annotations": [{"id": "an", "title": "框", "nodes": ["a"]}],
    }
    problems = keeps_structure(document, ORIGINAL, {"p": "dev"})
    assert len(problems) == 2
    assert "inputs" in problems[0]
    assert "note" in problems[1]


def test_keeps_structure_can_allow_annotation_text_changes() -> None:
    document = {**ORIGINAL, "annotations": [{"id": "an", "title": "新框", "nodes": ["a", "b"]}]}
    assert keeps_structure(document, ORIGINAL, {"p": "dev"}, annotation_text=False) == []
    assert len(keeps_structure(document, ORIGINAL, {"p": "dev"})) == 2


def test_plan_fills_only_missing_sessions_and_alternates_arms() -> None:
    from collections import Counter

    from aeval.cli import plan_sessions

    have = Counter({("write", "m", "a"): 2, ("fix", "m", "a"): 5})
    plan = plan_sessions(["write", "fix"], ["m"], ["a", "b"], 3, have)
    assert plan == [
        ("write", "m", 0, "b"),
        ("fix", "m", 0, "b"),
        ("write", "m", 1, "b"),
        ("fix", "m", 1, "b"),
        ("write", "m", 2, "a"),
        ("write", "m", 2, "b"),
        ("fix", "m", 2, "b"),
    ]


def test_parse_caps() -> None:
    from aeval.cli import parse_caps

    assert parse_caps(["a=37", "b=35"], ["a", "b"]) == {"a": 37, "b": 35}
    assert parse_caps(["10"], ["a", "b"]) == {"a": 10, "b": 10}
    assert parse_caps(None, ["a"]) == {}
