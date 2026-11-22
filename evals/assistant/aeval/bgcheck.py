"""探针（#539）第 11 题：已有的会话记录里，模型多常跨两次命令依赖后台进程。不调模型。

`./aeval.sh bgcheck <结果目录>…`：扫描结果目录下每次会话的 `events.jsonl`
（有 `session.json` 的目录），
找出「一次命令里把进程放到后台（`&`、`nohup`、`setsid`、`disown`、`screen -dm`、`tmux … -d`），
之后另一次工具调用连它的端口或读它的输出文件」。同一次命令里起了后台进程又测它的不算（那在远程执行下也行，
见 remote-tools/README.md 第 13 条）。

按题目、臂、档次分组计数（不按模型名分组：结果要贴到公开的 issue 上），每一处列出上下文：
起后台进程的那一步、依赖它的那一步，以及依赖那一步的前后各一步（只有命令和路径，不带模型的话）。
作废的会话（`invalid`）和假的模型端点的会话（照剧本，不是模型的行为）不算；另外数出起过后台进程的命令有几条。

这是启发式的：端口按 `:<端口>`、`--port <端口>`、`-p <端口>`、`http.server <端口>`、
`PORT=<端口>` 认，
输出文件按重定向（`>`、`>>`、`&>`、`tee`）和 `nohup` 默认的 `nohup.out` 认。
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from aeval.classify import read_events

# 放到后台：单独的 &（不是 &&、>&、&>、2>&1 里的），以及常见的脱离终端的写法。
_REDIRECT_AMP = re.compile(r"\d*>&\d*|&>>?|>&")
_LONE_AMP = re.compile(r"(?<![&|])&(?![&])")
_DETACH = re.compile(r"\b(nohup|setsid|disown|daemonize)\b|\bscreen\s+-\w*d|\btmux\b[^;&|]*\s-d\b")
_PORTS = (
    re.compile(r"(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\b[\w.-]+):(\d{2,5})\b"),
    re.compile(r"--port[= ](\d{2,5})\b"),
    re.compile(r"\s-p\s+(\d{2,5})\b"),
    re.compile(r"http\.server\s+(\d{2,5})\b"),
    re.compile(r"\bPORT=(\d{2,5})\b"),
)
_OUTPUT = re.compile(r"(?:&>>?|\d?>>?)\s*([^\s;&|<>]+)|\btee\s+(?:-a\s+)?([^\s;&|<>]+)")
_READERS = re.compile(r"\b(cat|tail|head|less|grep|rg|awk|sed|wc)\b")


@dataclass
class Step:
    """会话里的一次工具调用：序号、工具名、命令（bash）或路径（read）。"""

    index: int
    tool: str
    text: str


@dataclass
class Finding:
    session: str
    task: str
    arm: str
    tier: str
    started: Step
    used: Step
    how: str
    around: list[Step] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        def step(s: Step) -> dict[str, Any]:
            return {"index": s.index, "tool": s.tool, "text": s.text[:300]}

        return {
            "session": self.session,
            "task": self.task,
            "arm": self.arm,
            "tier": self.tier,
            "how": self.how,
            "started": step(self.started),
            "used": step(self.used),
            "around": [step(s) for s in self.around],
        }


def backgrounds(command: str) -> bool:
    """这条命令有没有把进程放到后台。"""
    stripped = _REDIRECT_AMP.sub(" ", command)
    return bool(_LONE_AMP.search(stripped) or _DETACH.search(command))


def ports(command: str) -> set[str]:
    found: set[str] = set()
    for pattern in _PORTS:
        found.update(m for m in pattern.findall(command) if 1024 <= int(m) <= 65535)
    return found


def output_files(command: str) -> set[str]:
    files = {a or b for a, b in _OUTPUT.findall(command)}
    files.discard("/dev/null")
    files = {f for f in files if not f.startswith("&")}
    if re.search(r"\bnohup\b", command) and not files:
        files.add("nohup.out")
    return files


def steps_of(events: list[dict[str, Any]]) -> list[Step]:
    steps: list[Step] = []
    for event in events:
        if event.get("type") != "tool_execution_start":
            continue
        args = event.get("args") or {}
        tool = str(event.get("toolName"))
        text = str(args.get("command") if tool == "bash" else args.get("path", ""))
        steps.append(Step(len(steps), tool, text))
    return steps


def _reads(step: Step, path: str) -> bool:
    name = Path(path).name
    if step.tool == "read":
        return step.text == path or Path(step.text).name == name
    return step.tool == "bash" and name in step.text and bool(_READERS.search(step.text))


def find_in_session(steps: list[Step]) -> list[tuple[Step, Step, str]]:
    """每个依赖了前面某条命令起的后台进程的工具调用（取第一处），以及它依赖的是哪个端口或文件。"""
    found = []
    for i, start in enumerate(steps):
        if start.tool != "bash" or not backgrounds(start.text):
            continue
        start_ports, files = ports(start.text), output_files(start.text)
        for later in steps[i + 1 :]:
            port = next(
                (p for p in start_ports if later.tool == "bash" and p in ports(later.text)), None
            )
            if port:
                found.append((start, later, f"端口 {port}"))
                break
            path = next((f for f in files if _reads(later, f)), None)
            if path:
                found.append((start, later, f"输出文件 {path}"))
                break
    return found


def scan(roots: list[Path], *, include_fake: bool = False) -> dict[str, Any]:
    """扫描结果目录：会话数、各组的会话数、起后台进程的命令数和跨命令依赖的处数，以及每一处的上下文。"""
    sessions: Counter[tuple[str, str, str]] = Counter()
    hits: Counter[tuple[str, str, str]] = Counter()
    started: Counter[tuple[str, str, str]] = Counter()
    commands = 0
    findings: list[Finding] = []
    seen: set[Path] = set()
    for root in roots:
        for record_file in sorted(root.rglob("session.json")):
            folder = record_file.parent.resolve()
            if folder in seen or not (folder / "events.jsonl").exists():
                continue
            seen.add(folder)
            record = json.loads(record_file.read_text())
            if record.get("invalid") or (record.get("model") == "fake" and not include_fake):
                continue
            key = (
                str(record.get("task")),
                str(record.get("arm", "a")),
                str(record.get("tier", "")),
            )
            sessions[key] += 1
            steps = steps_of(read_events(folder / "events.jsonl"))
            commands += sum(1 for s in steps if s.tool == "bash")
            started[key] += sum(1 for s in steps if s.tool == "bash" and backgrounds(s.text))
            for start, used, how in find_in_session(steps):
                hits[key] += 1
                around = [s for s in steps if abs(s.index - used.index) == 1]
                findings.append(
                    Finding(str(record.get("session", folder.name)), *key, start, used, how, around)
                )
    groups = [
        {
            "task": k[0],
            "arm": k[1],
            "tier": k[2],
            "sessions": n,
            "background_commands": started[k],
            "findings": hits[k],
        }
        for k, n in sorted(sessions.items())
    ]
    return {
        "sessions": sum(sessions.values()),
        "commands": commands,
        "background_commands": sum(started.values()),
        "findings": len(findings),
        "groups": groups,
        "details": [f.as_dict() for f in findings],
    }


def render(result: dict[str, Any]) -> str:
    lines = [
        f"会话 {result['sessions']} 次、命令 {result['commands']} 条，其中起后台进程的命令 "
        f"{result['background_commands']} 条，跨两次工具调用依赖后台进程 {result['findings']} 处。",
        "",
        "| 题目 | 臂 | 档次 | 会话 | 起后台进程的命令 | 跨命令依赖 |",
        "|---|---|---|---|---|---|",
    ]
    lines += [
        f"| {g['task']} | {g['arm'].upper()} | {g['tier']} | {g['sessions']} "
        f"| {g['background_commands']} | {g['findings']} |"
        for g in result["groups"]
    ]
    for d in result["details"]:
        lines += [
            "",
            f"- {d['session']}（{d['task']}，臂 {d['arm'].upper()}）：{d['how']}",
            f"  - 第 {d['started']['index']} 步起后台进程：`{d['started']['text']}`",
            f"  - 第 {d['used']['index']} 步依赖它：`{d['used']['text']}`",
        ]
        lines += [f"  - 前后：第 {s['index']} 步 {s['tool']} `{s['text']}`" for s in d["around"]]
    return "\n".join(lines) + "\n"


def run(roots: list[Path], *, include_fake: bool = False) -> dict[str, Any]:
    result = scan(roots, include_fake=include_fake)
    print(render(result))
    return result
