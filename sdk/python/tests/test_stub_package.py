"""桩节点包（testdata/stub-package）自身的行为。"""

from __future__ import annotations

import os
import signal
from pathlib import Path

import pytest

from sfly import Context

STUB_SRC = Path(__file__).resolve().parents[3] / "testdata" / "stub-package" / "src"


@pytest.fixture(autouse=True)
def stub_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.syspath_prepend(str(STUB_SRC))


def test_stop_process_tolerates_the_process_exiting_before_it_is_signalled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sfly_stub import stop_process

    # 竞态的确定性复现：存活检查时进程还在，发 SIGTERM 时已经退出。
    exited = False

    def kill(pid: int, sig: int) -> None:
        nonlocal exited
        if sig == signal.SIGTERM:
            exited = True
        if exited:
            raise ProcessLookupError(3, "No such process")

    monkeypatch.setattr(os, "kill", kill)

    ctx = Context(events_path=None, cancel_path=None)
    assert stop_process(ctx, pid=12345) == {"was_running": True}
