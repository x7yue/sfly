"""判分本身出错时，这次会话记 0 分而不是整轮中断。"""

from typing import Any

from aeval.session import grade_safely
from aeval.tasks import Check, Task, summarize


class Broken(Task):
    def grade(self, stack: Any) -> list[Check]:
        raise ValueError("unbalanced parenthesis")


def test_grading_error_scores_zero() -> None:
    result = summarize(grade_safely(Broken(), None))  # type: ignore[arg-type]
    assert result["passed"] is False
    assert result["score"] == 0.0
    assert "unbalanced parenthesis" in result["checks"][0]["detail"]
