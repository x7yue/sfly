"""`shell`：用解释器（默认 `/bin/sh`）执行一段命令。

用法与安全说明见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `shell` 一节；
逻辑在辅助函数 `sfly_std.commands.run_command`，这里是它的节点外壳。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated, TypedDict

from sfly import Context, Doc, node
from sfly_std.commands import CommandFailed as _CommandFailed
from sfly_std.commands import run_command

__all__ = ["CommandFailed", "shell"]


class CommandFailed(_CommandFailed):
    """命令的退出码不在 `ok_exit_codes` 中（节点失败时的错误类型：和 0.3.0 一样写成
    `sfly_std.shell.CommandFailed`）。"""


class ShellOutputs(TypedDict):
    exit_code: Annotated[int, Doc("退出码；命令被信号终止时为 128 + 信号值（与 shell 的 $? 相同）")]
    stdout: Annotated[str, Doc("标准输出的最后 64 KiB")]
    stderr: Annotated[str, Doc("标准错误的最后 64 KiB")]
    stdout_file: Annotated[
        str | None, Doc("产物 stdout.txt（完整的标准输出）的引用；save_output 为 false 时是空值")
    ]
    stderr_file: Annotated[
        str | None, Doc("产物 stderr.txt（完整的标准错误）的引用；save_output 为 false 时是空值")
    ]


@node(title="Shell 命令")
def shell(
    ctx: Context,
    command: Annotated[str, Doc("要执行的命令")],
    shell: Annotated[
        str, Doc("解释器：/bin/bash、python3 等任何能用 -c 执行一段命令的程序")
    ] = "/bin/sh",
    env: Annotated[
        dict[str, str] | None, Doc("追加的环境变量（对象，值为字符串），在 Agent 的环境变量之上")
    ] = None,
    cwd: Annotated[str | None, Doc("工作目录，必须已经存在")] = None,
    ok_exit_codes: Annotated[Sequence[int], Doc("算作成功的退出码")] = (0,),
    save_output: Annotated[
        bool, Doc("保存完整输出：为 true 时把完整的标准输出和标准错误各保存为一个产物")
    ] = False,
) -> ShellOutputs:
    """执行一段命令，输出退出码、标准输出和标准错误。

    副作用：命令做什么，就有什么副作用。
    标准输出和标准错误实时转为任务日志。
    打开 save_output 时，完整的标准输出和标准错误各保存为一个产物。
    命令退出时还在运行的后台进程不会被终止。

    失败：退出码不在 ok_exit_codes 里时失败，错误信息是退出码、命令和标准错误的末尾。
    解释器或工作目录不存在时也失败。
    任务被取消或超时时，命令和它启动的全部子进程都会被终止。
    """
    try:
        result = run_command(
            ctx,
            command,
            shell=shell,
            env=env,
            cwd=cwd,
            ok_exit_codes=ok_exit_codes,
            save_output=save_output,
            # 节点的产物名称固定：一个任务只执行一次 shell。
            stdout_artifact="stdout.txt" if save_output else None,
            stderr_artifact="stderr.txt" if save_output else None,
        )
    except _CommandFailed as error:
        raise CommandFailed(*error.args) from None
    return {
        "exit_code": result.exit_code,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "stdout_file": result.stdout_ref,
        "stderr_file": result.stderr_ref,
    }
