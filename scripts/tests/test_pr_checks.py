"""PR 信息的检查（scripts/pr_checks.py）：生成类型改了要标兼容性，关键路径改了要提醒；
清单里的路径都还在。"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "pr_checks.py"
spec = importlib.util.spec_from_file_location("pr_checks", SCRIPT)
assert spec is not None and spec.loader is not None
pr_checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pr_checks)
BREAKING, COMPATIBLE, REPO = pr_checks.BREAKING, pr_checks.COMPATIBLE, pr_checks.REPO
check, critical_paths = pr_checks.check, pr_checks.critical_paths

CRITICAL = [
    {"name": "指标合并", "detail": "", "paths": ["agent/src/metrics.rs"]},
    {"name": "指标写入", "detail": "", "paths": ["apps/server/src/metrics/"]},
]
GENERATED = "packages/client/src/generated/types.ts"


def test_generated_types_need_exactly_one_compatibility_label() -> None:
    for labels in (set(), {"enhancement"}, {BREAKING, COMPATIBLE}):
        errors, _ = check([GENERATED, "README.md"], labels, CRITICAL)
        assert len(errors) == 1, labels
        assert GENERATED in errors[0]
        assert "README.md" not in errors[0]
    for label in (BREAKING, COMPATIBLE):
        assert check([GENERATED], {label}, CRITICAL) == ([], [])


def test_without_generated_types_no_label_is_needed() -> None:
    assert check(["packages/client/src/index.ts", "docs/x.md"], set(), CRITICAL) == ([], [])


def test_critical_paths_only_warn() -> None:
    errors, warnings = check(
        ["agent/src/metrics.rs", "apps/server/src/metrics/task-metrics.ts", "agent/src/lib.rs"],
        set(),
        CRITICAL,
    )
    assert errors == []
    assert len(warnings) == 2
    assert "指标合并" in warnings[0] and "agent/src/metrics.rs" in warnings[0]
    assert "apps/server/src/metrics/task-metrics.ts" in warnings[1]
    assert "agent/src/lib.rs" not in "".join(warnings)
    # 目录要以 / 结尾才按前缀算：同名前缀的别的文件不命中。
    assert check(
        ["agent/src/metrics.rs.bak", "apps/server/src/metrics-old.ts"], set(), CRITICAL
    ) == (
        [],
        [],
    )


def test_every_listed_path_exists() -> None:
    entries = critical_paths()
    assert entries
    for entry in entries:
        for path in entry["paths"]:
            target = REPO / path
            assert target.is_dir() if path.endswith("/") else target.is_file(), path


def test_the_branch_doc_points_at_the_list() -> None:
    text = (REPO / "docs/agents/branching-and-release.md").read_text(encoding="utf-8")
    assert "docs/agents/perf-critical-paths.json" in text


@pytest.mark.parametrize(
    ("files", "labels", "code", "shown"),
    [
        ([GENERATED], [], 1, "::error::"),
        ([GENERATED], [COMPATIBLE], 0, "PR 信息没有问题"),
        (["agent/src/metrics.rs"], [], 0, "::warning::"),
    ],
)
def test_command_line(
    tmp_path: Path, files: list[str], labels: list[str], code: int, shown: str
) -> None:
    (tmp_path / "files").write_text("\n".join(files) + "\n", encoding="utf-8")
    (tmp_path / "labels").write_text("\n".join(labels), encoding="utf-8")
    done = subprocess.run(
        [
            sys.executable,
            str(REPO / "scripts/pr_checks.py"),
            str(tmp_path / "files"),
            str(tmp_path / "labels"),
        ],
        capture_output=True,
        text=True,
    )
    assert done.returncode == code
    assert shown in done.stdout
