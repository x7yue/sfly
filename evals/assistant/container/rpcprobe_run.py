"""探针（#539）在探针容器里的那一半：用助手服务的那套启动参数起 pi 的 RPC 模式，照问题做实验，
把看到的原样写成 JSON（不下结论；结论由 aeval/rpcprobe.py 在宿主机上算）。

`python3 rpcprobe_run.py <问题> --out <文件>`，问题是 q1…q4。模型是同一个容器里的假模型端点
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


def plant_q3() -> list[Path]:
    """各个默认位置放上带标记的文件；返回放过的东西（之后删掉）。
    给的东西：--skill 目录里的 given-skill、
    --append-system-prompt 的 context.md。"""
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
    text(AGENT_DIR / "SYSTEM.md", "MARK-AGENT-DIR-SYSTEM\n")
    text(ws / ".pi" / "SYSTEM.md", "MARK-PROJECT-SYSTEM\n")
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
        ("probe", (), ()),
        (
            "control",
            ("--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve"),
            ("--approve",),
        ),
    ):
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
    first = RpcPi(cmd)
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


QUESTIONS: dict[str, Callable[[], Record]] = {"q1": q1, "q2": q2, "q3": q3, "q4": q4}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question", choices=sorted(QUESTIONS))
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
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
