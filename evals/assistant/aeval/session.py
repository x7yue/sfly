"""跑一次会话：重置环境、准备题目、让容器里的 pi 做题、判分、把记录存到本机。

一次会话的记录在 `<结果目录>/<会话 ID>/`：
- `session.json`：题目、模型、判分、轮数、用时、token、内存峰值、失败分类；
- `events.jsonl`：pi 的事件流；`pi-session/`：pi 自己的会话文件；`pi-stderr.log`；
- `workspace.diff`：节点包目录相对初始状态的改动（`git diff`，含新文件）；
- `runs.json`：会话期间控制面上的运行（谁触发的、状态、起止时间）。
"""

from __future__ import annotations

import json
import shlex
import subprocess
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from aeval import docker as d
from aeval.classify import INFRA, classify, is_assistant_run
from aeval.env import OPT, Stack
from aeval.models import PROVIDER, Model
from aeval.tasks import Check, Task, stage_reference, summarize

DRIVER = f"{OPT}/session_driver.py"
SESSION_DIR = "/root/aeval-session"


# 臂：a 原版 pi 在开发环境里，工具在本地执行；p 平台：经控制面的会话接口交给平台内的助手
# （aeval.platform，#552）。#443 的臂 B（工具经能力端口落到开发环境的原型）在 #552 删掉了。
ARMS = ("a", "p")
# 助手的命令带上的环境变量：控制面把它的操作记成「eval 经 pi」，和判分（grader）的操作分开。
ASSISTANT_ENV = {"SFLY_NICKNAME": "eval", "AI_AGENT": "pi"}


def prepare_pi(stack: Stack, model: Model, container: str | None = None) -> None:
    config = json.dumps(model.pi_models_json(), ensure_ascii=False)
    d.docker(
        "exec",
        "-i",
        container or stack.dev,
        "sh",
        "-c",
        "mkdir -p /root/.pi/agent && cat > /root/.pi/agent/models.json",
        input_text=config,
    )


def grade_safely(task: Task, stack: Stack) -> list[Check]:
    """判分本身出错（助手改名或归档了场景、写了不合法的正则……）时这道题记 0 分，不丢掉这次会话。"""
    try:
        return task.grade(stack)
    except Exception as error:  # 判分里任何意外都只影响这一次会话的得分
        detail = "".join(traceback.format_exception_only(type(error), error)).strip()
        return [Check("判分没有出错", False, detail[-2000:])]


class EndpointDown(RuntimeError):
    pass


def check_endpoint(stack: Stack, model: Model, container: str | None = None) -> None:
    """开始会话之前，确认开发环境容器连得上模型端点（只看能不能建立连接，不调模型）。"""
    url = str(model.spec["endpoint"])
    probe = d.sh(
        container or stack.dev,
        f"curl -sS -m 10 -o /dev/null -w '%{{http_code}}' {shlex.quote(url)}",
        check=False,
    )
    if probe.returncode != 0:
        raise EndpointDown(
            f"{container or stack.dev} 连不上模型端点 {url}：{probe.stderr.strip()}。"
            "用转发口时确认它在运行（见 README.md「模型」）。"
        )


def run_session(
    stack: Stack,
    task: Task,
    model: Model,
    results: Path,
    *,
    max_turns: int = 40,
    max_seconds: float = 1200,
    session_id: str | None = None,
    arm: str = "a",
) -> dict[str, Any]:
    if arm not in ARMS:
        raise ValueError(f"没有臂 {arm}")
    if arm == "p":
        from aeval.platform import run_platform_session

        return run_platform_session(
            stack,
            task,
            model,
            results,
            max_turns=max_turns,
            max_seconds=max_seconds,
            session_id=session_id,
        )
    runner = stack.dev
    check_endpoint(stack, model, runner)
    session_id = session_id or f"{task.id}-{model.name}-{datetime.now().strftime('%H%M%S')}"
    out = results / session_id
    out.mkdir(parents=True, exist_ok=True)
    stack.reset()
    task.seed(stack)
    prepare_pi(stack, model, runner)
    d.docker(
        "exec", "-i", runner, "sh", "-c", "cat > /tmp/aeval-prompt.md", input_text=task.prompt()
    )
    if model.name == "fake" and f"{task.id}/reference" in task.files:
        # 假的模型端点照剧本执行参考答案，只有这时参考答案才进开发环境容器。
        stage_reference(stack, task)
    seeded_at = datetime.now(timezone.utc).isoformat()
    args = [
        "python3",
        DRIVER,
        "--cwd",
        task.workspace,
        "--prompt-file",
        "/tmp/aeval-prompt.md",
        "--provider",
        PROVIDER,
        "--model",
        model.model_id,
        "--max-turns",
        str(max_turns),
        "--max-seconds",
        str(max_seconds),
        "--out",
        SESSION_DIR,
    ]
    if model.thinking:
        args += ["--thinking", model.thinking]
    started = time.monotonic()
    timed_out = False
    try:
        driver = d.sh(
            runner,
            " ".join(shlex.quote(a) for a in args),
            env={**ASSISTANT_ENV, "PI_TELEMETRY": "0"},
            check=False,
            timeout=max_seconds + 300,
        )
        driver_log = driver.stdout + driver.stderr
    except subprocess.TimeoutExpired:
        # 会话驱动自己有时间上限，到这里说明它卡住了：结束容器里的 pi，照常收集记录。
        timed_out = True
        driver_log = "会话驱动没有在时间上限内退出，已结束容器里的 pi\n"
        d.sh(
            runner,
            "pkill -KILL -f '[s]ession_driver.py'; pkill -KILL -f '[p]i --mode'",
            check=False,
        )
    host_seconds = time.monotonic() - started
    d.copy_out(runner, f"{SESSION_DIR}/.", str(out), check=False)
    (out / "driver-stdout.log").write_text(driver_log)
    driver_summary: dict[str, Any] = {}
    if (out / "driver.json").exists():
        driver_summary = json.loads((out / "driver.json").read_text())
    if timed_out:
        driver_summary["exit_reason"] = "time_limit"
    return finish_record(
        stack,
        task,
        model,
        out,
        session_id=session_id,
        arm=arm,
        seeded_at=seeded_at,
        host_seconds=host_seconds,
        driver_summary=driver_summary,
    )


