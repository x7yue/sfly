"""`sfly_std.commands.run_command`：直接调用辅助函数。"""

from __future__ import annotations

from pathlib import Path

import pytest
from direct_context import DirectRun

from sfly_std.commands import CommandFailed, run_command


def test_returns_the_exit_code_and_the_output_tails(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)

    result = run_command(run.ctx, "echo 你好; echo 警告 >&2")

    assert (result.exit_code, result.stdout, result.stderr) == (0, "你好\n", "警告\n")
    assert result.stdout_file is None and result.stderr_file is None


def test_save_output_keeps_the_whole_output_as_artifacts(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)

    result = run_command(run.ctx, "echo 完整输出", save_output=True)

    assert result.stdout_file is not None
    assert (tmp_path / "artifacts" / "stdout.txt").read_text() == "完整输出\n"
    assert (tmp_path / "artifacts" / "stderr.txt").read_text() == ""


def test_an_exit_code_outside_ok_exit_codes_raises_with_the_end_of_stderr(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)

    with pytest.raises(CommandFailed, match=r"退出码 3.*\n\nstderr 末尾：\n出错了"):
        run_command(run.ctx, "echo 出错了 >&2; exit 3")


def test_ok_exit_codes_lets_other_exit_codes_through(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)

    assert run_command(run.ctx, "exit 3", ok_exit_codes=(0, 3)).exit_code == 3


def test_a_command_killed_by_a_signal_has_the_shell_style_exit_code(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)

    with pytest.raises(CommandFailed, match="SIGKILL.*退出码 137"):
        run_command(run.ctx, "kill -9 $$")


def test_env_and_cwd_apply_to_the_command(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)
    work = tmp_path / "work"
    work.mkdir()

    result = run_command(run.ctx, 'echo "$NAME $(pwd)"', env={"NAME": "值"}, cwd=str(work))

    assert result.stdout == f"值 {work.resolve()}\n"


def test_a_missing_interpreter_or_directory_is_reported_before_running(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)

    with pytest.raises(FileNotFoundError, match="找不到解释器 /no/such/shell"):
        run_command(run.ctx, "true", shell="/no/such/shell")
    with pytest.raises(NotADirectoryError):
        run_command(run.ctx, "true", cwd=str(tmp_path / "missing"))
