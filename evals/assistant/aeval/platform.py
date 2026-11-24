"""平台臂（`--arm p`，#552）：经控制面的会话接口把题目交给平台内的助手，量的是产品里的那条路。

和臂 A 的一次会话一样，记录落在 `<结果目录>/<会话 ID>/`，判分、失败分类（`classify`）、
汇总（`report`）不分臂：
- `events.jsonl`、`pi-session/`、`pi-stderr.log`、`context.md`：
  会话结束后从助手容器里这个会话的目录（`/data/sessions/<ID>/`，布局照评测的结果目录）复制出来，
  只复制这几样（`SESSION_FILES`）；那里的 `turn.json` 是这一轮的配置，带着环境变量，不复制；
- `platform-events.jsonl`：控制面事件流里收到的每个事件（心跳不记）；`platform.json`：开始前的检查、
  会话 ID、结局、断开和重连、没等到时的原因；
- `driver.json`：和臂 A 的会话驱动写的同样的字段。轮数是平台数的模型调用次数，token 是平台的合计；
  用时是评测这一侧量的（从发出题目到看到结局，和臂 A 的口径一样），平台结局里的用时另记
  `platform_duration_seconds`；工具调用次数和停止的原因从 pi 的原始事件里数；
  内存峰值由评测自己在助手容器里取样（`PeakSampler`），不为它改产品。

**三类结局**（`classify_platform`、`session.judge`）：
- 环境故障：开始前的检查没过（控制面连不上、助手服务没连上控制面、工作台不在线）、
  会话驱动没给出结果或被结束了、模型端点的故障（`classify` 从 pi 的事件里认）。作废，`--fill` 重跑。
- 平台故障：检查过了之后平台这一侧出的问题（建会话被拒或回应不对、
  平台在自己的上限上没给结局要评测来停、停止之后没有结局、`stop`/`end` 回错、结局是 `failed`、
  `interrupted`）。**有效的失败**：算进平台臂的通过率和判定，主类是「平台故障」，`report` 逐次列出。
- 其余照常判分：平台自己给出的到上限是「超时」。

上限是平台自己的（每一轮 40 次模型调用、20 分钟），和评测的默认值一样；不为评测给平台加参数，
`--max-turns`、`--max-seconds` 和它不一样时只提醒。会话由镜像站容器里的 `platform_driver.py`
驱动（断网的槽位宿主机连不上控制面）；跑完发 `end`，助手服务关掉这个会话的 pi 进程。
"""

from __future__ import annotations

import json
import secrets
import shlex
import subprocess
import threading
import time
from collections.abc import Callable, Iterable
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
# 会话驱动停下之后等结局的时间（platform_driver.STOP_WAIT_SECONDS），宿主机在它之外再留的余量。
DRIVER_STOP_WAIT_SECONDS = 40.0
HOST_SLACK_SECONDS = 120.0
# 发话的人：和臂 A 的命令一样记成 eval（控制面给助手的命令带上 SFLY_NICKNAME=eval、AI_AGENT=pi），
# 判分时分得开评测自己（grader）的操作。
NICKNAME = "eval"
DRIVER = "/aeval/container/platform_driver.py"
DRIVER_OUT = "/tmp/aeval-platform"
ASSISTANT_DATA = "/data/sessions"
# 从助手容器里复制的：pi 的原始事件、pi 自己的会话文件、标准错误、平台说明。
# `turn.json` 不复制（带环境变量）。
SESSION_FILES = ("events.jsonl", "pi-session", "pi-stderr.log", "context.md")
# pi 启动时把进程名（`process.title`）改成这个；助手服务自己的进程名是 `node-MainThread`。
PI_PROCESS_NAME = "pi"
# 助手镜像里 pi 的版本（和工作台镜像里的 pi 是分别固定的）。
ASSISTANT_PI_PACKAGE = "/app/node_modules/@earendil-works/pi-coding-agent/package.json"

