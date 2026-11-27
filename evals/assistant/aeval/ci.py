"""CI 里的评测（`./aeval.sh ci`，#552）：平台臂、假的模型端点，每道题一次，全部通过才算过。

先 `up --assistant` 起好环境。不论会话结果如何、中途有没有出错，最后都扫一遍结果目录里的凭据
（`leakscan`）；退出码告诉工作流结果目录能不能作为产物上传：

- `PASSED`（0）：都通过，没扫到凭据；
- `FAILED`（4）：有题没通过或出错，没扫到凭据：上传，供排查；
- `LEAKED`（5）：扫到凭据：不上传，job 失败。
"""

from __future__ import annotations

import traceback
from collections.abc import Callable
from pathlib import Path

from aeval import docker as d
from aeval import leakscan
from aeval.env import Stack
from aeval.models import load_models
from aeval.session import run_session
from aeval.tasks.registry import TASKS

TASK_IDS = ("write", "fix", "orchestrate", "cross")
PASSED = 0
FAILED = 4
LEAKED = 5
# 没通过时把这几个容器的日志放进结果目录（也会被扫）：镜像站的日志里有缓存里没找到的路径。
LOG_ROLES = ("cp", "assistant", "mirror")
LOG_TAIL = "3000"


def run(
    stack: Stack,
    results: Path,
    tasks: tuple[str, ...] = TASK_IDS,
    say: Callable[[str], None] = print,
) -> int:
    results.mkdir(parents=True, exist_ok=True)
    # 每次会话前 reset 都换一个管理员密码：每一个都要扫。
    secrets: list[str | None] = [stack.assistant_secret]
    failed: list[str] = []
    try:
        model = load_models()["fake"]
        for task_id in tasks:
            record = run_session(
                stack, TASKS[task_id], model, results, session_id=f"{task_id}-fake-p", arm="p"
            )
            secrets.append(stack.admin_password)
            passed = not record["invalid"] and record["grade"]["passed"]
            verdict = (
                "通过" if passed else f"不通过（{(record.get('failure') or {}).get('primary')}）"
            )
            say(f"{task_id}：{verdict}，得分 {record['grade']['score']}")
            if not passed:
                failed.append(task_id)
    except Exception:
        say(traceback.format_exc())
        secrets.append(stack.admin_password)
        failed.append("评测出错")
    if failed:
        save_logs(stack, results / "containers")
    leaks = leakscan.scan(results, secrets)
    for file, kind in leaks:
        say(f"结果目录里有凭据（{kind}）：{file}")
    if leaks:
        say("扫到凭据：结果目录不能上传")
        return LEAKED
    if failed:
        say(f"没通过：{'、'.join(failed)}")
        return FAILED
    say(f"{len(tasks)} 道题都通过")
    return PASSED


def save_logs(stack: Stack, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for role in LOG_ROLES:
        logs = d.docker("logs", "--tail", LOG_TAIL, stack.name(role), check=False)
        (out / f"{role}.log").write_text(logs.stdout + logs.stderr)
