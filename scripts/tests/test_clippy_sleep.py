"""clippy 拦测试里的固定 sleep（#432，规则在 clippy.toml 的 disallowed-methods）：
一条该拦的、一条带原因放行的。用一个临时的小 crate（不带依赖）按仓库的 clippy.toml 查。"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

pytestmark = pytest.mark.skipif(shutil.which("cargo") is None, reason="没有 cargo")


def clippy(tmp_path: Path, test_source: str) -> subprocess.CompletedProcess[str]:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "lib.rs").write_text("")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "waits.rs").write_text(test_source)
    (tmp_path / "Cargo.toml").write_text(
        '[package]\nname = "sleep-probe"\nversion = "0.0.0"\nedition = "2024"\n\n[workspace]\n'
    )
    return subprocess.run(
        ["cargo", "clippy", "--tests", "--offline", "--quiet", "--", "-D", "warnings"],
        cwd=tmp_path,
        env={**os.environ, "CLIPPY_CONF_DIR": str(REPO), "CARGO_TARGET_DIR": str(tmp_path / "t")},
        capture_output=True,
        text=True,
    )


SLEEP = "#[test]\nfn waits() {\n    std::thread::sleep(std::time::Duration::from_millis(1));\n}\n"


def test_a_fixed_sleep_in_a_test_is_reported_with_how_to_fix(tmp_path: Path) -> None:
    done = clippy(tmp_path, SLEEP)
    assert done.returncode != 0
    assert "disallowed_methods" in done.stderr
    assert "tests/waits.rs:3" in done.stderr
    assert "support::wait_until" in done.stderr


def test_a_sleep_with_an_allow_and_a_reason_is_fine(tmp_path: Path) -> None:
    allowed = SLEEP.replace(
        "    std::thread::sleep",
        "    #[allow(clippy::disallowed_methods)] // 假的服务端回应慢\n    std::thread::sleep",
    )
    done = clippy(tmp_path, allowed)
    assert done.returncode == 0, done.stderr