def finish_record(
    stack: Stack,
    task: Task,
    model: Model,
    out: Path,
    *,
    session_id: str,
    arm: str,
    seeded_at: str,
    host_seconds: float,
    driver_summary: dict[str, Any],
    extra: dict[str, Any] | None = None,
    platform_error: str | None = None,
) -> dict[str, Any]:
    """一次会话结束之后（各臂一样）：存工作区的改动和控制面上的运行，判分、分类失败，
    写 `session.json`。`out` 里已经有这次的 `events.jsonl`（pi 的原始事件）。

    `platform_error`（只有平台臂有）：平台这一侧出的问题（建会话被拒、事件流断了、没等到结局、
    平台以 `failed`、`interrupted` 结束这一轮），不是助手没把题做出来。和模型端点的故障一样
    作废、要重跑，不算进失败，原因记下来。"""
    diff = d.sh(
        stack.dev,
        "git add -A -N . && git diff --stat HEAD && git diff HEAD",
        workdir=task.workspace,
        check=False,
    )
    (out / "workspace.diff").write_text(diff.stdout)
    runs = _runs(stack)
    (out / "runs.json").write_text(json.dumps(runs, ensure_ascii=False, indent=2))
    tools = tool_versions(stack, task.workspace)
    graded = summarize(grade_safely(task, stack))
    events = out / "events.jsonl"
    classified = classify(events, driver_summary, runs)
    # 因为端点故障没能做完的会话作废（不论判分结果）：重跑，不计入结果。重试成功的照常算。
    invalid, failure = judge(classified, graded, platform_error)
    record = {
        "session": session_id,
        "task": task.id,
        "category": task.category,
        "arm": arm,
        "model": model.name,
        "model_id": model.model_id,
        "tier": model.tier,
        "thinking": model.thinking,
        "seeded_at": seeded_at,
        "host_seconds": round(host_seconds, 1),
        "driver": driver_summary,
        "grade": graded,
        "failure": failure,
        "invalid": invalid,
        "endpoint_error": classified["endpoint_error"],
        "platform_error": platform_error,
        "endpoint_retries": classified["endpoint_retries"],
        "assistant_runs": len([r for r in runs if is_assistant_run(r)]),
        "tool_versions": tools,
        **(extra or {}),
    }
    (out / "session.json").write_text(json.dumps(record, ensure_ascii=False, indent=2))
    return record


def judge(
    classified: dict[str, Any], graded: dict[str, Any], platform_error: str | None
) -> tuple[bool, dict[str, Any] | None]:
    """这次会话作不作废、失败记成什么。作废：模型端点的故障（`classify`）或平台这一侧的问题
    （`platform_error`），不论判分；作废的失败分类是「环境故障」。没作废又没通过的照 `classify`。"""
    if platform_error is not None:
        classified = {**classified, "primary": INFRA, "invalid": True}
    invalid = bool(classified["invalid"])
    return invalid, classified if invalid or not graded["passed"] else None


def tool_versions(stack: Stack, workspace: str) -> dict[str, str]:
    """节点包里实际用到的 uv、Python、ruff 的版本：PyPI 包第一次录进镜像站缓存时取当时的最新版，
    换了缓存就可能变（ruff 的默认规则就变过），所以每次会话都记下来。"""
    found: dict[str, str] = {}
    for name, command in (
        ("uv", "uv --version"),
        ("python", "uv run --quiet python --version"),
        ("ruff", "uv run --quiet ruff --version"),
    ):
        result = d.sh(stack.dev, command, workdir=workspace, check=False)
        found[name] = result.stdout.strip() if result.returncode == 0 else "?"
    return found


def versions(stack: Stack) -> dict[str, str]:
    """开发环境容器里 sfly 命令行和 pi 的版本。"""
    sfly = d.sh(stack.dev, "sfly --version", check=False).stdout.strip()
    pi = d.sh(stack.dev, "pi --version", check=False).stdout.strip()
    return {"sfly": sfly, "pi": pi}


def _runs(stack: Stack) -> list[dict[str, Any]]:
    out = stack.sfly("api", "GET", "/runs", "--query", "limit=200", "--json", check=False)
    try:
        data = json.loads(out.stdout)
    except ValueError:
        return []
    items = data.get("runs", []) if isinstance(data, dict) else []
    runs: list[dict[str, Any]] = []
    for run in items:
        runs.append(
            {
                "id": run.get("id"),
                "scenario": run.get("orchestration_name"),
                "version": run.get("orchestration_version"),
                "status": run.get("status"),
                "triggered_by": run.get("triggered_by"),
                "triggered_via": run.get("triggered_via"),
                "started_at": run.get("started_at"),
                "ended_at": run.get("ended_at"),
                "failures": run.get("failures"),
            }
        )
    return sorted(runs, key=lambda r: str(r["started_at"]))
