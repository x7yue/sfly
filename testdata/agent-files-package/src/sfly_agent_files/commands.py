"""Agent 能力 exec 的测试用节点（#204）：在 source（不选时是自己所在的 Agent）上执行一条命令，
把退出码或调用失败的异常原样报告出来。任务被取消时 `sfly.Cancelled` 照常往外传。"""

from __future__ import annotations

from typing import Any

from sfly import AgentError, AgentName, Context, node


def _error(error: AgentError) -> dict[str, Any]:
    # 不从包的 __init__ 导入：联调测试会把包改名（full-stack-agent-files.test.ts）。
    return {
        "type": type(error).__name__,
        "kind": error.kind,
        "agent": error.agent,
        "message": str(error),
    }


@node(title="执行命令", outputs=["exit_code", "error"])
def run_command(
    ctx: Context,
    command: str = "",
    argv: list[str] | None = None,
    source: AgentName | None = None,
    timeout: float = 30.0,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """在 source 上执行 command（用 /bin/sh -c），给了 argv 时执行 argv（不经过 shell）。"""
    print("开始执行命令")
    try:
        code = ctx.agent(source).exec.run(
            argv if argv is not None else command, timeout=timeout, cwd=cwd, env=env
        )
    except AgentError as error:
        return {"exit_code": None, "error": _error(error)}
    return {"exit_code": code, "error": None}
