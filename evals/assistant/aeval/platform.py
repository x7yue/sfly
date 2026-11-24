"""平台臂（`--arm p`，#552）：经控制面的会话接口把题目交给平台内的助手，量的是产品里的那条路。

和臂 A 的一次会话一样，记录落在 `<结果目录>/<会话 ID>/`，判分、失败分类（`classify`）、
汇总（`report`）
不分臂：
- `events.jsonl`、`pi-session/`、`pi-stderr.log`、`context.md`：会话结束后从助手容器里这个会话的目录
  （`/data/sessions/<ID>/`，布局照评测的结果目录）复制出来；那里的 `turn.json` 是这一轮的配置，
  带着环境变量，
  不复制；
- `platform-events.jsonl`：控制面事件流里收到的每个事件；`platform.json`：会话 ID、结局、
没等到时的原因；
- `driver.json`：照这一轮的 `turn_end` 写（模型调用次数、用时、token），
工具调用次数和停止的原因从 pi 的
  原始事件里数，内存峰值由评测自己在助手容器里给这个会话的 pi 进程取样（`VmHWM`，每秒一次），
  不为它改产品。

上限是平台自己的（每一轮 40 次模型调用、20 分钟），和评测的默认值一样；不为评测给平台加参数，
`--max-turns`、`--max-seconds` 和它不一样时只提醒。会话由镜像站容器里的 `platform_driver.py` 驱动
（断网的槽位宿主机连不上控制面）；跑完发 `end`，助手服务关掉这个会话的 pi 进程。
"""

from __future__ import annotations

import json
import shlex
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from aeval import docker as d
from aeval.classify import read_events
from aeval.env import Stack
from aeval.models import Model, load_models
from aeval.tasks import REFERENCE_DIR, Task, stage_reference

# 平台的上限（apps/assistant 的每一轮上限）：评测的默认值和它一样。
PLATFORM_MAX_TURNS = 40
PLATFORM_MAX_SECONDS = 1200.0
# 平台自己到了上限还要停一轮（最长 23 秒）、发结局：评测这一侧多等这么久再去停它。
DEADLINE_SLACK_SECONDS = 60.0
# 发话的人：和臂 A 的命令一样记成 eval（控制面给助手的命令带上 SFLY_NICKNAME=eval、AI_AGENT=pi），
# 判分时分得开评测自己（grader）的操作。
NICKNAME = "eval"
DRIVER = "/aeval/container/platform_driver.py"
DRIVER_OUT = "/tmp/aeval-platform"
ASSISTANT_DATA = "/data/sessions"
# 从助手容器里复制的：pi 的原始事件、pi 自己的会话文件、标准错误、平台说明。
# `turn.json` 不复制（带环境变量）。
SESSION_FILES = ("events.jsonl", "pi-session", "pi-stderr.log", "context.md")

EXIT_REASONS = {
    "completed": "finished",
    "stopped": "time_limit",
    "model_unavailable": "model_unavailable",
    "failed": "failed",
    "interrupted": "interrupted",
}


def exit_reason(turn_end: dict[str, Any] | None, deadline_passed: bool) -> str:
    """平台的结局换成会话驱动的退出原因（`classify` 认 `turn_limit`、`time_limit`）。
    评测这一侧过了时限、
    停下的那一轮（`stopped`）也算 `time_limit`。"""
    if turn_end is None:
        return "time_limit" if deadline_passed else "no_turn_end"
    outcome = str(turn_end.get("outcome"))
    if outcome == "limit":
        return "turn_limit" if turn_end.get("limit_kind") == "model_calls" else "time_limit"
    return EXIT_REASONS.get(outcome, outcome)


# 平台以这两种结局结束一轮，是平台这一侧的问题（连不上工作台、开始这一轮失败、旧的 pi 进程没有退出；
# pi 进程在这一轮里退出了、助手服务重启了），不是助手没把题做出来。
PLATFORM_OUTCOMES = ("failed", "interrupted")


def platform_error(platform: dict[str, Any]) -> str | None:
    """这次会话是不是因为平台这一侧的问题没能做完，是的话返回原因：建会话被拒、事件流断了或者
    停止之后没有结局（都没有 `turn_end`），平台以 `failed`、`interrupted` 结束。评测这一侧过了
    时限、停下的那一轮（`stopped`）和到了上限（`limit`）是助手的事，不算；模型端点的故障由
    `classify` 从 pi 的事件里认。"""
    problems = "；".join(str(p) for p in platform.get("problems") or []) or "会话驱动没有给出结果"
    if not platform.get("session"):
        return f"没有建成会话：{problems}"
    turn_end = platform.get("turn_end")
    if not isinstance(turn_end, dict):
        return f"没有等到这一轮的结局：{problems}"
    outcome = turn_end.get("outcome")
    if outcome in PLATFORM_OUTCOMES:
        return f"平台以 {outcome} 结束了这一轮：{turn_end.get('reason')}"
    return None