ENVIRONMENT = "environment"
PLATFORM = "platform"
# 平台以这两种结局结束一轮，是平台这一侧的问题（连不上工作台、开始这一轮失败、旧的 pi 进程没有退出；
# pi 进程在这一轮里退出了、助手服务重启了），不是助手没把题做出来。
PLATFORM_OUTCOMES = ("failed", "interrupted")


def classify_platform(platform: dict[str, Any]) -> tuple[str, str] | None:
    """这次会话里平台和评测环境有没有出问题：（`ENVIRONMENT` 或 `PLATFORM`，原因），都没有是 None。

    模型端点的故障不在这里认：`classify` 从 pi 的事件里认，认出来的也是环境故障，优先于这里的结果
    （平台以 `failed` 结束、原因是模型端点的，算端点的）。"""
    if not platform:
        return ENVIRONMENT, "会话驱动没有给出结果"
    listed = [str(p) for p in platform.get("problems") or []]
    problems = "；".join(listed)
    check = platform.get("precheck")
    if check != "ok":
        return ENVIRONMENT, f"开始前的检查没过：{check or problems or '没有做'}"
    if any("会话驱动被结束了" in p for p in listed):
        return ENVIRONMENT, f"会话驱动被结束了：{problems}"
    if not platform.get("session"):
        return PLATFORM, f"没有建成会话：{problems}"
    if platform.get("deadline_passed"):
        return PLATFORM, f"平台在自己的上限上没有给出结局，评测停下了它：{problems}"
    turn_end = platform.get("turn_end")
    if not isinstance(turn_end, dict):
        return PLATFORM, f"没有等到这一轮的结局：{problems}"
    if turn_end.get("outcome") in PLATFORM_OUTCOMES:
        return PLATFORM, f"平台以 {turn_end.get('outcome')} 结束了这一轮：{turn_end.get('reason')}"
    if problems:
        return PLATFORM, problems
    return None


EXIT_REASONS = {
    "completed": "finished",
    "stopped": "stopped",
    "model_unavailable": "model_unavailable",
    "failed": "failed",
    "interrupted": "interrupted",
}


def exit_reason(turn_end: dict[str, Any] | None, deadline_passed: bool) -> str:
    """平台的结局换成会话驱动的退出原因（`classify` 认 `turn_limit`、`time_limit` 是「超时」）。
    只有平台自己给出的到上限算超时；评测这一侧停下的是 `evaluator_stopped`（平台故障，不是超时）。
    """
    if deadline_passed:
        return "evaluator_stopped"
    if turn_end is None:
        return "no_turn_end"
    outcome = str(turn_end.get("outcome"))
    if outcome == "limit":
        return "turn_limit" if turn_end.get("limit_kind") == "model_calls" else "time_limit"
    return EXIT_REASONS.get(outcome, outcome)


def driver_summary(
    turn_end: dict[str, Any] | None,
    raw_events: list[dict[str, Any]],
    memory: dict[str, Any],
    *,
    deadline_passed: bool,
    seconds: float,
) -> dict[str, Any]:
    """`driver.json` 的内容（和臂 A 的会话驱动写的同样的字段）。`seconds` 是评测这一侧量的用时。
    轮数是平台数的模型调用次数，token 是平台的合计；结局里没有它们时（没等到、控制面补的结局）
    从 pi 的原始事件里数。"""
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
    platform_seconds: float | None = None
    if turn_end is not None:
        if isinstance(turn_end.get("model_calls"), int):
            turns = int(turn_end["model_calls"])
        usage = turn_end.get("usage")
        if isinstance(usage, dict):
            tokens = {key: int(usage.get(key) or 0) for key in tokens}
        if isinstance(turn_end.get("duration_ms"), int):
            platform_seconds = round(int(turn_end["duration_ms"]) / 1000, 1)
    return {
        "exit_reason": exit_reason(turn_end, deadline_passed),
        "outcome": turn_end.get("outcome") if turn_end else None,
        "wall_seconds": round(seconds, 1),
        "platform_duration_seconds": platform_seconds,
        "pi_peak_rss_mib": memory.get("peak_mib"),
        "pi_processes": memory.get("processes"),
        "limits": {"max_turns": PLATFORM_MAX_TURNS, "max_seconds": PLATFORM_MAX_SECONDS},
        "turns": turns,
        "tokens": tokens,
        "tool_calls": tool_calls,
        "tool_errors": tool_errors,
        "stop_reasons": stop_reasons,
        "last_stop_reason": last_stop,
    }


