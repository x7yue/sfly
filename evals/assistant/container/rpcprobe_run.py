"""探针（#539）在探针容器里的那一半：用助手服务的那套启动参数起 pi 的 RPC 模式，照问题做实验，
把看到的原样写成 JSON（不下结论；结论由 aeval/rpcprobe.py 在宿主机上算）。

`python3 rpcprobe_run.py <问题> --out <文件>`，问题是 q1…q10。模型是同一个容器里的假模型端点
（fake_model.py，127.0.0.1:8101），它把收到的每个请求存进 `<根目录>/dump/`。

RPC 的读法照 pi 的文档：stdout 只按 LF 切记录（JSON 字符串里的 U+2028、U+2029 不算换行），
不用按 Unicode 换行切行的读法。

只用标准库，在工作台镜像自带的 python3 里运行。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import IO, Any

ROOT = Path("/root/rpcprobe")
AGENT_DIR = ROOT / "agent"
SESSIONS = ROOT / "sessions"
DUMP = ROOT / "dump"
EXTENSION = "/opt/aeval-remote/extension.mjs"
WORKSPACE = "/work/tc"
PROVIDER = "aeval"
MODEL = "fake"
TOOLCHECK_PROMPT = "AEVAL-TOOLCHECK：按剧本依次调用工具。"

Record = dict[str, Any]


def split_lines(stream: IO[bytes]) -> Iterator[bytes]:
    """按 LF 切分 JSONL，去掉行尾可选的 CR。"""
    pending = b""
    while True:
        chunk = stream.read1(65536)  # type: ignore[attr-defined]  # Popen 的 stdout 是 BufferedReader
        if not chunk:
            break
        pending += chunk
        *lines, pending = pending.split(b"\n")
        for line in lines:
            yield line[:-1] if line.endswith(b"\r") else line
    if pending:
        yield pending


def base_env() -> dict[str, str]:
    """只给 PATH、HOME、PI_CODING_AGENT_DIR、PI_TELEMETRY 和交给扩展的几项
    （issue 里定的启动环境）。"""
    return {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/root"),
        "PI_CODING_AGENT_DIR": str(AGENT_DIR),
        "PI_TELEMETRY": "0",
        "AEVAL_AGENT_ADDR": os.environ.get("AEVAL_AGENT_ADDR", "dev:50052"),
        "AEVAL_REMOTE_ENV": json.dumps({"SFLY_NICKNAME": "eval", "AI_AGENT": "pi"}),
        "AEVAL_REMOTE_LOG": str(ROOT / "remote-tools.jsonl"),
        "AEVAL_DEFAULT_TIMEOUT": "1200",
    }


def rpc_command(
    session_id: str, *, drop: tuple[str, ...] = (), add: tuple[str, ...] = ()
) -> list[str]:
    """助手服务的启动命令（#539 「已定的」）。`drop` 去掉某个开关（对照实验用），`add` 追加参数。"""
    parts: list[list[str]] = [
        ["--mode", "rpc"],
        ["--offline"],
        ["--no-extensions"],
        ["-e", EXTENSION],
        ["--tools", "read,bash,edit,write"],
        ["--no-approve"],
        ["--no-skills"],
        ["--skill", f"{WORKSPACE}/.agents/skills"],
        ["--no-context-files"],
        ["--append-system-prompt", str(ROOT / "context.md")],
        ["--no-prompt-templates"],
        ["--session-dir", str(SESSIONS / session_id)],
        ["--session-id", session_id],
        ["--provider", PROVIDER],
        ["--model", MODEL],
    ]
    cmd = ["pi"]
    for part in parts:
        if part[0] not in drop:
            cmd += part
    return cmd + list(add)


class RpcPi:
    """一个 RPC 模式的 pi 进程：发命令、等响应和事件。每条记录带上收到时的单调时钟。"""

    def __init__(
        self,
        cmd: list[str],
        *,
        cwd: str = WORKSPACE,
        stderr: Path | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        self.cmd = cmd
        self.started = time.monotonic()
        err = (stderr or ROOT / "pi-stderr.log").open("ab")
        self.proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            env={**base_env(), **(env or {})},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=err,
        )
        self.records: list[Record] = []
        self.lock = threading.Condition()
        self.next_id = 0
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for raw in split_lines(self.proc.stdout):
            try:
                record = json.loads(raw)
            except ValueError:
                record = {"type": "unparsed", "raw": raw.decode("utf-8", "replace")}
            if not isinstance(record, dict):
                continue
            record["_t"] = round(time.monotonic() - self.started, 3)
            with self.lock:
                self.records.append(record)
                self.lock.notify_all()
        with self.lock:
            self.lock.notify_all()

    def now(self) -> float:
        return round(time.monotonic() - self.started, 3)

    def send(self, command: Record) -> str:
        self.next_id += 1
        cid = f"probe-{self.next_id}"
        assert self.proc.stdin is not None
        self.proc.stdin.write(
            (json.dumps({"id": cid, **command}, ensure_ascii=False) + "\n").encode()
        )
        self.proc.stdin.flush()
        return cid

    def wait_for(self, pred: Callable[[Record], bool], timeout: float, start: int = 0) -> Record:
        deadline = time.monotonic() + timeout
        with self.lock:
            while True:
                for record in self.records[start:]:
                    if pred(record):
                        return record
                left = deadline - time.monotonic()
                if left <= 0 or (self.proc.poll() is not None and not self.reader.is_alive()):
                    raise TimeoutError(f"没有等到记录（{timeout} 秒）")
                self.lock.wait(min(left, 0.5))

    def call(self, command: Record, timeout: float = 60) -> Record:
        cid = self.send(command)
        return self.wait_for(lambda r: r.get("type") == "response" and r.get("id") == cid, timeout)

    def prompt_and_settle(self, message: str, timeout: float = 300) -> Record:
        mark = len(self.records)
        response = self.call({"type": "prompt", "message": message})
        if not response.get("success"):
            return response
        self.wait_for(lambda r: r.get("type") == "agent_settled", timeout, start=mark)
        return response

    def close(self, timeout: float = 60) -> float | None:
        """关 stdin 请求有序退出，返回从关 stdin 到进程退出的秒数（超时时结束进程，返回 None）。"""
        assert self.proc.stdin is not None
        begin = time.monotonic()
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
            return None
        self.reader.join(timeout=5)
        return round(time.monotonic() - begin, 3)

    def events(self) -> list[Record]:
        with self.lock:
            return list(self.records)


