"""假的模型端点：只用来验证评测的流程（离线包、断网环境），不代表任何模型的能力。

说 OpenAI 的 chat completions 协议（流式）。按第一条用户消息认出是哪道题
（和 `tasks/*/prompt.md` 比对），然后照固定的剧本回复：先 `ls` 看一眼，
再执行这道题的参考答案（评测事先复制进开发环境容器的 solve.sh），最后说「完成」。
剧本走到第几步按请求里已有的工具结果条数算，服务本身不保存状态。

只用标准库，在工作台镜像自带的 python3 里运行。
"""

from __future__ import annotations

import argparse
import json
import re
import socketserver
import sys
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

TASKS_DIR = Path("/aeval/tasks")


def find_task(prompt: str, tasks_dir: Path) -> str | None:
    for path in sorted(tasks_dir.glob("*/prompt.md")):
        if path.read_text().strip() in prompt:
            return path.parent.name
    return None


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    return ""


# 评测在会话开始前把这道题的参考答案复制到开发环境容器的这个目录（只有用假的模型端点时）。
REFERENCE_DIR = "/tmp/aeval-reference"
# 参考答案在节点包目录里执行。会话的工作目录不是节点包目录时（平台的会话在工作区 /work，
# 题目的节点包在它下面），评测把节点包目录写进这个文件；没有这个文件时就在工作目录里执行。
WORKDIR_FILE = f"{REFERENCE_DIR}/workdir"


def script(task: str | None) -> list[str]:
    if task is None:
        return []
    return [
        "ls -la",
        f'cd "$(cat {WORKDIR_FILE} 2>/dev/null || pwd)" && bash {REFERENCE_DIR}/solve.sh',
    ]


TOOLCHECK = "AEVAL-TOOLCHECK"
PROBE = "AEVAL-PROBE"
# 探针（#539）的剧本：提示里写 AEVAL-SCRIPT:<名字> 时用同目录的 <名字>.json。
_SCRIPT = re.compile(r"AEVAL-SCRIPT:([a-z0-9-]+)")
_FULL_OUTPUT = re.compile(r"Full output: (/[^\]\s]+)\]")
_TOKEN = re.compile(r"AEVAL_SESSION_TOKEN=([A-Za-z0-9_-]+)")


def toolcheck_steps(name: str = "toolcheck.json") -> list[dict[str, Any]]:
    data = json.loads((Path(__file__).parent / name).read_text())
    steps: list[dict[str, Any]] = data["steps"]
    return steps


def _substitute(args: str, messages: list[dict[str, Any]]) -> str:
    """剧本里的占位：{full_output}、{first_line} 取上一个工具结果，{token} 取之前任一工具结果。"""
    last = _text(messages[-1].get("content")) if messages else ""
    if "{full_output}" in args:
        found = _FULL_OUTPUT.search(last)
        args = args.replace("{full_output}", found.group(1) if found else "/nonexistent")
    if "{first_line}" in args:
        first = next((line.strip() for line in last.splitlines() if line.strip()), "/nonexistent")
        args = args.replace("{first_line}", first)
    if "{token}" in args:
        tools = "\n".join(_text(m.get("content")) for m in messages if m.get("role") == "tool")
        found = _TOKEN.search(tools)
        args = args.replace("{token}", found.group(1) if found else "not-found")
    return args


def next_reply(body: dict[str, Any], tasks_dir: Path) -> dict[str, Any]:
    """下一步：要调用的工具，或者最后的文字。"""
    messages = body.get("messages") or []
    prompt = next((_text(m.get("content")) for m in messages if m.get("role") == "user"), "")
    done = sum(1 for m in messages if m.get("role") == "tool")
    named = _SCRIPT.search(prompt)
    script_file = (
        f"{named.group(1)}.json"
        if named
        else "toolcheck.json"
        if TOOLCHECK in prompt
        else "probecheck.json"
        if PROBE in prompt
        else None
    )
    if script_file:
        steps = toolcheck_steps(script_file)
        if done >= len(steps):
            return {"text": "完成。"}
        step = steps[done]
        if "text" in step:
            # 只回一段文字（不调工具）；delay 是回复之前等几秒（探针在这时插话）。
            return {"text": step["text"], "delay": float(step.get("delay", 0))}
        args = _substitute(json.dumps(step["args"], ensure_ascii=False), messages)
        return {"tool": step["tool"], "arguments": args, "call_id": f"call_{done + 1}"}
    commands = script(find_task(prompt, tasks_dir))
    if done < len(commands):
        return {
            "tool": "bash",
            "arguments": json.dumps({"command": commands[done]}),
            "call_id": f"call_{done + 1}",
        }
    if not commands:
        return {"text": "认不出这道题，什么都没做。"}
    return {"text": "完成。"}


def chunks(reply: dict[str, Any], model: str) -> list[dict[str, Any]]:
    base = {
        "id": "fake",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
    }
    usage = {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}
    if "tool" in reply:
        call = {
            "index": 0,
            "id": reply["call_id"],
            "type": "function",
            "function": {"name": reply["tool"], "arguments": reply["arguments"]},
        }
        delta: dict[str, Any] = {"role": "assistant", "content": None, "tool_calls": [call]}
        finish = "tool_calls"
    else:
        delta = {"role": "assistant", "content": reply["text"]}
        finish = "stop"
    return [
        {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}], "usage": usage},
    ]


class Handler(BaseHTTPRequestHandler):
    tasks_dir = TASKS_DIR
    # 给了目录时把收到的每个请求体原样存成 <序号>.json（探针看发给模型的系统提示用）。
    dump_dir: Path | None = None
    dumped = 0

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(f"{self.command} {self.path}\n")

    def do_GET(self) -> None:
        self._json(200, {"object": "list", "data": [{"id": "fake", "object": "model"}]})

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.dump_dir is not None:
            Handler.dumped += 1
            (self.dump_dir / f"{Handler.dumped:05d}.json").write_text(
                json.dumps(body, ensure_ascii=False)
            )
        reply = next_reply(body, self.tasks_dir)
        sys.stderr.write(f"回复：{json.dumps(reply, ensure_ascii=False)}\n")
        if reply.get("delay"):
            time.sleep(float(reply["delay"]))
        events = chunks(reply, str(body.get("model", "fake")))
        if not body.get("stream"):
            self._json(200, events[-1])
            return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()
        for event in events:
            self.wfile.write(f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True

    def _json(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="假的模型端点（只验证流程）")
    parser.add_argument("--port", type=int, default=8100)
    parser.add_argument("--tasks", type=Path, default=TASKS_DIR)
    parser.add_argument("--dump", type=Path, help="把收到的每个请求体存进这个目录")
    args = parser.parse_args(argv)
    Handler.tasks_dir = args.tasks
    if args.dump is not None:
        args.dump.mkdir(parents=True, exist_ok=True)
        Handler.dump_dir = args.dump
        # 重启之后接着编号，不覆盖已经存下的请求。
        Handler.dumped = len(list(args.dump.glob("*.json")))
    with Server(("0.0.0.0", args.port), Handler) as server:
        sys.stderr.write(f"假的模型端点在 :{args.port}\n")
        server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