class PeakSampler:
    """在助手容器里每秒读一次 pi 进程的 `VmHWM`（常驻内存峰值，kB），记下最大值和认出了几个进程。

    每次会话之前 `reset` 重建了助手容器，里面只有这一次会话的 pi。按进程名认 pi：pi 启动时把
    `process.title` 改成 `pi`，`/proc/<pid>/comm` 是 `pi`，命令行也被改写了，按 `--session-id`
    认不出来。
    建会话之前就开始取样：假的模型端点一轮只要两三秒，拿到会话 ID 再开始就量不到了。
    要认的名字、停止标记文件都经环境变量给取样脚本；标记文件每次取样一个新名字，脚本不删它，
    停得早（驱动很快失败）也不会和脚本的开头抢。
    """

    SCRIPT = (
        'while [ ! -e "$AEVAL_STOP" ]; do '
        'for p in "$AEVAL_PROC"/[0-9]*; do '
        'if [ "$(cat "$p/comm" 2>/dev/null)" = "$AEVAL_MATCH" ]; then '
        'echo "${p##*/} $(grep "^VmHWM:" "$p/status" 2>/dev/null)"; fi; done; sleep 1; done'
    )

    def __init__(
        self,
        container: str,
        start: Callable[[list[str]], subprocess.Popen[str]] | None = None,
        proc_root: str = "/proc",
    ) -> None:
        self.container = container
        self.stop_file = f"/tmp/aeval-hwm-{secrets.token_hex(8)}.stop"
        self.peak_kib: int | None = None
        self.pids: set[str] = set()
        env = {
            "AEVAL_MATCH": PI_PROCESS_NAME,
            "AEVAL_STOP": self.stop_file,
            "AEVAL_PROC": proc_root,
        }
        argv = ["docker", "exec"]
        for key, value in env.items():
            argv += ["-e", f"{key}={value}"]
        argv += [container, "sh", "-c", self.SCRIPT]
        self._proc = (start or _popen)(argv)
        self._thread = threading.Thread(target=self._read, daemon=True)
        self._thread.start()

    def _read(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            self.add(line)

    def add(self, line: str) -> None:
        """取样脚本的一行：`<pid> VmHWM: <kB> kB`。"""
        pid, _, rest = line.strip().partition(" ")
        kib = parse_hwm(rest)
        if pid and kib:
            self.pids.add(pid)
            self.peak_kib = max(self.peak_kib or 0, kib)

    def touch_stop(self) -> None:
        d.docker("exec", self.container, "touch", self.stop_file, check=False)

    def stop(self) -> dict[str, Any]:
        """停止取样。返回 `peak_mib`（一个进程都没认出来时是 None，不是 0）
        和 `processes`（认出了几个）。"""
        self.touch_stop()
        try:
            self._proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._proc.kill()
        self._thread.join(timeout=5)
        peak = None if self.peak_kib is None else round(self.peak_kib / 1024, 1)
        return {"peak_mib": peak, "processes": len(self.pids)}


def _popen(argv: list[str]) -> subprocess.Popen[str]:
    return subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)


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


def assistant_pi_version(stack: Stack) -> str:
    out = d.docker("exec", stack.assistant_container, "cat", ASSISTANT_PI_PACKAGE, check=False)
    try:
        return str(json.loads(out.stdout).get("version") or "?")
    except ValueError:
        return "?"


