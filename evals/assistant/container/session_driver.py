"""在开发环境容器里跑一次助手会话：原版 pi 的 JSON 模式，外面套上轮数和时间上限，记下用量。

- `pi --mode json --approve --offline …`：`--approve` 让 pi 加载节点包目录里
  `sfly init` 带的两份 skill
  （无交互模式默认不信任项目里的 `.agents/skills`）；`--offline` 关掉模型目录刷新和版本检查，
  联网和断网的环境里行为一样。
- 轮数按 `turn_start` 事件计；超过上限或超时就发 SIGTERM，10 秒后还没退出发 SIGKILL。
- 每秒读一次 pi 进程的 `VmHWM`（常驻内存峰值）。
- 事件流原样存成 `events.jsonl`；结束后写 `driver.json`：退出原因、轮数、用时、token、内存峰值。

只用标准库，在工作台镜像自带的 python3 里运行。
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import IO, Any


def read_hwm_kib(pid: int) -> int | None:
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmHWM:"):
                return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        return None
    return None


class Usage:
    """从事件流里累计用量：每条助手消息结束时（`message_end`）加上它的 usage。"""

    def __init__(self) -> None:
        self.input = 0
        self.output = 0
        self.cache_read = 0
        self.cache_write = 0
        self.turns = 0
        self.tool_calls = 0
        self.tool_errors = 0
        self.stop_reasons: dict[str, int] = {}
        self.last_stop_reason: str | None = None

    def add(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "turn_start":
            self.turns += 1
        elif kind == "tool_execution_end":
            self.tool_calls += 1
            if event.get("isError"):
                self.tool_errors += 1
        elif kind == "message_end":
            message = event.get("message") or {}
            if message.get("role") != "assistant":
                return
            usage = message.get("usage") or {}
            self.input += int(usage.get("input") or 0)
            self.output += int(usage.get("output") or 0)
            self.cache_read += int(usage.get("cacheRead") or 0)
            self.cache_write += int(usage.get("cacheWrite") or 0)
            reason = str(message.get("stopReason") or "unknown")
            self.stop_reasons[reason] = self.stop_reasons.get(reason, 0) + 1
            self.last_stop_reason = reason

    def as_dict(self) -> dict[str, Any]:
        return {
            "turns": self.turns,
            "tokens": {
                "input": self.input,
                "output": self.output,
                "cache_read": self.cache_read,
                "cache_write": self.cache_write,
            },
            "tool_calls": self.tool_calls,
            "tool_errors": self.tool_errors,
            "stop_reasons": self.stop_reasons,
            "last_stop_reason": self.last_stop_reason,
        }


def split_lines(stream: IO[bytes]) -> Iterator[bytes]:
    """按 LF 切分 JSONL（pi 的文档要求：U+2028、U+2029 在 JSON 字符串里是合法的，不能当换行）。"""
    pending = b""
    while True:
        chunk = stream.read1(65536)  # type: ignore[attr-defined]  # Popen 的 stdout 是 BufferedReader
        if not chunk:
            break
        pending += chunk
        *lines, pending = pending.split(b"\n")
        yield from lines
    if pending:
        yield pending


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="跑一次助手会话")
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--thinking")
    parser.add_argument("--max-turns", type=int, default=40)
    parser.add_argument("--max-seconds", type=float, default=1200)
    parser.add_argument("--out", required=True)
    parser.add_argument("--extension", action="append", default=[], help="额外加载的 pi 扩展")
    parser.add_argument("--pi-arg", action="append", default=[], help="原样传给 pi 的参数")
    parser.add_argument(
        "--no-approve",
        action="store_true",
        help="不信任项目里的资源（臂 B：skill 由扩展从开发环境取来，不在本地目录里找）",
    )
    args = parser.parse_args(argv)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    prompt = Path(args.prompt_file).read_text().strip()
    cmd = [
        "pi",
        "--mode",
        "json",
        "--no-approve" if args.no_approve else "--approve",
        "--offline",
        "--provider",
        args.provider,
        "--model",
        args.model,
        "--session-dir",
        str(out / "pi-session"),
    ]
    if args.thinking:
        cmd += ["--thinking", args.thinking]
    for extension in args.extension:
        cmd += ["--extension", extension]
    cmd += args.pi_arg
    cmd.append(prompt)

    started = time.monotonic()
    proc = subprocess.Popen(
        cmd,
        cwd=args.cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=(out / "pi-stderr.log").open("wb"),
        start_new_session=True,
    )
    usage = Usage()
    hwm_kib = 0
    stop = threading.Event()
    reason: list[str] = []

    def terminate(why: str) -> None:
        if reason:
            return
        reason.append(why)
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return

        def kill_later() -> None:
            if proc.poll() is None and not stop.wait(10):
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

        threading.Thread(target=kill_later, daemon=True).start()

    def watch() -> None:
        nonlocal hwm_kib
        while not stop.wait(1):
            value = read_hwm_kib(proc.pid)
            if value is not None:
                hwm_kib = max(hwm_kib, value)
            if time.monotonic() - started > args.max_seconds:
                terminate("time_limit")

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    assert proc.stdout is not None
    with (out / "events.jsonl").open("wb") as events:
        for raw in split_lines(proc.stdout):
            events.write(raw + b"\n")
            events.flush()
            try:
                event = json.loads(raw.rstrip(b"\r"))
            except ValueError:
                continue
            if isinstance(event, dict):
                usage.add(event)
                if usage.turns > args.max_turns:
                    terminate("turn_limit")
    exit_code = proc.wait()
    value = read_hwm_kib(proc.pid)
    if value is not None:
        hwm_kib = max(hwm_kib, value)
    stop.set()
    elapsed = time.monotonic() - started
    summary = {
        "exit_reason": reason[0] if reason else "finished",
        "exit_code": exit_code,
        "wall_seconds": round(elapsed, 1),
        "pi_peak_rss_mib": round(hwm_kib / 1024, 1),
        "limits": {"max_turns": args.max_turns, "max_seconds": args.max_seconds},
        **usage.as_dict(),
    }
    if summary["exit_reason"] == "turn_limit":
        # 第 max_turns + 1 次 turn_start 时才停下，那一次模型调用没有做完：和平台臂一样记上限的值。
        summary["turns"] = min(int(summary["turns"]), args.max_turns)
    (out / "driver.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