def driver_summary(
    turn_end: dict[str, Any] | None,
    raw_events: list[dict[str, Any]],
    peak_kib: int,
    *,
    deadline_passed: bool,
    seconds: float,
) -> dict[str, Any]:
    """`driver.json` 的内容（和臂 A 的会话驱动写的同样的字段）。轮数是平台数的模型调用次数，
    token 是平台的
    合计；没有 `turn_end` 时（没等到）从 pi 的原始事件里数。"""
    tool_calls = tool_errors = turns = 0
    tokens = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    stop_reasons: dict[str, int] = {}
    last_stop: str | None = None
    for event in raw_events:
        kind = event.get("type")
        if kind == "turn_start":
            turns += 1
        elif kind == "tool_execution_end":
            tool_calls += 1
            tool_errors += bool(event.get("isError"))
        elif kind == "message_end":
            message = event.get("message") or {}
            if message.get("role") != "assistant":
                continue
            usage = message.get("usage") or {}
            for key, field in (
                ("input", "input"),
                ("output", "output"),
                ("cache_read", "cacheRead"),
                ("cache_write", "cacheWrite"),
            ):
                tokens[key] += int(usage.get(field) or 0)
            last_stop = str(message.get("stopReason") or "unknown")
            stop_reasons[last_stop] = stop_reasons.get(last_stop, 0) + 1
    if turn_end is not None:
        if isinstance(turn_end.get("model_calls"), int):
            turns = int(turn_end["model_calls"])
        usage = turn_end.get("usage")
        if isinstance(usage, dict):
            tokens = {key: int(usage.get(key) or 0) for key in tokens}
        if isinstance(turn_end.get("duration_ms"), int):
            seconds = int(turn_end["duration_ms"]) / 1000
    return {
        "exit_reason": exit_reason(turn_end, deadline_passed),
        "outcome": turn_end.get("outcome") if turn_end else None,
        "wall_seconds": round(seconds, 1),
        "pi_peak_rss_mib": round(peak_kib / 1024, 1),
        "limits": {"max_turns": PLATFORM_MAX_TURNS, "max_seconds": PLATFORM_MAX_SECONDS},
        "turns": turns,
        "tokens": tokens,
        "tool_calls": tool_calls,
        "tool_errors": tool_errors,
        "stop_reasons": stop_reasons,
        "last_stop_reason": last_stop,
    }