def copy_session_files(copy: Callable[[str, str], object], platform_id: str, out: Path) -> None:
    """从助手容器里这个会话的目录只复制 `SESSION_FILES` 里的几样
    （`copy(容器里的路径, 本机路径)`）。"""
    for name in SESSION_FILES:
        copy(f"{ASSISTANT_DATA}/{platform_id}/{name}", str(out / name))


def read_driver(
    lines: Iterable[str], timeout: float, on_timeout: Callable[[], None]
) -> tuple[dict[str, Any], list[str]]:
    """读会话驱动的输出，总共最多等 `timeout` 秒：到了调用 `on_timeout`（结束容器里的驱动，
    它照常收尾），再等一会儿把剩下的读完。返回（`done` 那一行，全部输出）。"""
    found: dict[str, Any] = {}
    log: list[str] = []

    def read() -> None:
        for line in lines:
            log.append(line)
            try:
                said = json.loads(line)
            except ValueError:
                continue
            if isinstance(said, dict) and said.get("event") == "done":
                found.update(said)

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    reader.join(timeout)
    if reader.is_alive():
        on_timeout()
        reader.join(DRIVER_STOP_WAIT_SECONDS + 30)
    return found, log


def platform_record(platform: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any]:
    """`session.json` 里的 `platform` 一栏。驱动给出了结果时照它写（成功的会话 `problems` 是空的）；
    没给出时写「会话驱动没有给出结果」。"""
    turn_end = platform.get("turn_end")
    return {
        "session": platform.get("session"),
        "precheck": platform.get("precheck"),
        "queued": platform.get("queued"),
        "outcome": summary["outcome"],
        "reason": turn_end.get("reason") if isinstance(turn_end, dict) else None,
        "deadline_passed": bool(platform.get("deadline_passed")),
        "stream_breaks": platform.get("stream_breaks") or [],
        "problems": list(platform.get("problems") or []) if platform else ["会话驱动没有给出结果"],
    }


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
        # 假的模型端点照剧本执行参考答案，只有这时参考答案才进开发环境容器。会话的工作目录是工作区
        # /work，参考答案要在题目的节点包目录里执行（fake_model 读 workdir 这个文件）。
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

    def end_driver() -> None:
        # docker exec 断开不会结束容器里的驱动：直接给它发 SIGTERM，它照常收尾（写记录、发 end）。
        pattern = shlex.quote(f"[p]latform_driver.py .*{run_dir}")
        d.sh(mirror, f"pkill -TERM -f {pattern}", check=False)

    sampler = PeakSampler(stack.assistant_container)
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert proc.stdout is not None
    try:
        platform, log = read_driver(
            proc.stdout, budget + DRIVER_STOP_WAIT_SECONDS + HOST_SLACK_SECONDS, end_driver
        )
    except BaseException:
        # 宿主机这边被打断（Ctrl-C）：容器里的驱动也结束掉，不让它和 pi 在工作台上接着做。
        end_driver()
        raise
    finally:
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        memory = sampler.stop()
    host_seconds = time.monotonic() - started
    (out / "driver-stdout.log").write_text("".join(log))
    d.copy_out(mirror, f"{run_dir}/.", str(out), check=False)
    platform_id = platform.get("session")
    if platform_id:
        copy_session_files(
            lambda src, dest: d.copy_out(stack.assistant_container, src, dest, check=False),
            str(platform_id),
            out,
        )
    turn_end = platform.get("turn_end")
    summary = driver_summary(
        turn_end if isinstance(turn_end, dict) else None,
        read_events(out / "events.jsonl") if (out / "events.jsonl").exists() else [],
        memory,
        deadline_passed=bool(platform.get("deadline_passed")),
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
        platform_fault=classify_platform(platform),
        extra={
            "platform": platform_record(platform, summary),
            "assistant_pi": assistant_pi_version(stack),
        },
    )
