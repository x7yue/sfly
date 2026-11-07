"""`file_assert`：在真实的执行器进程里检查一次文件的状态（`sfly.testing.run_node`）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sfly.testing import Execution, run_node
from sfly_std.file_assert import file_assert


def run(tmp_path: Path, **inputs: Any) -> Execution:
    return run_node(file_assert, inputs, work_dir=tmp_path / "task")


def failure(result: Execution) -> str:
    assert result.status == "failed", result.outputs
    assert result.error is not None
    return result.error.message


def test_passes_when_the_file_exists(tmp_path: Path) -> None:
    (tmp_path / "ready").write_text("")

    result = run(tmp_path, path=str(tmp_path / "ready"))

    assert result.status == "success", result.error
    assert result.outputs == {"passed": True}


def test_fails_when_the_file_does_not_exist(tmp_path: Path) -> None:
    path = tmp_path / "ready"

    assert failure(run(tmp_path, path=str(path))) == (
        f"sfly_std.file_assert.FileAssertionFailed: {path} 应存在，实际不存在"
    )


def test_exists_false_passes_when_absent_and_fails_when_present(tmp_path: Path) -> None:
    path = tmp_path / "app.pid"

    assert run(tmp_path, path=str(path), exists=False).status == "success"
    path.write_text("123")
    assert failure(run(tmp_path, path=str(path), exists=False)) == (
        f"sfly_std.file_assert.FileAssertionFailed: {path} 应不存在，实际存在"
    )


def test_checks_size_lines_and_content_together(tmp_path: Path) -> None:
    path = tmp_path / "app.log"
    path.write_text("启动\nlistening on 8080\n", encoding="utf-8")  # 2 行，25 字节

    result = run(
        tmp_path,
        path=str(path),
        min_size=25,
        max_size=25,
        min_lines=2,
        max_lines=2,
        matches=r"^listening on \d+$",
    )

    assert result.status == "success", result.error


def test_lists_every_failed_check_with_expected_and_actual(tmp_path: Path) -> None:
    path = tmp_path / "app.log"
    path.write_text("启动\nERROR 端口被占用\n", encoding="utf-8")  # 2 行，29 字节

    message = failure(
        run(
            tmp_path,
            path=str(path),
            min_size=1,
            max_size=10,
            max_lines=0,
            matches="listening on",
        )
    )

    assert message == (
        f"sfly_std.file_assert.FileAssertionFailed: {path} 的 4 项检查中 3 项不通过：\n"
        "- 大小应 ≤ 10 字节，实际是 29 字节\n"
        "- 行数应 ≤ 0，实际是 2 行\n"
        '- 内容应匹配正则 "listening on"，实际没有匹配'
    )


def test_a_last_line_without_newline_still_counts(tmp_path: Path) -> None:
    path = tmp_path / "out.txt"
    path.write_text("a\nb", encoding="utf-8")

    assert run(tmp_path, path=str(path), min_lines=2, max_lines=2).status == "success"
    path.write_text("", encoding="utf-8")
    assert run(tmp_path, path=str(path), max_lines=0).status == "success"


def test_rejects_other_checks_when_the_file_should_not_exist(tmp_path: Path) -> None:
    result = run(tmp_path, path=str(tmp_path / "x"), exists=False, max_size=0)

    assert failure(result) == "ValueError: exists 为 false 时不能再给 max_size"


def test_rejects_an_invalid_regex(tmp_path: Path) -> None:
    (tmp_path / "x").write_text("a")

    assert failure(run(tmp_path, path=str(tmp_path / "x"), matches="(")).startswith(
        "ValueError: matches 不是合法的正则表达式：'('（"
    )


def test_fails_when_a_content_check_is_given_for_a_directory(tmp_path: Path) -> None:
    assert run(tmp_path, path=str(tmp_path)).status == "success"
    assert failure(run(tmp_path, path=str(tmp_path), max_lines=10)) == (
        "sfly_std.file_assert.FileAssertionFailed: "
        f"{tmp_path} 不是普通文件，不能检查大小、行数和内容"
    )