class PeakSampler:
    """在助手容器里每秒读一次 pi 进程的 `VmHWM`（常驻内存峰值，kB），记下最大值。

    每次会话之前 `reset` 重建了助手容器，里面只有这一次会话的 pi。按进程名认 pi：pi 启动时把
    `process.title` 改成 `pi`，`/proc/<pid>/comm` 是 `pi`，命令行也被改写了，
    按 `--session-id` 认不出来；
    助手服务自己的进程名是 `node-MainThread`。建会话之前就开始取样：假的模型端点一轮只要一两秒，
    拿到会话 ID 再开始就量不到了。
    停的时候在容器里放一个标记文件，取样的循环看到就退出（结束宿主机上的 docker exec
    停不掉容器里的循环）。
    """

    STOP_FILE = "/tmp/aeval-hwm.stop"
    SCRIPT = (
        f'stop="{STOP_FILE}"; rm -f "$stop"; '
        'while [ ! -e "$stop" ]; do '
        "for p in /proc/[0-9]*; do "
        'if [ "$(cat "$p/comm" 2>/dev/null)" = "$AEVAL_MATCH" ]; then '
        'grep "^VmHWM:" "$p/status" 2>/dev/null; fi; done; sleep 1; done'
    )

    def __init__(self, container: str) -> None:
        self.container = container
        self.peak_kib = 0
        self._proc = subprocess.Popen(
            [
                "docker",
                "exec",
                "-e",
                "AEVAL_MATCH=pi",
                container,
                "sh",
                "-c",
                self.SCRIPT,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        self._thread = threading.Thread(target=self._read, daemon=True)
        self._thread.start()

    def _read(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            self.peak_kib = max(self.peak_kib, parse_hwm(line))

    def stop(self) -> int:
        d.docker(
            "exec",
            self.container,
            "touch",
            self.STOP_FILE,
            check=False,
        )
        try:
            self._proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._proc.kill()
        self._thread.join(timeout=5)
        return self.peak_kib


def parse_hwm(line: str) -> int:
    """`VmHWM:   123456 kB` 里的数（kB）；不是这样的一行时 0。"""
    parts = line.split()
    if len(parts) >= 2 and parts[0] == "VmHWM:" and parts[1].isdigit():
        return int(parts[1])
    return 0


def use_model(stack: Stack, model: Model) -> None:
    """平台臂用的模型是助手容器上配的：和这次要跑的不一样时换过来
    （之后的 reset 照它重建助手容器）。"""
    if not stack.assistant:
        raise d.DockerError("平台臂要 ./aeval.sh up --assistant（见 README.md「平台的助手」）")
    if model.name == stack.assistant_model:
        return
    if model.name not in load_models():
        raise d.DockerError(f"模型配置里没有 {model.name}")
    if model.name == "fake" and not d.container_running(stack.name("fake")):
        raise d.DockerError("这个槽位没有起假的模型端点：up 时加 --fake-model")
    stack.assistant_model = model.name
    stack.check_assistant_model()


def check_endpoint(stack: Stack, model: Model) -> None:
    """开始之前确认助手容器连得上模型端点（只看能不能建立连接，不调模型）。助手镜像里没有 curl，
    用 node。"""
    from aeval.session import EndpointDown

    url = str(model.spec["endpoint"])
    probe = d.docker(
        "exec",
        stack.assistant_container,
        "node",
        "-e",
        "fetch(process.argv[1]).then(() => process.exit(0), (e) => "
        "{ console.error(String(e.cause ?? e)); process.exit(1); })",
        url,
        check=False,
        timeout=30,
    )
    if probe.returncode != 0:
        raise EndpointDown(
            f"助手容器连不上模型端点 {url}：{probe.stderr.strip()[-300:]}。"
            "用转发口时确认它在运行（见 README.md「模型」）。"
        )


def run_platform_session(
    stack: Stack,
    task: Task,
    model: Model,
    results: Path,
    *,
    max_turns: int = PLATFORM_MAX_TURNS,
    max_seconds: float = PLATFORM_MAX_SECONDS,
    session_id: str | None = None,
) -> dict[str, Any]:
    from aeval.session import finish_record

    use_model(stack, model)
    if (max_turns, max_seconds) != (PLATFORM_MAX_TURNS, PLATFORM_MAX_SECONDS):
        print(
            f"提醒：平台臂的上限是平台自己的（{PLATFORM_MAX_TURNS} 次模型调用、"
            f"{PLATFORM_MAX_SECONDS:.0f} 秒），--max-turns、--max-seconds 对它不起作用",
            flush=True,
        )
    session_id = session_id or f"{task.id}-{model.name}-p-{datetime.now().strftime('%H%M%S')}"
    out = results / session_id
    out.mkdir(parents=True, exist_ok=True)
    stack.reset()
    check_endpoint(stack, model)
    task.seed(stack)
    if model.name == "fake" and f"{task.id}/reference" in task.files:
        # 假的模型端点照剧本执行参考答案，只有这时参考答案才进开发环境容器；
        # 会话的工作目录是工作区 /work，
        # 参考答案要在题目的节点包目录里执行（fake_model 读 workdir 这个文件）。
        stage_reference(stack, task)
        d.sh(stack.dev, f"printf '%s' {shlex.quote(task.workspace)} > {REFERENCE_DIR}/workdir")
    mirror = stack.name("mirror")
    run_dir = f"{DRIVER_OUT}/{session_id}"
    prompt = f"{run_dir}.prompt.md"
    d.sh(
        mirror,
        f"rm -rf {run_dir} && mkdir -p {DRIVER_OUT} && cat > {prompt}",
        input_text=task.prompt(),
    )
    seeded_at = datetime.now(timezone.utc).isoformat()
    started = time.monotonic()
    budget = PLATFORM_MAX_SECONDS + DEADLINE_SLACK_SECONDS
    argv = [
        "docker",
        "exec",
        mirror,
        "python3",
        DRIVER,
        "--nickname",
        NICKNAME,
        "--prompt-file",
        prompt,
        "--max-seconds",
        str(budget),
        "--out",
        run_dir,
    ]
    platform: dict[str, Any] = {}
    log: list[str] = []
    sampler = PeakSampler(stack.assistant_container)
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            log.append(line)
            try:
                said = json.loads(line)
            except ValueError:
                continue
            if said.get("event") == "done":
                platform = said
        proc.wait(timeout=budget + 120)
    finally:
        if proc.poll() is None:
            proc.kill()
        peak = sampler.stop()
    host_seconds = time.monotonic() - started
    (out / "driver-stdout.log").write_text("".join(log))
    d.copy_out(mirror, f"{run_dir}/.", str(out), check=False)
    platform_id = platform.get("session")
    if platform_id:
        source = f"{ASSISTANT_DATA}/{platform_id}"
        for name in SESSION_FILES:
            d.copy_out(stack.assistant_container, f"{source}/{name}", str(out / name), check=False)
    turn_end = platform.get("turn_end")
    deadline_passed = bool(platform.get("stopped"))
    summary = driver_summary(
        turn_end if isinstance(turn_end, dict) else None,
        read_events(out / "events.jsonl") if (out / "events.jsonl").exists() else [],
        peak,
        deadline_passed=deadline_passed,
        seconds=float(platform.get("seconds") or host_seconds),
    )
    (out / "driver.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    return finish_record(
        stack,
        task,
        model,
        out,
        session_id=session_id,
        arm="p",
        seeded_at=seeded_at,
        host_seconds=host_seconds,
        driver_summary=summary,
        platform_error=platform_error(platform),
        extra={
            "platform": {
                "session": platform_id,
                "outcome": summary["outcome"],
                "reason": (turn_end or {}).get("reason") if isinstance(turn_end, dict) else None,
                "problems": platform.get("problems") or ["会话驱动没有给出结果"],
            }
        },
    )