def run_json_mode(prompt: str, session_dir: Path) -> list[Record]:
    """对照：评测集臂 B 的 JSON 模式（session_driver.py 的那组参数加远程工具扩展）。"""
    cmd = [
        "pi", "--mode", "json", "--no-approve", "--offline",
        "--provider", PROVIDER, "--model", MODEL,
        "--session-dir", str(session_dir), "--extension", EXTENSION, prompt,
    ]  # fmt: skip
    proc = subprocess.run(
        cmd, cwd=WORKSPACE, env=base_env(), stdin=subprocess.DEVNULL, capture_output=True,
        timeout=600, check=False,
    )  # fmt: skip
    events: list[Record] = []
    for raw in proc.stdout.split(b"\n"):
        try:
            record = json.loads(raw)
        except ValueError:
            continue
        if isinstance(record, dict):
            events.append(record)
    return events


def dumped_requests(since: int = 0) -> list[Record]:
    files = sorted(DUMP.glob("*.json"))[since:]
    return [json.loads(f.read_text()) for f in files]


def dump_count() -> int:
    return len(list(DUMP.glob("*.json")))


# ---- 问题 ----


def q1() -> Record:
    """四个工具：同一个剧本，JSON 模式（臂 B 的参数）和 RPC 模式（助手服务的参数）各跑一遍。"""
    json_events = run_json_mode(TOOLCHECK_PROMPT, SESSIONS / "q1-json")
    local = Path(WORKSPACE) / "new"
    shutil.rmtree(local, ignore_errors=True)
    before = dump_count()
    pi = RpcPi(rpc_command("q1-rpc"))
    pi.prompt_and_settle(TOOLCHECK_PROMPT, timeout=600)
    exit_seconds = pi.close()
    requests = dumped_requests(before)
    declared = (
        [str((t.get("function") or {}).get("name")) for t in (requests[0].get("tools") or [])]
        if requests
        else []
    )
    return {
        "json": json_events,
        "rpc": pi.events(),
        "rpc_exit_seconds": exit_seconds,
        "declared_tools": declared,
        "system_prompt": system_prompt(requests[0]) if requests else "",
        # 写的文件要落在工作台上，探针容器里同名的空目录下不该出现。
        "written_locally": local.exists(),
    }


PLANTED_EXTENSION = """import {{ writeFileSync }} from "node:fs";
export default function () {{ writeFileSync({marker}, "loaded"); }}
"""


def q2() -> Record:
    """--no-extensions -e：设置目录和项目里的扩展加载不加载（看它们写不写标记文件）。"""
    markers = {
        "agent_dir": ROOT / "q2-agent-dir.marker",
        "project": ROOT / "q2-project.marker",
        "settings": ROOT / "q2-settings.marker",
    }
    places = {
        "agent_dir": AGENT_DIR / "extensions",
        "project": Path(WORKSPACE) / ".pi" / "extensions",
        "settings": ROOT / "q2-configured",
    }
    # 设置文件里配置的扩展（settings.json 的 extensions）。
    (AGENT_DIR / "settings.json").write_text(json.dumps({"extensions": [str(places["settings"])]}))
    for key, folder in places.items():
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "planted.ts").write_text(
            PLANTED_EXTENSION.format(marker=json.dumps(str(markers[key])))
        )
    result: Record = {}
    for run, drop in (("probe", ()), ("control", ("--no-extensions",))):
        for marker in markers.values():
            marker.unlink(missing_ok=True)
        pi = RpcPi(rpc_command(f"q2-{run}", drop=drop))
        response = pi.prompt_and_settle("你好")
        commands = pi.call({"type": "get_commands"}).get("data") or {}
        pi.close()
        result[run] = {
            "prompt_ok": bool(response.get("success")),
            "markers": {key: m.exists() for key, m in markers.items()},
            "extension_commands": sorted(
                str(c.get("name"))
                for c in commands.get("commands", [])
                if c.get("source") == "extension"
            ),
        }
    shutil.rmtree(places["agent_dir"])
    shutil.rmtree(places["project"].parent)
    shutil.rmtree(places["settings"])
    (AGENT_DIR / "settings.json").unlink()
    result["read_only_agent_dir"] = read_only_agent_dir()
    return result


NOBODY = 65534


def read_only_agent_dir() -> Record:
    """退路（「设置目录归另一个用户、pi 只读」）行不行：
    pi 以 nobody 运行，设置目录归 root、只读。"""
    base = Path("/tmp/rpcprobe-ro")
    shutil.rmtree(base, ignore_errors=True)
    agent, sessions, home = base / "agent", base / "sessions", base / "home"
    for folder in (agent, sessions, home):
        folder.mkdir(parents=True)
    shutil.copy(ROOT / "models.json", agent / "models.json")
    shutil.copy(ROOT / "context.md", base / "context.md")
    for path in (base, sessions, home):
        os.chown(path, NOBODY, NOBODY)
    agent.chmod(0o755)
    # 远程工具扩展启动时把工作台上的 skill 复制到本地同名目录，要能写。
    subprocess.run(["chown", "-R", f"{NOBODY}:{NOBODY}", WORKSPACE], check=True)
    cmd = [
        "setpriv", f"--reuid={NOBODY}", f"--regid={NOBODY}", "--clear-groups",
        *rpc_command(
            "ro",
            drop=("--session-dir", "--append-system-prompt"),
            add=(
                "--session-dir",
                str(sessions),
                "--append-system-prompt",
                str(base / "context.md"),
            ),
        ),
    ]  # fmt: skip
    env = {
        "HOME": str(home),
        "PI_CODING_AGENT_DIR": str(agent),
        "AEVAL_REMOTE_LOG": str(base / "remote-tools.jsonl"),
    }
    try:
        pi = RpcPi(cmd, env=env, stderr=base / "pi-stderr.log")
        try:
            response = pi.call({"type": "prompt", "message": "你好"}, timeout=60)
        except TimeoutError as error:
            response = {"success": False, "error": f"没有响应：{error}"}
        pi.close()
    finally:
        subprocess.run(["chown", "-R", "0:0", WORKSPACE], check=True)
    return {
        "prompt_ok": bool(response.get("success")),
        "error": str(response.get("error", ""))[:300],
        "agent_dir_files": sorted(p.name for p in agent.iterdir()),
    }


def _skill(folder: Path, name: str, marker: str) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {marker} 探针放的 skill。\n---\n\n# {name}\n\n{marker}\n"
    )


Q3_SYSTEM_FILES = (AGENT_DIR / "SYSTEM.md", Path(WORKSPACE) / ".pi" / "SYSTEM.md")


