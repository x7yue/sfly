"""`shell`：在真实的执行器进程里执行命令（`sfly.testing.run_node`）。"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from sfly.testing import Execution, run_node
from sfly_std.shell import shell


def outputs(exit_code: int = 0, stdout: str = "", stderr: str = "") -> dict[str, object]:
    """没有打开「保存完整输出」时的输出。"""
    return {
        "exit_code": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "stdout_file": None,
        "stderr_file": None,
    }


def test_runs_the_command_and_outputs_exit_code_and_stdout(tmp_path: Path) -> None:
    result = run_node(shell, {"command": "echo 你好; echo 世界"}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert result.outputs == outputs(stdout="你好\n世界\n")


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
    assert result.outputs == outputs(exit_code=3)


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
    assert result.outputs == outputs(stdout="/bin/sh\n")


def test_shell_selects_the_interpreter_that_runs_command_with_c(tmp_path: Path) -> None:
    result = run_node(
        shell,
        {"command": "import sys; print('来自', sys.argv[0])", "shell": sys.executable},
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    assert result.outputs == outputs(stdout="来自 -c\n")


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
    assert allowed.outputs == outputs(exit_code=137)


def test_stdout_output_keeps_the_last_64_kib_without_broken_characters(tmp_path: Path) -> None:
    # 65536 不是 3 的倍数：截断处落在一个汉字（UTF-8 三个字节）中间。
    command = "import sys; sys.stdout.write('开头\\n' + '汉' * 30000)"
    result = run_node(shell, {"command": command, "shell": sys.executable}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["stdout"] == "汉" * 21845


def test_outputs_stderr_next_to_stdout(tmp_path: Path) -> None:
    result = run_node(shell, {"command": "echo 结果; echo 警告 >&2"}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert result.outputs == outputs(stdout="结果\n", stderr="警告\n")
    assert result.artifacts == {}


def test_stderr_output_keeps_the_last_64_kib_without_broken_characters(tmp_path: Path) -> None:
    command = "import sys; sys.stderr.write('开头\\n' + '汉' * 30000)"
    result = run_node(shell, {"command": command, "shell": sys.executable}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert result.outputs["stderr"] == "汉" * 21845


def test_save_output_saves_the_complete_stdout_and_stderr_as_artifacts(tmp_path: Path) -> None:
    # 两路都超过 64 KiB，并带有不是合法 UTF-8 的字节：产物是原始字节，输出只留末尾。
    command = (
        "import sys; "
        "sys.stdout.buffer.write(b'\\xff\\x00out\\n' + b'a' * 200000 + b'\\n'); "
        "sys.stderr.buffer.write(b'\\xfe\\x00err\\n' + b'b' * 150000 + b'\\n')"
    )
    result = run_node(
        shell,
        {"command": command, "shell": sys.executable, "save_output": True},
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    assert sorted(result.artifacts) == ["stderr.txt", "stdout.txt"]
    assert result.artifacts["stdout.txt"].read_bytes() == b"\xff\x00out\n" + b"a" * 200000 + b"\n"
    assert result.artifacts["stderr.txt"].read_bytes() == b"\xfe\x00err\n" + b"b" * 150000 + b"\n"
    assert result.outputs == {
        "exit_code": 0,
        "stdout": "a" * 65535 + "\n",
        "stderr": "b" * 65535 + "\n",
        # 本地运行时产物引用是本地文件路径。
        "stdout_file": str(result.artifacts["stdout.txt"]),
        "stderr_file": str(result.artifacts["stderr.txt"]),
    }


def test_save_output_saves_empty_artifacts_when_the_command_prints_nothing(tmp_path: Path) -> None:
    result = run_node(shell, {"command": "true", "save_output": True}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert {name: path.read_bytes() for name, path in result.artifacts.items()} == {
        "stdout.txt": b"",
        "stderr.txt": b"",
    }


def test_save_output_keeps_the_artifacts_when_the_command_fails(tmp_path: Path) -> None:
    result = run_node(
        shell,
        {"command": "echo 做到一半; echo 出错了 >&2; exit 2", "save_output": True},
        work_dir=tmp_path,
    )

    assert result.status == "failed"
    assert {name: path.read_text() for name, path in result.artifacts.items()} == {
        "stdout.txt": "做到一半\n",
        "stderr.txt": "出错了\n",
    }


def test_save_output_writes_artifacts_and_logs_while_the_command_is_running(
    tmp_path: Path,
) -> None:
    artifacts = tmp_path / "artifacts"

    def started(partial: Execution) -> bool:
        logged = sorted((line.source, line.message) for line in partial.logs)
        try:
            saved = [(artifacts / f"{name}.txt").read_text() for name in ("stdout", "stderr")]
        except FileNotFoundError:
            return False
        return logged == [("stderr", "错"), ("stdout", "出")] and saved == ["出\n", "错\n"]

    result = run_node(
        shell,
        {"command": "echo 出; echo 错 >&2; sleep 30", "save_output": True},
        cancel_when=started,
        work_dir=tmp_path,
    )

    # 命令还在 sleep 时日志和产物内容就都到了，所以才会被取消。
    assert result.status == "cancelled"


def test_save_output_stops_at_what_the_outputs_hold_when_a_background_process_keeps_writing(
    tmp_path: Path,
) -> None:
    # 命令马上退出，留下的后台进程一直往 stdout 写：节点等够排空超时就不再转发，
    # 产物停在那一刻，与输出里的 stdout 相同。
    writer = "import time\nwhile True:\n    print('tick', flush=True)\n    time.sleep(0.001)"
    (tmp_path / "writer.py").write_text(writer)

    result = run_node(
        shell,
        {"command": f"{sys.executable} writer.py & echo 已启动", "save_output": True},
        work_dir=tmp_path,
    )

    assert result.status == "success", result.error
    assert result.outputs is not None
    stdout = result.outputs["stdout"]
    assert "tick\n" in stdout
    assert result.artifacts["stdout.txt"].read_bytes() == stdout.encode()
