"""ruff 拦测试里的固定 sleep 和没用的 noqa（#432，规则在 pyproject.toml 的 [tool.ruff.lint]）：
各一条该拦的、一条不该拦的。用 `--stdin-filename` 按假定的路径查，不用在仓库里放文件。"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


def ruff(path: str, source: str) -> str:
    done = subprocess.run(
        ["ruff", "check", "--output-format", "concise", "--stdin-filename", path, "-"],
        cwd=REPO,
        input=source,
        capture_output=True,
        text=True,
        env={**{k: v for k, v in os.environ.items() if k != "FORCE_COLOR"}, "NO_COLOR": "1"},
    )
    return done.stdout


SLEEP = "import time\n\n\ndef test_x() -> None:\n    time.sleep(1)\n"


@pytest.mark.parametrize(
    "path", ["sdk/python/tests/test_x.py", "std/tests/test_x.py", "scripts/tests/test_x.py"]
)
def test_a_fixed_sleep_in_a_test_is_reported_with_how_to_fix(path: str) -> None:
    out = ruff(path, SLEEP)
    assert f"{path}:5:5: TID251" in out
    assert "polling.wait_for" in out


@pytest.mark.parametrize(
    ("path", "source"),
    [
        # 产品代码里可以 sleep（轮询、退避）。
        ("sdk/python/src/sfly/x.py", SLEEP),
        ("std/src/sfly_std/x.py", SLEEP),
        # 测试里确实要 sleep 时，那一行带原因放行。
        (
            "sdk/python/tests/test_x.py",
            SLEEP.replace("(1)", "(1)  # noqa: TID251 假的服务端回应慢"),
        ),
    ],
)
def test_sleep_outside_tests_or_with_a_reason_is_fine(path: str, source: str) -> None:
    assert "TID251" not in ruff(path, source)


def test_an_unused_noqa_is_reported() -> None:
    assert "RUF100" in ruff("sdk/python/src/sfly/x.py", "x = 1  # noqa: BLE001\n")
    assert "RUF100" not in ruff("sdk/python/src/sfly/x.py", "import os  # noqa: F401\n")
