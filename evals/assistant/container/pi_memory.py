"""量一个 pi 进程（RPC 模式）的内存：空闲时的常驻内存，和处理一轮提示时的峰值。

`pi --mode rpc` 启动后先等 5 秒（加载扩展、模型目录、skill），读常驻内存（VmRSS）作为空闲值；
再发一条提示，等到 `agent_settled`，期间每 0.2 秒读一次 VmRSS，取最大值作为工作时的峰值。
pi 起的命令是它的子进程，不算在里面。输出一行 JSON。

只用标准库，在工作台镜像自带的 python3 里运行。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
from pathlib import Path


def rss_kib(pid: int) -> int:
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1])
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--prompt", default="列出当前目录里的文件，告诉我有几个。")
    parser.add_argument("--timeout", type=float, default=300)
    args = parser.parse_args(argv)
    cmd = ["pi", "--mode", "rpc", "--no-session", "--offline", "--approve"]
    cmd += ["--provider", args.provider, "--model", args.model]
    proc = subprocess.Popen(
        cmd, cwd=args.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
    )
    assert proc.stdin is not None and proc.stdout is not None
    settled = threading.Event()

    def read() -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            try:
                event = json.loads(raw)
            except ValueError:
                continue
            if isinstance(event, dict) and event.get("type") == "agent_settled":
                settled.set()

    threading.Thread(target=read, daemon=True).start()
    time.sleep(5)
    idle = rss_kib(proc.pid)
    proc.stdin.write(
        (json.dumps({"id": "1", "type": "prompt", "message": args.prompt}) + "\n").encode()
    )
    proc.stdin.flush()
    peak = idle
    deadline = time.monotonic() + args.timeout
    while not settled.is_set() and time.monotonic() < deadline:
        peak = max(peak, rss_kib(proc.pid))
        time.sleep(0.2)
    after = rss_kib(proc.pid)
    proc.stdin.close()
    proc.terminate()
    proc.wait(timeout=30)
    print(
        json.dumps(
            {
                "idle_rss_mib": round(idle / 1024, 1),
                "working_peak_rss_mib": round(max(peak, after) / 1024, 1),
                "after_turn_rss_mib": round(after / 1024, 1),
                "settled": settled.is_set(),
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
