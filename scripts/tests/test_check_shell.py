"""shell 脚本的检查（scripts/check_shell.py）：变量后面紧跟汉字、没写原因的放行、
shellcheck 报的问题。"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "check_shell.py"
spec = importlib.util.spec_from_file_location("check_shell", SCRIPT)
assert spec is not None and spec.loader is not None
check_shell = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_shell)
REPO = check_shell.REPO


def test_a_variable_followed_by_chinese_is_reported_with_the_fix() -> None:
    [problem] = check_shell.own_problems("a.sh", 'echo "需要 Node $required（.node-version）"\n')
    assert problem.startswith("a.sh:1:15: $required 后面紧跟着汉字，写成 ${required}")


@pytest.mark.parametrize(
    "line",
    [
        'echo "需要 Node ${required}（.node-version）"',
        'echo "需要 \\$required（转义的不算）"',
        'echo "$$（进程号）"',
        "# 注释里的 $required（不查）",
        'echo "$required: ascii"',
    ],
)
def test_braces_escapes_comments_and_ascii_are_fine(line: str) -> None:
    assert check_shell.own_problems("a.sh", line + "\n") == []


def test_a_disable_needs_a_reason() -> None:
    [problem] = check_shell.own_problems("a.sh", "# shellcheck disable=SC2086\nrm $x\n")
    assert "a.sh:1:" in problem and "没有写原因" in problem
    assert check_shell.own_problems("a.sh", "# shellcheck disable=SC2086 # 要拆成多个参数\n") == []


@pytest.mark.parametrize("locale", ["en_US.UTF-8", "C"])
def test_the_braced_form_works_under_both_locales(locale: str) -> None:
    """改成 `${x}` 之后在两种语言环境下都正常
    （macOS 的 bash 3.2 下，`$x（` 在 UTF-8 里报 unbound variable）。"""
    done = subprocess.run(
        ["bash", "-uc", 'x=1; echo "${x}（"'],
        env={**os.environ, "LC_ALL": locale},
        capture_output=True,
        text=True,
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout == "1（\n"


def has_shellcheck() -> bool:
    if shutil.which("shellcheck"):
        return True
    return bool(shutil.which("docker")) and (
        subprocess.run(["docker", "info"], capture_output=True, check=False).returncode == 0
    )


@pytest.fixture
def scratch() -> Iterator[Path]:
    """仓库里的临时目录：docker 只挂载了仓库。"""
    path = Path(tempfile.mkdtemp(prefix=".check-shell-", dir=REPO))
    # mkdtemp 建的目录只有自己读得到；容器里的 shellcheck 用的是别的用户。
    path.chmod(0o755)
    yield path
    shutil.rmtree(path)


@pytest.mark.skipif(not has_shellcheck(), reason="没有 docker 也没有 shellcheck")
def test_shellcheck_problems_fail_with_their_location(
    scratch: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    bad = scratch / "bad.sh"
    bad.write_text('#!/usr/bin/env bash\ncd "$1"\nrm $2\n')
    good = scratch / "good.sh"
    good.write_text('#!/usr/bin/env bash\ncd "$1" || exit 1\nrm -- "$2"\n')

    def rel(p: Path) -> str:
        return str(p.relative_to(REPO))

    assert check_shell.main([rel(bad)]) == 1
    err = capsys.readouterr().err
    assert f"{rel(bad)}:2:" in err and "SC2164" in err
    assert f"{rel(bad)}:3:" in err and "SC2086" in err

    assert check_shell.main([rel(good)]) == 0


@pytest.mark.skipif(not has_shellcheck(), reason="没有 docker 也没有 shellcheck")
def test_posix_sh_scripts_are_checked_as_sh(
    scratch: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    script = scratch / "posix.sh"
    script.write_text('#!/bin/sh\nif [[ -n "$1" ]]; then echo yes; fi\n')
    assert check_shell.main([str(script.relative_to(REPO))]) == 1
    assert "SC3010" in capsys.readouterr().err
