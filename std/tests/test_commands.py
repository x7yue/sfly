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
    assert result.stdout_artifact is None and result.stderr_artifact is None


def test_save_output_keeps_the_whole_output_as_artifacts(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)

    result = run_command(run.ctx, "echo 完整输出", save_output=True)

    assert result.stdout_file is not None
    assert (result.stdout_artifact, result.stderr_artifact) == ("stdout.txt", "stderr.txt")
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

    result = run_command(run.ctx, 'echo "$NAME $(pwd)"', env={"NAME": "值"}, cwd=work)

    assert result.stdout == f"值 {work.resolve()}\n"


def test_a_missing_interpreter_or_directory_is_reported_before_running(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)

    with pytest.raises(FileNotFoundError, match="找不到解释器 /no/such/shell"):
        run_command(run.ctx, "true", shell="/no/such/shell")
    with pytest.raises(NotADirectoryError):
        run_command(run.ctx, "true", cwd=str(tmp_path / "missing"))


def test_every_call_saves_its_output_under_a_different_artifact_name(tmp_path: Path) -> None:
    # 一个业务节点里会多次调用：前一次的完整输出不能被后一次覆盖。
    run = DirectRun(tmp_path)
    artifacts = tmp_path / "artifacts"

    first = run_command(run.ctx, "echo 第一次; echo 第一次错误 >&2", save_output=True)
    second = run_command(run.ctx, "echo 第二次; echo 第二次错误 >&2", save_output=True)
    third = run_command(run.ctx, "echo 第三次", save_output=True)

    assert [r.stdout_artifact for r in (first, second, third)] == [
        "stdout.txt",
        "stdout-2.txt",
        "stdout-3.txt",
    ]
    assert [r.stderr_artifact for r in (first, second, third)] == [
        "stderr.txt",
        "stderr-2.txt",
        "stderr-3.txt",
    ]
    assert len({r.stdout_file for r in (first, second, third)}) == 3
    assert (artifacts / "stdout.txt").read_text() == "第一次\n"
    assert (artifacts / "stderr.txt").read_text() == "第一次错误\n"
    assert (artifacts / "stdout-2.txt").read_text() == "第二次\n"
    assert (artifacts / "stderr-2.txt").read_text() == "第二次错误\n"
    assert first.stdout_file is not None and first.stdout_file.endswith("stdout.txt")


def test_the_artifact_names_can_be_chosen_and_then_they_are_used_as_given(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)
    artifacts = tmp_path / "artifacts"

    a = run_command(
        run.ctx,
        "echo 构建",
        save_output=True,
        stdout_artifact="构建/out.txt",
        stderr_artifact="构建/err.txt",
    )
    assert (a.stdout_artifact, a.stderr_artifact) == ("构建/out.txt", "构建/err.txt")
    assert (artifacts / "构建" / "out.txt").read_text() == "构建\n"
    # 指定的名字直接用（同名的覆盖），不指定的接着默认名字往下排。
    run_command(run.ctx, "echo 覆盖", save_output=True, stdout_artifact="构建/out.txt")
    assert (artifacts / "构建" / "out.txt").read_text() == "覆盖\n"
    default = run_command(run.ctx, "echo 默认", save_output=True)
    assert default.stdout_artifact == "stdout.txt"
    with pytest.raises(ValueError, match="stdout_artifact.*save_output"):
        run_command(run.ctx, "true", stdout_artifact="x.txt")


def test_a_command_that_cannot_start_leaves_no_empty_artifacts(tmp_path: Path) -> None:
    run = DirectRun(tmp_path)

    with pytest.raises(FileNotFoundError, match="找不到解释器"):
        run_command(run.ctx, "true", shell="/no/such/shell", save_output=True)

    assert not (tmp_path / "artifacts" / "stdout.txt").exists()
    # 解释器不存在抛出 FileNotFoundError，工作目录不存在抛出 NotADirectoryError。
    with pytest.raises(NotADirectoryError):
        run_command(run.ctx, "true", cwd=tmp_path / "missing")
