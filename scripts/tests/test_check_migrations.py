"""迁移日志检查（scripts/check_migrations.py）：每条规则各有一个该拦的、一个不该拦的，
报错要写明是哪一条、怎么改。每个用例在临时目录里造一份迁移目录，不碰真实的 apps/server/drizzle
（最后几个用例检查真实的目录）。"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "check_migrations.py"
spec = importlib.util.spec_from_file_location("check_migrations", SCRIPT)
assert spec is not None and spec.loader is not None
check_migrations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_migrations)

REAL = Path(__file__).resolve().parents[2] / "apps" / "server" / "drizzle"


def make(
    tmp_path: Path, entries: list[tuple[int, str, int]], *, skip: tuple[str, ...] = ()
) -> Path:
    """迁移目录：`entries` 是（编号, tag, when）；`skip` 里的文件不建
    （写成 `0001_b.sql`、`meta/0001_snapshot.json`）。"""
    directory = tmp_path / "drizzle"
    (directory / "meta").mkdir(parents=True)
    journal: dict[str, Any] = {
        "version": "7",
        "dialect": "postgresql",
        "entries": [
            {"idx": idx, "version": "7", "when": when, "tag": tag, "breakpoints": True}
            for idx, tag, when in entries
        ],
    }
    (directory / "meta" / "_journal.json").write_text(json.dumps(journal), encoding="utf-8")
    for idx, tag, _ in entries:
        if f"{tag}.sql" not in skip:
            (directory / f"{tag}.sql").write_text("select 1;", encoding="utf-8")
        if f"meta/{idx:04d}_snapshot.json" not in skip:
            (directory / "meta" / f"{idx:04d}_snapshot.json").write_text("{}", encoding="utf-8")
    return directory


GOOD = [(0, "0000_a", 1000), (1, "0001_b", 2000), (2, "0002_c", 3000)]


def test_a_consistent_directory_has_no_problems(tmp_path: Path) -> None:
    assert check_migrations.check(make(tmp_path, GOOD)) == []


def test_a_when_not_larger_than_the_previous_one_is_caught_with_a_way_to_fix_it(
    tmp_path: Path,
) -> None:
    # 后合入的一方重新排号，只改了编号和文件名、没改 when：在已经执行过前一条的库上会被静默跳过。
    [problem] = check_migrations.check(
        make(tmp_path, [(0, "0000_a", 1000), (1, "0001_b", 3000), (2, "0002_c", 2500)])
    )

    assert "0002_c 的 when（2500）不比前一条 0001_b 的（3000）大" in problem
    assert "静默跳过" in problem
    assert "把 0002_c 的 when 改成比 0001_b 大的值" in problem


def test_an_equal_when_is_caught_too(tmp_path: Path) -> None:
    [problem] = check_migrations.check(make(tmp_path, [(0, "0000_a", 1000), (1, "0001_b", 1000)]))

    assert "0001_b 的 when（1000）不比前一条 0000_a 的（1000）大" in problem


def test_the_suggested_when_is_larger_than_every_earlier_one(tmp_path: Path) -> None:
    far_future = 99_999_999_999_999
    [problem] = check_migrations.check(
        make(tmp_path, [(0, "0000_a", far_future), (1, "0001_b", 5)])
    )

    assert f"例如 {far_future + 1}" in problem


def test_entries_are_compared_in_number_order_not_in_file_order(tmp_path: Path) -> None:
    directory = make(tmp_path, GOOD)
    journal_path = directory / "meta" / "_journal.json"
    journal = json.loads(journal_path.read_text())
    journal["entries"].reverse()
    journal_path.write_text(json.dumps(journal))

    assert check_migrations.check(directory) == []


def test_a_gap_in_the_numbers_is_caught(tmp_path: Path) -> None:
    [problem] = check_migrations.check(
        make(tmp_path, [(0, "0000_a", 1000), (1, "0001_b", 2000), (3, "0003_d", 3000)])
    )

    assert "编号 0002 缺了" in problem


def numbered(numbers: list[int]) -> list[tuple[int, str, int]]:
    """给定编号的条目，`when` 按编号递增。"""
    return [(n, f"{n:04d}_m", 1000 + n) for n in numbers]


def test_the_historical_gap_is_let_through(tmp_path: Path) -> None:
    # 0027 是历史上没有合入过的编号：放过；别的缺口不放过（上一个用例）。
    numbers = [*range(27), *range(28, 30)]

    assert check_migrations.check(make(tmp_path, numbered(numbers))) == []


def test_a_known_missing_number_that_now_has_a_migration_is_reported(tmp_path: Path) -> None:
    [problem] = check_migrations.check(make(tmp_path, numbered(list(range(30)))))

    assert "KNOWN_MISSING 里的 0027 现在有迁移了" in problem


def test_two_entries_with_the_same_number_are_caught(tmp_path: Path) -> None:
    problems = check_migrations.check(
        make(tmp_path, [(0, "0000_a", 1000), (1, "0001_b", 2000), (1, "0001_c", 3000)])
    )

    assert any("编号 0001 有两条：0001_b 和 0001_c" in p for p in problems)


def test_a_name_whose_number_differs_from_the_entry_is_caught(tmp_path: Path) -> None:
    # 重新排号时只改了日志里的 idx、没有改名字（或反过来）。
    [problem] = check_migrations.check(make(tmp_path, [(0, "0000_a", 1000), (1, "0002_b", 2000)]))

    assert "第 0001 条的名字是 0002_b，前四位应该是 0001" in problem


def test_an_entry_without_its_sql_file_is_caught(tmp_path: Path) -> None:
    [problem] = check_migrations.check(make(tmp_path, GOOD, skip=("0001_b.sql",)))

    assert "日志里有 0001_b，但没有" in problem
    assert "0001_b.sql" in problem


def test_an_entry_without_its_snapshot_is_caught(tmp_path: Path) -> None:
    [problem] = check_migrations.check(make(tmp_path, GOOD, skip=("meta/0002_snapshot.json",)))

    assert "日志里有 0002_c，但没有" in problem
    assert "0002_snapshot.json" in problem


def test_an_sql_file_that_is_not_in_the_journal_is_caught(tmp_path: Path) -> None:
    directory = make(tmp_path, GOOD)
    (directory / "0003_left_over.sql").write_text("select 1;", encoding="utf-8")

    [problem] = check_migrations.check(directory)

    assert "0003_left_over.sql 不在 _journal.json 里" in problem
    assert "drizzle 不会执行它" in problem


def test_a_snapshot_without_an_entry_is_caught(tmp_path: Path) -> None:
    directory = make(tmp_path, GOOD)
    (directory / "meta" / "0003_snapshot.json").write_text("{}", encoding="utf-8")

    [problem] = check_migrations.check(directory)

    assert "0003_snapshot.json 没有对应的日志条目" in problem


def test_an_unreadable_journal_is_reported_instead_of_crashing(tmp_path: Path) -> None:
    directory = make(tmp_path, GOOD)
    (directory / "meta" / "_journal.json").write_text("{oops", encoding="utf-8")

    [problem] = check_migrations.check(directory)

    assert "读不了迁移日志" in problem


def run_script(directory: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(directory)], capture_output=True, text=True, check=False
    )


def test_the_command_fails_with_exit_code_1_and_prints_every_problem(tmp_path: Path) -> None:
    result = run_script(
        make(tmp_path, [(0, "0000_a", 3000), (1, "0001_b", 2000), (3, "0003_d", 1000)])
    )

    assert result.returncode == 1
    assert result.stdout == ""
    assert "0001_b 的 when（2000）不比前一条 0000_a 的（3000）大" in result.stderr
    assert "0003_d 的 when（1000）不比前一条 0001_b 的（2000）大" in result.stderr
    assert "编号 0002 缺了" in result.stderr
    assert "迁移日志有 3 处不对" in result.stderr


def test_the_command_passes_on_a_consistent_directory(tmp_path: Path) -> None:
    result = run_script(make(tmp_path, GOOD))

    assert (result.returncode, result.stdout, result.stderr) == (0, "", "")


def test_the_real_migrations_directory_is_consistent() -> None:
    assert check_migrations.check(REAL) == []


@pytest.mark.parametrize("known", sorted(check_migrations.KNOWN_MISSING))
def test_every_known_missing_number_is_really_missing_in_the_real_directory(known: int) -> None:
    assert not list(REAL.glob(f"{known:04d}_*.sql"))
