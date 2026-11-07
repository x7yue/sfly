"""`shell`：在真实的执行器进程里执行命令（`sfly.testing.run_node`）。"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from sfly.testing import run_node
from sfly_std.shell import shell


def test_runs_the_command_and_outputs_exit_code_and_stdout(tmp_path: Path) -> None:
    result = run_node(shell, {"command": "echo 你好; echo 世界"}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert result.outputs == {"exit_code": 0, "stdout": "你好\n世界\n"}


def test_stdout_and_stderr_become_task_logs(tmp_path: Path) -> None:
    result = run_node(shell, {"command": "echo 标准输出; echo 标准错误 >&2"}, work_dir=tmp_path)

    assert result.status == "success", result.error
    # 两个来源之间的先后不确定（与 Agent 相同，分别读取）。
    assert sorted((line.source, line.message) for line in result.logs) == [
        ("stderr", "标准错误"),
        ("stdout", "标准输出"),
    ]


def test_logs_arrive_while_the_command_is_still_running(tmp_path: Path) -> None:
    result = run_node(
        shell,
        {"command": "echo 已启动; sleep 30"},
        cancel_when=lambda partial: any(line.message == "已启动" for line in partial.logs),
        work_dir=tmp_path,
    )

    assert result.status == "cancelled"
    assert "已启动" in [line.message for line in result.logs]


def test_fails_with_the_stderr_tail_when_the_exit_code_is_not_allowed(tmp_path: Path) -> None:
    command = "seq 1 2000 >&2; echo 找不到配置文件 >&2; exit 3"
    result = run_node(shell, {"command": command}, work_dir=tmp_path)

    assert result.status == "failed"
    assert result.error is not None
    message = result.error.message
    assert message.startswith(
        "sfly_std.shell.CommandFailed: 命令退出码 3，不在 ok_exit_codes [0] 中"
    ), message
    assert message.endswith("1999\n2000\n找不到配置文件"), message
    assert "\n1\n" not in message  # 只附末尾


def test_ok_exit_codes_lists_the_exit_codes_that_count_as_success(tmp_path: Path) -> None:
    result = run_node(shell, {"command": "exit 3", "ok_exit_codes": [0, 3]}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert result.outputs == {"exit_code": 3, "stdout": ""}


def test_zero_exit_code_fails_when_not_in_ok_exit_codes(tmp_path: Path) -> None:
    result = run_node(shell, {"command": "true", "ok_exit_codes": [1]}, work_dir=tmp_path)

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message.startswith(
        "sfly_std.shell.CommandFailed: 命令退出码 0，不在 ok_exit_codes [1] 中"
    )


def test_runs_with_sh_by_default(tmp_path: Path) -> None:
    result = run_node(shell, {"command": 'echo "$0"'}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert result.outputs == {"exit_code": 0, "stdout": "/bin/sh\n"}


def test_shell_selects_the_interpreter_that_runs_command_with_c(tmp_path: Path) -> None:
    result = run_node(
        shell,
        {"command": "import sys; print('来自', sys.argv[0])", "shell": sys.executable},
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    assert result.outputs == {"exit_code": 0, "stdout": "来自 -c\n"}


def test_fails_clearly_when_the_interpreter_does_not_exist(tmp_path: Path) -> None:
    result = run_node(shell, {"command": "true", "shell": "/no/such/shell"}, work_dir=tmp_path)

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message == "FileNotFoundError: 找不到解释器 /no/such/shell"


def test_env_is_added_to_the_inherited_environment(tmp_path: Path) -> None:
    result = run_node(
        shell,
        {"command": 'echo "$GREETING" "$PATH"', "env": {"GREETING": "你好"}},
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["stdout"] == f"你好 {os.environ['PATH']}\n"


def test_runs_in_the_task_work_dir_by_default(tmp_path: Path) -> None:
    result = run_node(shell, {"command": "pwd -P"}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["stdout"] == f"{tmp_path.resolve()}\n"


def test_cwd_sets_the_working_directory(tmp_path: Path) -> None:
    project = tmp_path / "项目"
    project.mkdir()

    result = run_node(shell, {"command": "pwd -P", "cwd": str(project)}, work_dir=tmp_path / "work")

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["stdout"] == f"{project.resolve()}\n"


def test_fails_clearly_when_cwd_does_not_exist(tmp_path: Path) -> None:
    missing = tmp_path / "missing"
    result = run_node(shell, {"command": "true", "cwd": str(missing)}, work_dir=tmp_path)

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.message == f"NotADirectoryError: 工作目录不存在：{missing}"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_cancel_terminates_the_whole_process_tree(tmp_path: Path) -> None:
    # 一个普通的后台进程，一个忽略 SIGTERM 的（宽限期过后被强制杀掉）。
    command = (
        "sleep 300 & echo $! > pids; "
        "sh -c 'trap \"\" TERM; while :; do sleep 1; done' & echo $! >> pids; "
        "echo 已启动; wait"
    )
    result = run_node(
        shell,
        {"command": command},
        cancel_when=lambda partial: any(line.message == "已启动" for line in partial.logs),
        grace=1,
        work_dir=tmp_path,
    )

    assert result.status == "cancelled"
    pids = [int(line) for line in (tmp_path / "pids").read_text().split()]
    assert len(pids) == 2
    deadline = time.monotonic() + 5
    while any(_alive(pid) for pid in pids) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert [pid for pid in pids if _alive(pid)] == []


def test_exit_code_of_a_command_killed_by_a_signal_is_128_plus_the_signal(tmp_path: Path) -> None:
    killed = run_node(shell, {"command": "kill -9 $$"}, work_dir=tmp_path / "a")
    allowed = run_node(
        shell, {"command": "kill -9 $$", "ok_exit_codes": [137]}, work_dir=tmp_path / "b"
    )

    assert killed.status == "failed"
    assert killed.error is not None
    assert killed.error.message.startswith(
        "sfly_std.shell.CommandFailed: "
        "命令被信号 SIGKILL 终止（退出码 137），不在 ok_exit_codes [0] 中"
    ), killed.error.message
    assert allowed.status == "success", allowed.error
    assert allowed.outputs == {"exit_code": 137, "stdout": ""}


def test_stdout_output_keeps_the_last_64_kib_without_broken_characters(tmp_path: Path) -> None:
    # 65536 不是 3 的倍数：截断处落在一个汉字（UTF-8 三个字节）中间。
    command = "import sys; sys.stdout.write('开头\\n' + '汉' * 30000)"
    result = run_node(shell, {"command": command, "shell": sys.executable}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["stdout"] == "汉" * 21845
