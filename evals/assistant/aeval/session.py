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
from aeval.classify import INFRA, PLATFORM_FAULT, UNCLASSIFIED, classify, is_assistant_run
from aeval.env import OPT, Stack
from aeval.models import PROVIDER, Model
from aeval.platform import ENVIRONMENT, PLATFORM
from aeval.tasks import GUARD, Check, Task, stage_reference, summarize

DRIVER = f"{OPT}/session_driver.py"
SESSION_DIR = "/root/aeval-session"


# 臂：a 工具在本地执行（原版 pi 在开发环境里）；b 工具经能力端口落到开发环境（#443 的原型）；
# p 平台：经控制面的会话接口交给平台内的助手（aeval.platform，#552）。
ARMS = ("a", "b", "p")
REMOTE_EXTENSION = "/opt/aeval-remote/extension.mjs"
# 助手的命令带上的环境变量：控制面把它的操作记成「eval 经 pi」，和判分（grader）的操作分开。
ASSISTANT_ENV = {"SFLY_NICKNAME": "eval", "AI_AGENT": "pi"}


def pi_container(stack: Stack, arm: str) -> str:
    """pi 进程在哪个容器里：臂 A 在开发环境里（工具在本地执行），臂 B 在单独的 pi 容器里。"""
    return stack.dev if arm == "a" else stack.pi


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
    if arm == "b":
        stack.ensure_pi_container()
    runner = pi_container(stack, arm)
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
    extra_env: dict[str, str] = {}
    if arm == "b":
        # pi 本地只有一个同名的空目录：工作目录的路径两边一样，文件和命令都经扩展落到开发环境。
        d.sh(runner, f"mkdir -p {shlex.quote(task.workspace)}")
        extra_env = {
            "AEVAL_AGENT_ADDR": "dev:50052",
            "AEVAL_REMOTE_ENV": json.dumps(ASSISTANT_ENV),
            "AEVAL_REMOTE_LOG": f"{SESSION_DIR}/remote-tools.jsonl",
            # 模型没给超时的命令：臂 A 的会一直等到会话被结束，臂 B 的默认超时就设成会话的时间上限，
            # 两臂在同一个时刻结束，臂 B 不会因此把卡住的命令提前救回来。
            "AEVAL_DEFAULT_TIMEOUT": str(int(max_seconds)),
        }
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
    if arm == "b":
        args += ["--extension", REMOTE_EXTENSION, "--no-approve"]
        d.sh(runner, f"mkdir -p {SESSION_DIR}")
    started = time.monotonic()
    timed_out = False
    try:
        driver = d.sh(
            runner,
            " ".join(shlex.quote(a) for a in args),
            env={**ASSISTANT_ENV, "PI_TELEMETRY": "0", **extra_env},
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
    platform_fault: tuple[str, str] | None = None,
) -> dict[str, Any]:
    """一次会话结束之后（各臂一样）：存工作区的改动和控制面上的运行，判分、分类失败，
    写 `session.json`。`out` 里已经有这次的 `events.jsonl`（pi 的原始事件）。

    `platform_fault`（只有平台臂有，`aeval.platform.classify_platform`）：（类，原因）。环境故障作废；
    平台故障是有效的失败，见 `judge`。"""
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
    checks = grade_safely(task, stack)
    events = out / "events.jsonl"
    classified = classify(events, driver_summary, runs)
    invalid, failure, checks = judge(classified, checks, platform_fault)
    graded = summarize(checks)
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
        "platform_fault": None
        if platform_fault is None
        else {"kind": platform_fault[0], "reason": platform_fault[1]},
        "endpoint_retries": classified["endpoint_retries"],
        "assistant_runs": len([r for r in runs if is_assistant_run(r)]),
        "tool_versions": tools,
        **(extra or {}),
    }
    (out / "session.json").write_text(json.dumps(record, ensure_ascii=False, indent=2))
    return record


def judge(
    classified: dict[str, Any], checks: list[Check], platform_fault: tuple[str, str] | None
) -> tuple[bool, dict[str, Any] | None, list[Check]]:
    """这次会话作不作废、失败记成什么。返回（作废没有，失败分类，判分的检查项）。

    - 环境故障作废，不论判分，主类「环境故障」：模型端点的故障（`classify` 认的，优先）、
      平台臂开始前的检查没过、评测自己的问题。重跑，不计入结果。重试成功的端点故障照常算。
    - 平台故障（只有平台臂）是**有效的失败**：判分加一条没过的守护项「平台这一侧没有出问题」
      （写明原因），所以不算通过，主类「平台故障」。
    - 未归类（只有平台臂）：作废，主类「未归类」；`report` 单独列出，判定写明只作参考。
    - 其余没通过的照 `classify`。
    """
    endpoint = bool(classified["invalid"])
    if not endpoint and platform_fault is not None:
        kind, reason = platform_fault
        if kind == PLATFORM:
            classified = {**classified, "primary": PLATFORM_FAULT, "platform": reason}
            checks = [*checks, Check("平台这一侧没有出问题", False, reason, kind=GUARD)]
        else:
            primary = INFRA if kind == ENVIRONMENT else UNCLASSIFIED
            classified = {**classified, "primary": primary, "invalid": True, "environment": reason}
    invalid = bool(classified["invalid"])
    passed = summarize(checks)["passed"]
    return invalid, classified if invalid or not passed else None, checks


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