def plant_q3() -> list[Path]:
    """各个默认位置放上带标记的文件；返回放过的东西（之后删掉）。
    给的东西：--skill 目录里的 given-skill、
    --append-system-prompt 的 context.md。两个 SYSTEM.md（Q3_SYSTEM_FILES）由 q3 自己放。"""
    ws = Path(WORKSPACE)
    home = Path(os.environ.get("HOME", "/root"))
    planted: list[Path] = []

    def text(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        planted.append(path)

    text(ws / "AGENTS.md", "MARK-LOCAL-WS-AGENTS\n")
    text(ws.parent / "CLAUDE.md", "MARK-LOCAL-PARENT-CLAUDE\n")
    text(AGENT_DIR / "AGENTS.md", "MARK-AGENT-DIR-AGENTS\n")
    text(AGENT_DIR / "APPEND_SYSTEM.md", "MARK-AGENT-DIR-APPEND-SYSTEM\n")
    text(ws / ".pi" / "APPEND_SYSTEM.md", "MARK-PROJECT-APPEND-SYSTEM\n")
    text(
        AGENT_DIR / "prompts" / "tpl-agent-dir.md", "---\ndescription: MARK-TPL-AGENT-DIR\n---\nx\n"
    )
    text(ws / ".pi" / "prompts" / "tpl-project.md", "---\ndescription: MARK-TPL-PROJECT\n---\nx\n")
    for folder, name, marker in (
        (AGENT_DIR / "skills" / "extra-agent-dir", "extra-agent-dir", "MARK-SKILL-AGENT-DIR"),
        (home / ".agents" / "skills" / "extra-home", "extra-home", "MARK-SKILL-HOME-AGENTS"),
        (ws / ".pi" / "skills" / "extra-project", "extra-project", "MARK-SKILL-PROJECT-PI"),
        (
            ws.parent / ".agents" / "skills" / "extra-parent",
            "extra-parent",
            "MARK-SKILL-PARENT-AGENTS",
        ),
        (ws / ".agents" / "skills" / "given-skill", "given-skill", "MARK-SKILL-GIVEN"),
    ):
        _skill(folder, name, marker)
        planted.append(folder / "SKILL.md")
    # 设置文件里配置的 skill 和提示模板（settings.json 的 skills、prompts）。
    configured = ROOT / "q3-configured"
    _skill(configured / "skills" / "extra-settings", "extra-settings", "MARK-SKILL-SETTINGS")
    text(
        configured / "prompts" / "tpl-settings.md", "---\ndescription: MARK-TPL-SETTINGS\n---\nx\n"
    )
    planted.append(configured / "skills" / "extra-settings" / "SKILL.md")
    text(
        AGENT_DIR / "settings.json",
        json.dumps(
            {"skills": [str(configured / "skills")], "prompts": [str(configured / "prompts")]}
        ),
    )
    return planted


def system_prompt(request: Record) -> str:
    for message in request.get("messages") or []:
        if message.get("role") in ("system", "developer"):
            return _text(message.get("content"))
    return ""


def q3() -> Record:
    """--no-skills --skill、--no-context-files --append-system-prompt、--no-prompt-templates：
    发给模型的系统提示和可用命令里只有给的东西。
    对照：去掉这三个 --no-* 开关、加 --approve 再跑一遍。"""
    (ROOT / "context.md").write_text("MARK-GIVEN-CONTEXT\n")
    planted = plant_q3()
    result: Record = {}
    for run, drop, add in (
        # 先不放 SYSTEM.md：默认系统提示，助手服务走的路径。
        ("default", (), ()),
        # 再放上两个 SYSTEM.md：系统提示整个被换掉的情况和它的对照。
        ("probe", (), ()),
        (
            "control",
            ("--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve"),
            ("--approve",),
        ),
    ):
        if run == "probe":
            for path, mark in zip(
                Q3_SYSTEM_FILES, ("MARK-AGENT-DIR-SYSTEM", "MARK-PROJECT-SYSTEM"), strict=True
            ):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(mark + "\n")
                planted.append(path)
        before = dump_count()
        pi = RpcPi(rpc_command(f"q3-{run}", drop=drop, add=add))
        commands = pi.call({"type": "get_commands"})
        pi.prompt_and_settle("你好")
        pi.close()
        requests = dumped_requests(before)
        result[run] = {
            "system_prompt": system_prompt(requests[0]) if requests else "",
            "commands": [
                {
                    "name": c.get("name"),
                    "source": c.get("source"),
                    "description": c.get("description"),
                }
                for c in (commands.get("data") or {}).get("commands", [])
            ],
        }
    for path in planted:
        path.unlink(missing_ok=True)
    home = Path(os.environ.get("HOME", "/root"))
    for folder in (
        Path(WORKSPACE) / ".pi",
        Path(WORKSPACE).parent / ".agents",
        home / ".agents",
        ROOT / "q3-configured",
    ):
        shutil.rmtree(folder, ignore_errors=True)
    shutil.rmtree(Path(WORKSPACE) / ".agents" / "skills" / "given-skill", ignore_errors=True)
    return result


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    return "".join(str(p.get("text", "")) for p in content or [] if isinstance(p, dict))


def _messages(pi: RpcPi) -> list[Record]:
    data = pi.call({"type": "get_messages"}).get("data") or {}
    return [
        {"role": m.get("role"), "text": _text(m.get("content"))[:200]}
        for m in data.get("messages", [])
    ]


def q4() -> Record:
    """--session-dir D --session-id S：第一次新建，关 stdin 退出后同一条命令再起是恢复。"""
    session = "q4-session"
    cmd = rpc_command(session)
    first_stderr = ROOT / "q4-first-stderr.log"
    first = RpcPi(cmd, stderr=first_stderr)
    first.prompt_and_settle("第一句")
    first.prompt_and_settle("第二句")
    state1 = first.call({"type": "get_state"}).get("data") or {}
    messages1 = _messages(first)
    exit1 = first.close()
    files_after_first = sorted(p.name for p in (SESSIONS / session).rglob("*.jsonl"))
    # 两次启动之间换掉 --append-system-prompt 的文件：恢复后发给模型的系统提示用新的还是会话里存的。
    (ROOT / "context.md").write_text("MARK-GIVEN-CONTEXT-SECOND\n")
    second = RpcPi(cmd)
    state2 = second.call({"type": "get_state"}).get("data") or {}
    messages2 = _messages(second)
    before = dump_count()
    second.prompt_and_settle("第三句")
    messages3 = _messages(second)
    sent = dumped_requests(before)
    last_request_users = (
        [
            _text(m.get("content"))
            for m in (sent[-1].get("messages") or [])
            if m.get("role") == "user"
        ]
        if sent
        else []
    )
    resumed_prompt = system_prompt(sent[-1]) if sent else ""
    exit2 = second.close()
    files_after_second = sorted(p.name for p in (SESSIONS / session).rglob("*.jsonl"))
    keep = ("sessionId", "sessionFile", "messageCount")
    return {
        "first": {
            "state": {k: state1.get(k) for k in keep},
            "messages": messages1,
            "exit_seconds": exit1,
            "stderr": first_stderr.read_text()[-600:] if first_stderr.exists() else "",
        },
        "second": {
            "state": {k: state2.get(k) for k in keep},
            "messages_on_start": messages2,
            "messages_after_third": messages3,
            "last_request_users": last_request_users,
            "context_after_restart": (
                "second"
                if "MARK-GIVEN-CONTEXT-SECOND" in resumed_prompt
                else "first"
                if "MARK-GIVEN-CONTEXT" in resumed_prompt
                else "none"
            ),
            "exit_seconds": exit2,
        },
        "files": {"after_first": files_after_first, "after_second": files_after_second},
    }


# ---- 第 5 到 10 题 ----


def script_prompt(name: str, text: str = "照剧本做。") -> str:
    """让假的模型端点照 container/<name>.json 的剧本回复。"""
    return f"AEVAL-SCRIPT:{name} {text}"


def wait_tool_started(pi: RpcPi, start: int = 0, timeout: float = 60) -> Record:
    return pi.wait_for(lambda r: r.get("type") == "tool_execution_start", timeout, start=start)


def find(pi: RpcPi, kind: str, start: int = 0) -> Record | None:
    return next((r for r in pi.events()[start:] if r.get("type") == kind), None)


def requests_text(requests: list[Record]) -> list[list[Record]]:
    """每个发给模型的请求里的消息：角色、文字（截断）、工具调用的 ID。"""
    found = []
    for request in requests:
        messages = []
        for m in request.get("messages") or []:
            item: Record = {"role": m.get("role"), "text": _text(m.get("content"))[:300]}
            if m.get("tool_call_id"):
                item["tool_call_id"] = m["tool_call_id"]
            if m.get("tool_calls"):
                item["tool_calls"] = [c.get("id") for c in m["tool_calls"]]
            messages.append(item)
        found.append(messages)
    return found


def session_file(session: str) -> Path | None:
    files = sorted((SESSIONS / session).glob("*.jsonl"))
    return files[0] if files else None


def tail_lines(path: Path | None, count: int = 3) -> list[str]:
    if path is None or not path.exists():
        return []
    return [line[:300] for line in path.read_text().splitlines()[-count:]]


def tool_result_in_session(path: Path | None) -> str | None:
    """会话文件里最后一条工具结果是什么（解析整行，不截短）：「aborted」（Command aborted）、
    「slept」（命令照常跑完）、别的文字原样，没有工具结果时 None。"""
    if path is None or not path.exists():
        return None
    found: str | None = None
    for line in path.read_text().splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        message = entry.get("message") if isinstance(entry, dict) else None
        if not isinstance(message, dict) or message.get("role") != "toolResult":
            continue
        text = _text(message.get("content"))
        found = (
            "aborted" if "Command aborted" in text else "slept" if "slept" in text else text[:80]
        )
    return found


def last_line_is_json(path: Path | None) -> bool:
    """会话文件的最后一行能不能解析成 JSON（被结束时没有留下写了一半的一行）。"""
    if path is None or not path.exists():
        return False
    lines = path.read_text().splitlines()
    if not lines:
        return False
    try:
        json.loads(lines[-1])
    except ValueError:
        return False
    return True


def q5() -> Record:
    """工具执行到一半时 kill -9，同一条命令再起，发「继续」：
    会话文件、发给模型的内容、工作台上的命令。
    另做一遍：再起之前在会话文件末尾加半行（写到一半被结束），看 pi 会不会报错。"""
    result: Record = {}
    for variant in ("as_killed", "half_line"):
        session = f"q5-{variant}"
        cmd = rpc_command(session)
        first = RpcPi(cmd)
        first.call({"type": "prompt", "message": script_prompt("rpcprobe-kill")})
        wait_tool_started(first)
        time.sleep(1)
        killed_at = time.time()
        first.proc.kill()
        first.proc.wait()
        path = session_file(session)
        if variant == "half_line" and path is not None:
            with path.open("a") as f:
                f.write('{"type":"message","id":"half","message":{"role":"assi')
        lines = tail_lines(path)
        second = RpcPi(cmd, stderr=ROOT / f"q5-{variant}-stderr.log")
        try:
            started = second.call({"type": "get_state"}, timeout=30)
            messages = _messages(second)
            before = dump_count()
            mark = len(second.events())
            response = second.call({"type": "prompt", "message": "继续"}, timeout=30)
            try:
                second.wait_for(
                    lambda r: r.get("type") in ("agent_settled", "tool_execution_start"),
                    30,
                    start=mark,
                )
            except TimeoutError:
                pass
            restarted_tool = find(second, "tool_execution_start", mark) is not None
            if restarted_tool:
                second.call({"type": "abort"}, timeout=60)
            sent = requests_text(dumped_requests(before))
            exit_seconds = second.close()
            result[variant] = {
                "killed_at": killed_at,
                "session_tail": lines,
                "restart_ok": bool(started.get("success")),
                "restart_error": started.get("error"),
                "messages_on_restart": messages,
                "prompt_ok": bool(response.get("success")),
                "prompt_error": response.get("error"),
                "first_request": sent[0] if sent else [],
                "requests": len(sent),
                "reran_tool": restarted_tool,
                "exit_seconds": exit_seconds,
                "stderr": (ROOT / f"q5-{variant}-stderr.log").read_text()[-600:],
            }
        except TimeoutError as error:
            second.proc.kill()
            result[variant] = {
                "killed_at": killed_at,
                "session_tail": lines,
                "restart_ok": False,
                "restart_error": str(error),
                "stderr": (ROOT / f"q5-{variant}-stderr.log").read_text()[-600:],
            }
    return result


def q6() -> Record:
    """远程执行 sleep 602 时发 abort：到 abort 的响应、到 agent_settled 各多久
    （工作台上的进程由宿主机量）。"""
    pi = RpcPi(rpc_command("q6"))
    pi.call({"type": "prompt", "message": script_prompt("rpcprobe-abort")})
    wait_tool_started(pi)
    time.sleep(1)
    mark = len(pi.events())
    sent_at, wall = pi.now(), time.time()
    response = pi.call({"type": "abort"}, timeout=120)
    settled = pi.wait_for(lambda r: r.get("type") == "agent_settled", 120, start=mark)
    tool_end = find(pi, "tool_execution_end", mark)
    next_turn = _after_abort(pi)
    exit_seconds = pi.close()
    return {
        "next_turn": next_turn,
        "abort_sent_at": wall,
        "abort_response_seconds": round(response["_t"] - sent_at, 3),
        "abort_ok": bool(response.get("success")),
        "settled_seconds": round(settled["_t"] - sent_at, 3),
        "settled_aborted": settled.get("aborted"),
        "tool_end_seconds": round(tool_end["_t"] - sent_at, 3) if tool_end else None,
        "tool_result": _text((tool_end or {}).get("result", {}).get("content"))[:300],
        "exit_seconds": exit_seconds,
    }


def _after_abort(pi: RpcPi) -> Record:
    """abort 之后同一个进程再发一轮：发不发得出去、做没做完，发给模型的请求和之后的会话。"""
    messages_before = _messages(pi)
    before = dump_count()
    mark = len(pi.events())
    response = pi.call({"type": "prompt", "message": "接着说"})
    settled = None
    if response.get("success"):
        try:
            settled = pi.wait_for(lambda r: r.get("type") == "agent_settled", 120, start=mark)
        except TimeoutError:
            settled = None
    ends = [
        r.get("message") or {}
        for r in pi.events()[mark:]
        if r.get("type") == "message_end" and (r.get("message") or {}).get("role") == "assistant"
    ]
    last = ends[-1] if ends else {}
    sent = requests_text(dumped_requests(before))
    return {
        "messages_before": messages_before,
        "prompt_ok": bool(response.get("success")),
        "prompt_error": response.get("error"),
        "settled": settled is not None,
        "stop_reason": last.get("stopReason"),
        "error": last.get("errorMessage"),
        "request": sent[0] if sent else [],
        "messages_after": _messages(pi),
    }


def _user_messages(pi: RpcPi, start: int = 0) -> list[Record]:
    """事件里出现的用户消息（message_end，role=user）：插话送出时它作为用户消息出现。"""
    return [
        {"t": r["_t"], "text": _text((r.get("message") or {}).get("content"))[:300]}
        for r in pi.events()[start:]
        if r.get("type") == "message_end" and (r.get("message") or {}).get("role") == "user"
    ]


def _queue_updates(pi: RpcPi, start: int = 0) -> list[Record]:
    return [
        {"t": r["_t"], "steering": r.get("steering"), "followUp": r.get("followUp")}
        for r in pi.events()[start:]
        if r.get("type") == "queue_update"
    ]


def _order(pi: RpcPi, start: int, kinds: tuple[str, ...]) -> list[str]:
    return [str(r.get("type")) for r in pi.events()[start:] if r.get("type") in kinds]


STEER = "插话：顺便看一下日志"


def q7() -> Record:
    """steer 什么时候送到：命令执行中、最后一次回复不带工具调用时、
    插话后先 clear_queue 再 abort。"""
    result: Record = {}
    # 1. 命令执行中插话
    pi = RpcPi(rpc_command("q7-during-tool"))
    before = dump_count()
    pi.call({"type": "prompt", "message": script_prompt("rpcprobe-steer")})
    wait_tool_started(pi)
    mark = len(pi.events())
    steer = pi.call({"type": "steer", "message": STEER})
    pi.wait_for(lambda r: r.get("type") == "agent_settled", 120, start=mark)
    sent = requests_text(dumped_requests(before))
    result["during_tool"] = {
        "steer_response": {k: steer.get(k) for k in ("success", "data", "error")},
        "queue_updates": _queue_updates(pi, mark),
        "user_messages": _user_messages(pi, mark),
        "order": _order(
            pi,
            mark,
            ("queue_update", "tool_execution_end", "turn_end", "turn_start", "message_start"),
        ),
        "requests": sent,
    }
    pi.close()
    # 2. 最后一次回复不带工具调用（回复之前等 4 秒）时插话
    pi = RpcPi(rpc_command("q7-text-only"))
    before = dump_count()
    pi.call({"type": "prompt", "message": script_prompt("rpcprobe-slow-text")})
    pi.wait_for(lambda r: r.get("type") == "turn_start", 30)
    time.sleep(1)
    mark = len(pi.events())
    steer = pi.call({"type": "steer", "message": STEER})
    pi.wait_for(lambda r: r.get("type") == "agent_settled", 120, start=0)
    sent = requests_text(dumped_requests(before))
    result["text_only"] = {
        "steer_response": {k: steer.get(k) for k in ("success", "data", "error")},
        "queue_updates": _queue_updates(pi, mark),
        "user_messages": _user_messages(pi, mark),
        "requests": sent,
        "messages": _messages(pi),
    }
    pi.close()
    # 3. 插话之后先 clear_queue 再 abort
    pi = RpcPi(rpc_command("q7-clear"))
    before = dump_count()
    pi.call({"type": "prompt", "message": script_prompt("rpcprobe-abort")})
    wait_tool_started(pi)
    mark = len(pi.events())
    steer = pi.call({"type": "steer", "message": STEER})
    cleared = pi.call({"type": "clear_queue"})
    aborted = pi.call({"type": "abort"}, timeout=120)
    pi.wait_for(lambda r: r.get("type") == "agent_settled", 120, start=mark)
    time.sleep(1)
    sent = requests_text(dumped_requests(before))
    result["clear_then_abort"] = {
        "steer_response": {k: steer.get(k) for k in ("success", "data", "error")},
        "clear_queue": cleared.get("data"),
        "abort_ok": bool(aborted.get("success")),
        "queue_updates": _queue_updates(pi, mark),
        "user_messages": _user_messages(pi, mark),
        "requests": sent,
        "messages": _messages(pi),
    }
    pi.close()
    return result


def q8() -> Record:
    """关 stdin、SIGTERM 的收场：空闲时关 stdin；一轮进行中关 stdin；
    一轮进行中关 stdin 同时发 SIGTERM；一轮进行中只发 SIGTERM（stdin 开着）。"""
    result: Record = {}
    pi = RpcPi(rpc_command("q8-idle"))
    pi.call({"type": "get_state"})
    result["idle"] = {"exit_seconds": pi.close(), "exit_code": pi.proc.returncode}
    for variant in ("mid_turn", "mid_turn_sigterm", "sigterm_only"):
        session = f"q8-{variant}"
        pi = RpcPi(rpc_command(session))
        pi.call({"type": "prompt", "message": script_prompt("rpcprobe-steer")})
        wait_tool_started(pi)
        time.sleep(1)
        mark = len(pi.events())
        closed_at, wall = pi.now(), time.time()
        assert pi.proc.stdin is not None
        if variant != "sigterm_only":
            pi.proc.stdin.close()
        if variant in ("mid_turn_sigterm", "sigterm_only"):
            pi.proc.send_signal(signal.SIGTERM)
        try:
            pi.proc.wait(timeout=120)
            exit_seconds: float | None = round(pi.now() - closed_at, 3)
        except subprocess.TimeoutExpired:
            pi.proc.kill()
            pi.proc.wait()
            exit_seconds = None
        pi.reader.join(timeout=5)
        tool_end = find(pi, "tool_execution_end", mark)
        settled = find(pi, "agent_settled", mark)
        result[variant] = {
            "closed_at": wall,
            "exit_seconds": exit_seconds,
            "exit_code": pi.proc.returncode,
            "tool_end_seconds": round(tool_end["_t"] - closed_at, 3) if tool_end else None,
            "tool_result": _text((tool_end or {}).get("result", {}).get("content"))[:200],
            "settled": settled is not None,
            "events_after_close": _order(
                pi, mark, ("tool_execution_end", "turn_end", "agent_end", "agent_settled")
            ),
            "session_tail": tail_lines(session_file(session), 2),
            "session_tool_result": tool_result_in_session(session_file(session)),
            "session_last_line_json": last_line_is_json(session_file(session)),
        }
    return result


def _rss_kib(pid: int, field: str) -> int | None:
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith(f"{field}:"):
                return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        return None
    return None


def q9() -> Record:
    """带扩展的 RPC 进程：从启动到能接第一条命令的时间、空闲常驻内存、处理一轮时的峰值（VmHWM）。"""
    runs = []
    for i in range(3):
        pi = RpcPi(rpc_command(f"q9-{i}"))
        ready = pi.call({"type": "get_state"}, timeout=60)
        ready_seconds = ready["_t"]
        time.sleep(5)
        idle = _rss_kib(pi.proc.pid, "VmRSS")
        pi.prompt_and_settle(TOOLCHECK_PROMPT, timeout=600)
        peak = _rss_kib(pi.proc.pid, "VmHWM")
        after = _rss_kib(pi.proc.pid, "VmRSS")
        pi.close()
        runs.append(
            {
                "ready_seconds": ready_seconds,
                "idle_rss_mib": round((idle or 0) / 1024, 1),
                "peak_hwm_mib": round((peak or 0) / 1024, 1),
                "after_turn_rss_mib": round((after or 0) / 1024, 1),
            }
        )
    return {"runs": runs}


CWD_EXTENSION = """export default function (pi) {{
  pi.on("before_agent_start", async (event) => {{
    event.systemPromptOptions.cwd = {cwd};
  }});
}}
"""


def q10() -> Record:
    """扩展在 before_agent_start 里改系统提示里的工作目录：
    pi 在 /srv/assistant 里运行，扩展改成工作台上的路径。"""
    local = Path("/srv/assistant")
    local.mkdir(parents=True, exist_ok=True)
    extension = ROOT / "q10-cwd.mjs"
    extension.write_text(CWD_EXTENSION.format(cwd=json.dumps(WORKSPACE)))
    result: Record = {}
    # 不加载远程工具扩展：它按本地的工作目录去工作台上找 skill，这里的工作目录在工作台上不存在。
    for run, extra in (("probe", ("-e", str(extension))), ("control", ())):
        before = dump_count()
        pi = RpcPi(rpc_command(f"q10-{run}", drop=("-e",), add=extra), cwd=str(local))
        pi.prompt_and_settle("你好")
        pi.close()
        requests = dumped_requests(before)
        prompt = system_prompt(requests[0]) if requests else ""
        lines = [
            line for line in prompt.splitlines() if "/srv/assistant" in line or WORKSPACE in line
        ]
        result[run] = {"cwd_lines": lines}
    return result


# ---- 544-B 先测的七题（第 11 到 17 题）----
# 助手服务停止一轮时接连写 clear_queue 和 abort、插话设成「一次全送」、
# 按顺序认「送到」：动手之前先在真的 pi 上看。

STEER_A = "插话一：先别改测试"
STEER_B = "插话二：顺便看一下日志"
HANDLED_EXTENSION = str(Path(__file__).resolve().parent / "rpcprobe-handled.ts")


def send_together(pi: RpcPi, commands: list[Record]) -> list[str]:
    """几条命令在同一次写里写出（不等前一条的回应）：助手服务停止一轮时就是这样写的。"""
    ids = []
    lines = b""
    for command in commands:
        pi.next_id += 1
        cid = f"probe-{pi.next_id}"
        ids.append(cid)
        lines += (json.dumps({"id": cid, **command}, ensure_ascii=False) + "\n").encode()
    assert pi.proc.stdin is not None
    pi.proc.stdin.write(lines)
    pi.proc.stdin.flush()
    return ids


def response_of(pi: RpcPi, cid: str, timeout: float = 60) -> Record:
    return pi.wait_for(lambda r: r.get("type") == "response" and r.get("id") == cid, timeout)


def _settled(pi: RpcPi, start: int, timeout: float = 120) -> Record:
    return pi.wait_for(lambda r: r.get("type") == "agent_settled", timeout, start=start)


def _user_texts_sent(requests: list[list[Record]]) -> list[str]:
    return [m["text"] for request in requests for m in request if m.get("role") == "user"]


def _assistant_ends(pi: RpcPi, start: int = 0) -> list[Record]:
    return [
        {
            "t": r["_t"],
            "stop_reason": (r.get("message") or {}).get("stopReason"),
            "text": _text((r.get("message") or {}).get("content"))[:300],
        }
        for r in pi.events()[start:]
        if r.get("type") == "message_end" and (r.get("message") or {}).get("role") == "assistant"
    ]


def q11() -> Record:
    """模型输出到一半时 abort：这一轮怎么结束，之后同一个进程再发一轮是不是照常做完、"
    "发给模型的请求是什么样。"""
    pi = RpcPi(rpc_command("q11"))
    pi.call({"type": "prompt", "message": script_prompt("rpcprobe-midstream")})
    pi.wait_for(
        lambda r: (
            r.get("type") == "message_update"
            and (r.get("assistantMessageEvent") or {}).get("type") == "text_delta"
        ),
        60,
    )
    time.sleep(1.5)
    mark = len(pi.events())
    deltas = sum(
        1
        for r in pi.events()
        if r.get("type") == "message_update"
        and (r.get("assistantMessageEvent") or {}).get("type") == "text_delta"
    )
    sent_at = pi.now()
    response = pi.call({"type": "abort"}, timeout=60)
    settled = _settled(pi, mark, 60)
    ends = _assistant_ends(pi, mark)
    next_turn = _after_abort(pi)
    exit_seconds = pi.close()
    return {
        "deltas_before_abort": deltas,
        "abort_ok": bool(response.get("success")),
        "abort_response_seconds": round(response["_t"] - sent_at, 3),
        "settled_seconds": round(settled["_t"] - sent_at, 3),
        "settled_aborted": settled.get("aborted"),
        "aborted_message": ends[-1] if ends else None,
        "next_turn": next_turn,
        "exit_seconds": exit_seconds,
    }


def _wait_busy(pi: RpcPi, script: str) -> None:
    """等到这一轮在忙：命令开始执行（rpcprobe-abort），或者模型开始输出、"
    "再过一秒（rpcprobe-midstream）。"""
    if script == "rpcprobe-midstream":
        pi.wait_for(
            lambda r: (
                r.get("type") == "message_update"
                and (r.get("assistantMessageEvent") or {}).get("type") == "text_delta"
            ),
            60,
        )
        time.sleep(1)
    else:
        wait_tool_started(pi)


def _clear_then_abort(
    together: bool, steers: list[str], round_no: int, script: str = "rpcprobe-abort"
) -> Record:
    """命令执行中插话（等 steer 的回应回来），然后写 clear_queue 和 abort（同一次写，"
    "或者接连两次写），
    看插话有没有漏出去：之后发给模型的请求、会话里、同一个进程的下一轮。"""
    pi = RpcPi(rpc_command(f"q12-{script}-{'together' if together else 'apart'}-{round_no}"))
    before = dump_count()
    pi.call({"type": "prompt", "message": script_prompt(script)})
    _wait_busy(pi, script)
    for text in steers:
        pi.call({"type": "steer", "message": text})
    mark = len(pi.events())
    if together:
        clear_id, abort_id = send_together(pi, [{"type": "clear_queue"}, {"type": "abort"}])
    else:
        clear_id = pi.send({"type": "clear_queue"})
        abort_id = pi.send({"type": "abort"})
    cleared = response_of(pi, clear_id)
    aborted = response_of(pi, abort_id, 60)
    _settled(pi, mark)
    time.sleep(1)
    during = requests_text(dumped_requests(before))
    next_turn = _after_abort(pi)
    pi.close()
    return {
        "together": together,
        "script": script,
        "clear_queue": cleared.get("data"),
        "clear_before_abort": cleared["_t"] <= aborted["_t"],
        "abort_ok": bool(aborted.get("success")),
        "user_messages": _user_messages(pi, mark),
        "sent_during_turn": _user_texts_sent(during),
        "next_turn_request": next_turn["request"],
        "next_turn_settled": next_turn["settled"],
        "messages_after": next_turn["messages_after"],
    }


def q12() -> Record:
    """abort 紧跟在 clear_queue 后面写出：没有插话漏出去（各五遍，一句和两句；"
    "同一次写和接连两次写）。"""
    rounds = []
    for round_no in range(5):
        for together in (True, False):
            steers = [STEER_A] if round_no % 2 == 0 else [STEER_A, STEER_B]
            rounds.append(_clear_then_abort(together, steers, round_no))
    # 模型输出到一半时停止（不在命令执行中）：一句和两句各一遍。
    for round_no, steers in enumerate(([STEER_A], [STEER_A, STEER_B])):
        rounds.append(_clear_then_abort(True, steers, round_no, "rpcprobe-midstream"))
    return {"rounds": rounds}


def _race(gap: float | None, round_no: int, script: str = "rpcprobe-abort") -> Record:
    """steer 写出之后、它的回应回来之前就写 clear_queue 和 abort（gap 是 None：三条在同一次写里；"
    "否则 steer 先写，
    隔 gap 秒再写 clear_queue 和 abort）。
    这句话可能在清空之后才进队列：看它最后去了哪里：成了这一轮的一条用户消息
    （在 agent_settled 之前还是之后）、留在 pi 的队列里（下一轮之前的 clear_queue 取回），
    还是别的。"""
    pi = RpcPi(rpc_command(f"q13-{script}-{gap}-{round_no}"))
    before = dump_count()
    pi.call({"type": "prompt", "message": script_prompt(script)})
    _wait_busy(pi, script)
    mark = len(pi.events())
    if gap is None:
        steer_id, clear_id, abort_id = send_together(
            pi, [{"type": "steer", "message": STEER_B}, {"type": "clear_queue"}, {"type": "abort"}]
        )
    else:
        steer_id = pi.send({"type": "steer", "message": STEER_B})
        time.sleep(gap)
        clear_id, abort_id = send_together(pi, [{"type": "clear_queue"}, {"type": "abort"}])
    steer = response_of(pi, steer_id)
    cleared = response_of(pi, clear_id)
    aborted = response_of(pi, abort_id, 60)
    settled = _settled(pi, mark)
    time.sleep(1)
    during = requests_text(dumped_requests(before))
    turn_users = _user_messages(pi, mark)
    state = pi.call({"type": "get_state"}).get("data") or {}
    pre = pi.call({"type": "clear_queue"}).get("data")
    next_turn = _after_abort(pi)
    pi.close()
    return {
        "gap": gap,
        "script": script,
        "order": [
            name
            for r in pi.events()[mark:]
            for name, cid in (("steer", steer_id), ("clear_queue", clear_id), ("abort", abort_id))
            if r.get("type") == "response" and r.get("id") == cid
        ],
        "steer_response": {k: steer.get(k) for k in ("success", "data", "error")},
        "clear_queue": cleared.get("data"),
        "abort_ok": bool(aborted.get("success")),
        "settled_t": settled["_t"],
        "settled_aborted": settled.get("aborted"),
        "queue_updates": _queue_updates(pi, mark),
        "turn_user_messages": turn_users,
        "pending_after_settle": state.get("pendingMessageCount"),
        "pre_clear_got": pre,
        "sent_during_turn": _user_texts_sent(during),
        "next_turn_request": next_turn["request"],
        "next_turn_settled": next_turn["settled"],
    }


def q13() -> Record:
    """steer 的回应还没回来时 clear_queue 已经写出：三条在同一次写里，或者 steer 先写、隔 0、1、"
    "2、5 毫秒再写
    clear_queue 和 abort，各五遍；每遍都在下一轮之前 clear_queue 一次。"""
    during_tool = [_race(gap, n) for gap in (None, 0.0, 0.001, 0.002, 0.005) for n in range(5)]
    # 模型输出到一半时停止（不在命令执行中）。
    mid_stream = [_race(gap, n, "rpcprobe-midstream") for gap in (None, 0.005) for n in range(5)]
    return {"rounds": during_tool + mid_stream}


def _two_steers(mode: str | None) -> Record:
    """命令执行中连着发两句插话：之后的请求里它们是不是在同一次请求里、各是一条用户消息。"""
    pi = RpcPi(rpc_command(f"q14-{mode or 'default'}"))
    if mode is not None:
        pi.call({"type": "set_steering_mode", "mode": mode})
    state = pi.call({"type": "get_state"}).get("data") or {}
    before = dump_count()
    pi.call({"type": "prompt", "message": script_prompt("rpcprobe-steer")})
    wait_tool_started(pi)
    mark = len(pi.events())
    first = pi.call({"type": "steer", "message": STEER_A})
    second = pi.call({"type": "steer", "message": STEER_B})
    _settled(pi, mark)
    sent = requests_text(dumped_requests(before))
    pi.close()
    return {
        "mode": mode,
        "steering_mode": state.get("steeringMode"),
        "steer_responses": [
            {k: r.get(k) for k in ("success", "data", "error")} for r in (first, second)
        ],
        "queue_updates": _queue_updates(pi, mark),
        "user_messages": _user_messages(pi, mark),
        "requests": sent,
    }


def q14() -> Record:
    """插话设成「一次全送」（set_steering_mode all）时连着发的两句是不是一次送完；"
    "对照 pi 的默认模式。"""
    return {"all": _two_steers("all"), "default": _two_steers(None)}


def q15() -> Record:
    """两句连发（一次全送）：是不是各一条用户消息；两句文字相同时也是。"""
    result = {"different": _two_steers("all")}
    pi = RpcPi(rpc_command("q15-same"))
    pi.call({"type": "set_steering_mode", "mode": "all"})
    before = dump_count()
    pi.call({"type": "prompt", "message": script_prompt("rpcprobe-steer")})
    wait_tool_started(pi)
    mark = len(pi.events())
    pi.call({"type": "steer", "message": STEER_A})
    pi.call({"type": "steer", "message": STEER_A})
    _settled(pi, mark)
    result["same"] = {
        "user_messages": _user_messages(pi, mark),
        "requests": requests_text(dumped_requests(before)),
    }
    pi.close()
    return result


def q16() -> Record:
    """steer 的回应里 disposition 的实际取值：普通的一句（queued），"
    "被扩展的输入处理器吃掉的一句（handled）。"""
    pi = RpcPi(rpc_command("q16", add=("-e", HANDLED_EXTENSION)))
    before = dump_count()
    pi.call({"type": "prompt", "message": script_prompt("rpcprobe-steer")})
    wait_tool_started(pi)
    mark = len(pi.events())
    handled = pi.call({"type": "steer", "message": "AEVAL-HANDLE 这句被扩展处理掉"})
    queued = pi.call({"type": "steer", "message": STEER_B})
    _settled(pi, mark)
    sent = requests_text(dumped_requests(before))
    # 没有一轮在做时的 steer（助手服务不会这样发，记下来对照）。
    idle = pi.call({"type": "steer", "message": "空闲时的插话"})
    pi.close()
    return {
        "handled": {k: handled.get(k) for k in ("success", "data", "error")},
        "queued": {k: queued.get(k) for k in ("success", "data", "error")},
        "idle": {k: idle.get(k) for k in ("success", "data", "error")},
        "queue_updates": _queue_updates(pi, mark),
        "user_messages": _user_messages(pi, mark),
        "sent": _user_texts_sent(sent),
    }


def _compaction_turn(script: str, steer_when: str) -> Record:
    """一轮里压缩上下文：这一轮出现的每条用户消息（message_end，role=user）和压缩的事件，按先后。"""
    pi = RpcPi(rpc_command(f"q17-{script}"))
    pi.call({"type": "set_steering_mode", "mode": "all"})
    before = dump_count()
    prompt = script_prompt(script)
    pi.call({"type": "prompt", "message": prompt})
    if steer_when == "tool":
        wait_tool_started(pi)
    else:
        # 第三次请求（两条命令之后，那一步回复之前等 3 秒）
        pi.wait_for(
            lambda r: (
                r.get("type") == "tool_execution_end"
                and sum(1 for x in pi.events() if x.get("type") == "tool_execution_end") >= 2
            ),
            60,
        )
        time.sleep(1)
    pi.call({"type": "steer", "message": STEER_B})
    _settled(pi, 0, 180)
    kinds = (
        "message_end",
        "compaction_start",
        "compaction_end",
        "auto_retry_start",
        "agent_settled",
    )
    timeline = []
    for r in pi.events():
        if r.get("type") not in kinds:
            continue
        item: Record = {"type": r.get("type")}
        if r.get("type") == "message_end":
            message = r.get("message") or {}
            item["role"] = message.get("role")
            item["text"] = _text(message.get("content"))[:120]
            item["stop_reason"] = message.get("stopReason")
        elif r.get("type") == "compaction_end":
            item["reason"] = r.get("reason")
            item["will_retry"] = r.get("willRetry")
            item["error"] = r.get("errorMessage")
            item["aborted"] = r.get("aborted")
        timeline.append(item)
    sent = requests_text(dumped_requests(before))
    messages = _messages(pi)
    pi.close()
    return {
        "prompt": prompt,
        "steer": STEER_B,
        "timeline": timeline,
        "requests": sent,
        "messages": messages,
    }


def q17() -> Record:
    """一轮里除了这一轮的 prompt，pi 产生的 role=user 的消息是不是都是插话：没有压缩、"
    "中途因为上下文超长压缩
    （压缩之后重试）、这一轮收尾时到了阈值压缩。"""
    return {
        "plain": _compaction_turn("rpcprobe-steer", "tool"),
        "overflow": _compaction_turn("rpcprobe-compact", "tool"),
        "threshold": _compaction_turn("rpcprobe-threshold", "reply"),
    }


QUESTIONS: dict[str, Callable[[], Record]] = {
    "q1": q1,
    "q2": q2,
    "q3": q3,
    "q4": q4,
    "q5": q5,
    "q6": q6,
    "q7": q7,
    "q8": q8,
    "q9": q9,
    "q10": q10,
    "q11": q11,
    "q12": q12,
    "q13": q13,
    "q14": q14,
    "q15": q15,
    "q16": q16,
    "q17": q17,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question", choices=sorted(QUESTIONS))
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    # 每个问题从空的会话目录开始（同一题再跑一遍时不接着上次的会话）。
    shutil.rmtree(SESSIONS, ignore_errors=True)
    for folder in (ROOT, SESSIONS, DUMP):
        folder.mkdir(parents=True, exist_ok=True)
    # 每个问题从干净的设置目录开始：只有模型文件（宿主机放在 <根目录>/models.json）。
    shutil.rmtree(AGENT_DIR, ignore_errors=True)
    AGENT_DIR.mkdir()
    shutil.copy(ROOT / "models.json", AGENT_DIR / "models.json")
    (ROOT / "context.md").write_text("MARK-GIVEN-CONTEXT\n")
    started = time.monotonic()
    try:
        result = {"ok": True, **QUESTIONS[args.question]()}
    except Exception as error:  # 记下来交给宿主机，判成「没跑完」
        result = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    result["seconds"] = round(time.monotonic() - started, 1)
    args.out.write_text(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
