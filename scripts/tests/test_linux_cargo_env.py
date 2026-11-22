"""`pnpm linux` 里 cargo 的编译配置（#587）：调试信息只留行号表，调用者设了就不覆盖。

带完整调试信息时每个测试可执行文件 100 多 MB，一个工作区的 target 长到几个 GB；
`line-tables-only` 让同样的构建小一半多、快几倍，回溯里的文件和行号还在。只在 `pnpm linux`
里设（`scripts/linux/cargo-env.sh`，`entry.sh` 在容器里 `source` 它），CI 和本机直接跑 cargo
不受影响。

`cargo-env.sh` 是被 `source` 的一小段，不需要 docker，直接在 bash 里测；`entry.sh` 里接上它、
`run.sh` 把宿主的两个变量传进容器，各检查一次接线（整条 `pnpm linux` 要构建好几 GB 的镜像，
这里不跑，PR 里用真实的 `pnpm linux` 核对过）。"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
LINUX = ROOT / "scripts" / "linux"
VARIABLES = ("CARGO_PROFILE_DEV_DEBUG", "CARGO_PROFILE_TEST_DEBUG")


def _sourced(extra: dict[str, str] | None = None) -> dict[str, str]:
    """在一个干净的环境里 `source` cargo-env.sh，返回之后的这两个变量（没设就不在结果里）。"""
    env = {k: v for k, v in os.environ.items() if k not in VARIABLES}
    env.update(extra or {})
    script = f"source {LINUX / 'cargo-env.sh'}; " + "; ".join(
        f'if [ -n "${{{name}+x}}" ]; then echo "{name}=${name}"; fi' for name in VARIABLES
    )
    done = subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=env)
    assert done.returncode == 0, done.stderr
    return dict(line.split("=", 1) for line in done.stdout.splitlines())


def test_by_default_only_the_line_tables_are_kept() -> None:
    assert _sourced() == {
        "CARGO_PROFILE_DEV_DEBUG": "line-tables-only",
        "CARGO_PROFILE_TEST_DEBUG": "line-tables-only",
    }


@pytest.mark.parametrize("value", ["true", "2", "full", "false"])
def test_what_the_caller_already_set_is_not_overridden(value: str) -> None:
    got = _sourced({"CARGO_PROFILE_DEV_DEBUG": value, "CARGO_PROFILE_TEST_DEBUG": value})

    assert got == {"CARGO_PROFILE_DEV_DEBUG": value, "CARGO_PROFILE_TEST_DEBUG": value}


def test_each_variable_is_decided_on_its_own() -> None:
    got = _sourced({"CARGO_PROFILE_DEV_DEBUG": "true"})

    assert got == {
        "CARGO_PROFILE_DEV_DEBUG": "true",
        "CARGO_PROFILE_TEST_DEBUG": "line-tables-only",
    }


def test_an_empty_value_counts_as_not_set() -> None:
    """宿主上 `export CARGO_PROFILE_DEV_DEBUG=`（空）不是一个有效的 cargo 取值：当作没设。"""
    got = _sourced({"CARGO_PROFILE_DEV_DEBUG": "", "CARGO_PROFILE_TEST_DEBUG": ""})

    assert got == {
        "CARGO_PROFILE_DEV_DEBUG": "line-tables-only",
        "CARGO_PROFILE_TEST_DEBUG": "line-tables-only",
    }


def test_the_variables_are_exported_so_cargo_sees_them() -> None:
    env = {k: v for k, v in os.environ.items() if k not in VARIABLES}
    done = subprocess.run(
        ["bash", "-c", f"source {LINUX / 'cargo-env.sh'}; env | grep ^CARGO_PROFILE_"],
        capture_output=True,
        text=True,
        env=env,
    )

    assert done.returncode == 0, done.stderr
    assert sorted(done.stdout.split()) == [
        "CARGO_PROFILE_DEV_DEBUG=line-tables-only",
        "CARGO_PROFILE_TEST_DEBUG=line-tables-only",
    ]


def test_entry_sh_sources_it_before_it_runs_the_command() -> None:
    lines = (LINUX / "entry.sh").read_text(encoding="utf-8").splitlines()
    sourced = [
        i
        for i, line in enumerate(lines)
        if line.strip() == "source /src/scripts/linux/cargo-env.sh"
    ]
    ran = [i for i, line in enumerate(lines) if line.startswith('exec "$@"')]

    assert len(sourced) == 1 and len(ran) == 1
    assert sourced[0] < ran[0]


def test_run_sh_passes_both_variables_into_the_container() -> None:
    text = (LINUX / "run.sh").read_text(encoding="utf-8")
    docker_run = text[text.index("docker run --rm --init") :]

    for name in VARIABLES:
        assert f"-e {name}" in docker_run
