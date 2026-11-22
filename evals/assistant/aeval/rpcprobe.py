"""探针（#539）：助手服务那套启动参数下 pi 的 RPC 模式实际怎么表现。用假的模型端点，不花模型的钱。

`./aeval.sh rpcprobe`：重置环境、在开发环境里准备工具自检的工作区，
起一个单独的探针容器（`sfly-aeval-<槽位>-rpcprobe`，臂 B 的镜像：工作台镜像加远程工具扩展，
每次重建），在里面起假的模型端点，照 `container/rpcprobe_run.py` 逐题做实验；
这里对着它记下的观察下结论，写 `rpcprobe.md` 和 `rpcprobe.json`。

以后升级 pi 时重跑它。
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from aeval import docker as d
from aeval.classify import tool_result_text
from aeval.env import Stack
from aeval.models import FAKE, Model
from aeval.toolcheck import EXPECT_B, ToolCheck

PROBE_DIR = "/opt/aeval-probe"
ROOT = "/root/rpcprobe"
FAKE_PORT = 8101
SCRIPTS = ("rpcprobe_run.py", "fake_model.py", "toolcheck.json")
QUESTIONS = ("q1", "q2", "q3", "q4")

HOLDS = "成立"
FAILS = "不成立"
PARTLY = "部分成立"
UNFINISHED = "没跑完"


_SEVERITY = {HOLDS: 0, PARTLY: 1, FAILS: 2, UNFINISHED: 3}


@dataclass
class Verdict:
    question: str
    title: str
    verdict: str
    facts: list[str] = field(default_factory=list)
    numbers: dict[str, Any] = field(default_factory=dict)

    def worsen(self, verdict: str) -> None:
        """只往更坏的方向改：不成立不会被后面的「部分成立」盖掉。"""
        if _SEVERITY[verdict] > _SEVERITY[self.verdict]:
            self.verdict = verdict

    def as_dict(self) -> dict[str, Any]:
        return {
            "question": self.question,
            "title": self.title,
            "verdict": self.verdict,
            "facts": self.facts,
            "numbers": self.numbers,
        }


# ---- 结论 ----

_FULL_OUTPUT_PATH = re.compile(r"/tmp/pi-bash-[0-9a-f]+\.log")


def tool_results(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """事件流里每个工具结果：工具名、是否报错、文字（截断输出的临时文件名换成固定的写法再比）。"""
    found = []
    for event in events:
        if event.get("type") == "tool_execution_end":
            text = tool_result_text(event.get("result"))
            found.append(
                {
                    "tool": event.get("toolName"),
                    "error": bool(event.get("isError")),
                    "text": _FULL_OUTPUT_PATH.sub("/tmp/pi-bash-<随机>.log", text),
                }
            )
    return found


def prompt_tools(system_prompt: str) -> list[str]:
    """系统提示里 <tools> 一段列出的工具名。"""
    block = re.search(r"<tools>(.*?)</tools>", system_prompt, re.S)
    return re.findall(r"^- (\w+):", block.group(1), re.M) if block else []


def judge_q1(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q1", "RPC 模式下四个工具都落到 Agent 的能力端口", HOLDS)
    steps = json.loads((Path(__file__).parent.parent / "container" / "toolcheck.json").read_text())[
        "steps"
    ]
    a, b = tool_results(raw["json"]), tool_results(raw["rpc"])
    v.numbers = {"steps": len(steps), "json_results": len(a), "rpc_results": len(b)}
    if len(b) != len(steps):
        v.worsen(FAILS)
        v.facts.append(f"RPC 模式只有 {len(b)} 个工具结果，剧本有 {len(steps)} 步")
    differ = [
        steps[i]["id"]
        for i, (x, y) in enumerate(zip(a, b, strict=False))
        if (x["error"], x["text"]) != (y["error"], y["text"])
    ]
    unexpected = []
    for i, step in enumerate(steps):
        expect = EXPECT_B.get(step["id"])
        got = b[i] if i < len(b) else None
        if expect and not (got and got["error"] == expect[0] and expect[1] in got["text"]):
            unexpected.append(step["id"])
    if differ:
        v.worsen(FAILS)
        v.facts.append("和臂 B 的 JSON 模式结果不同的步骤：" + "、".join(differ))
    else:
        v.facts.append(
            f"{len(b)} 步的工具结果和臂 B 的 JSON 模式逐字相同（截断输出的临时文件名除外）"
        )
    if unexpected:
        v.worsen(FAILS)
        v.facts.append("不符合工具自检预期的步骤：" + "、".join(unexpected))
    declared = raw.get("declared_tools", [])
    v.numbers["declared_tools"] = declared
    if sorted(declared) != ["bash", "edit", "read", "write"]:
        v.worsen(FAILS)
        v.facts.append(f"声明给模型的工具是 {declared}")
    else:
        v.facts.append("声明给模型的工具是 read、bash、edit、write")
    if raw.get("written_locally"):
        v.worsen(FAILS)
        v.facts.append("写的文件出现在了探针容器本地")
    else:
        v.facts.append("写的文件落在工作台上，探针容器本地同名目录下没有")
    listed = prompt_tools(raw.get("system_prompt", ""))
    v.numbers["prompt_tools"] = listed
    if sorted(listed) != ["bash", "edit", "read", "write"]:
        v.facts.append(
            f"另外看到：系统提示的工具清单只列了 {'、'.join(listed) or '（没有）'}"
            "（扩展替换的工具没有带上说明；声明给模型的工具定义是全的）"
        )
    return v


def judge_q2(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q2", "--no-extensions -e：只加载给的扩展", HOLDS)
    probe, control = raw["probe"], raw["control"]
    places = {
        "agent_dir": "设置目录的 extensions/",
        "settings": "设置文件里配置的",
        "project": "项目的 .pi/extensions/",
    }
    loaded = [places[k] for k, hit in probe["markers"].items() if hit]
    if loaded or probe["extension_commands"]:
        v.worsen(FAILS)
        v.facts.append(
            "加了 --no-extensions 仍然加载了：" + "、".join(loaded or probe["extension_commands"])
        )
    else:
        v.facts.append("加了 --no-extensions：三处放的扩展都没有加载，也没有内置扩展的命令")
    detected = [places[k] for k, hit in control["markers"].items() if hit]
    v.facts.append(
        "对照（去掉 --no-extensions）：加载了 "
        + ("、".join(detected) or "（没有）")
        + "，内置扩展的命令 "
        + ("、".join(control["extension_commands"]) or "（没有）")
        + "（项目里的扩展要信任项目才加载，对照仍带 --no-approve）"
    )
    if not control["markers"].get("agent_dir"):
        v.worsen(UNFINISHED)
        v.facts.append("对照里设置目录的扩展也没有加载：放的扩展本身没生效，这次的结论不算数")
    if not probe["prompt_ok"]:
        v.worsen(FAILS)
        v.facts.append("只加载给的扩展时提示没有被接受")
    ro = raw.get("read_only_agent_dir")
    if ro is not None:
        v.numbers["read_only_agent_dir_ok"] = ro["prompt_ok"]
        if ro["prompt_ok"]:
            v.facts.append("设置目录归 root、只读，pi 以别的用户运行：照常工作")
        else:
            v.facts.append(
                "设置目录归 root、只读，pi 以别的用户运行：不能用（"
                + _lock_reason(ro["error"])
                + "），pi 要在设置目录里建锁、写凭据和模型缓存"
            )
    return v


def _lock_reason(error: str) -> str:
    """错误里的本机路径换掉，只留原因。"""
    found = re.search(r"(EACCES[^']*)'([^']+)'", error)
    return f"{found.group(1).strip()} {Path(found.group(2)).name}" if found else error[:120]


_MARK = re.compile(r"MARK-[A-Z-]+")
# 探针在每个默认位置放的标记（container/rpcprobe_run.py 的 plant_q3）。
PLACES = {
    "MARK-LOCAL-WS-AGENTS": "工作目录的 AGENTS.md",
    "MARK-LOCAL-PARENT-CLAUDE": "上级目录的 CLAUDE.md",
    "MARK-AGENT-DIR-AGENTS": "设置目录的 AGENTS.md",
    "MARK-AGENT-DIR-APPEND-SYSTEM": "设置目录的 APPEND_SYSTEM.md",
    "MARK-AGENT-DIR-SYSTEM": "设置目录的 SYSTEM.md（替换了整个默认系统提示）",
    "MARK-PROJECT-SYSTEM": "项目的 .pi/SYSTEM.md",
    "MARK-PROJECT-APPEND-SYSTEM": "项目的 .pi/APPEND_SYSTEM.md",
    "MARK-SKILL-AGENT-DIR": "设置目录的 skills/",
    "MARK-SKILL-HOME-AGENTS": "~/.agents/skills/",
    "MARK-SKILL-PROJECT-PI": "项目的 .pi/skills/",
    "MARK-SKILL-PARENT-AGENTS": "上级目录的 .agents/skills/",
    "MARK-SKILL-SETTINGS": "设置文件里配置的 skill",
}


def place(mark: str) -> str:
    return PLACES.get(mark, mark)


GIVEN = {"MARK-GIVEN-CONTEXT", "MARK-SKILL-GIVEN"}
# 远程工具扩展自己从工作台取来加进系统提示的（评测集那份扩展的做法；#540 去掉）。
FROM_EXTENSION = {"AGENTS-MARKER": "工作台上的 AGENTS.md", "<name>demo</name>": "工作台上的 skill"}


def judge_q3(raw: dict[str, Any]) -> Verdict:
    v = Verdict(
        "q3",
        "--no-skills --skill、--no-context-files --append-system-prompt、--no-prompt-templates："
        "系统提示里只有给的东西",
        HOLDS,
    )
    probe, control = raw["probe"], raw["control"]
    seen = set(_MARK.findall(probe["system_prompt"]))
    missing = GIVEN - seen
    extra = sorted(seen - GIVEN)
    templates = [c["name"] for c in probe["commands"] if c["source"] == "prompt"]
    v.numbers = {"extra_markers": extra, "templates": templates}
    if missing:
        v.worsen(FAILS)
        v.facts.append("给的东西不在系统提示里：" + "、".join(sorted(missing)))
    else:
        v.facts.append("给的 skill 和 context.md 在系统提示里")
    if extra:
        v.worsen(PARTLY)
        v.facts.append("系统提示里还有：" + "、".join(place(m) for m in extra))
    if templates:
        v.worsen(PARTLY)
        v.facts.append("还加载了提示模板：" + "、".join(templates))
    if not extra and not templates:
        v.facts.append("各个默认位置放的 AGENTS.md、CLAUDE.md、skill、提示模板都没有进来")
    from_extension = [
        label for mark, label in FROM_EXTENSION.items() if mark in probe["system_prompt"]
    ]
    if from_extension:
        v.facts.append("扩展自己加进来的：" + "、".join(from_extension))
    detected = set(_MARK.findall(control["system_prompt"])) - GIVEN
    control_templates = [c["name"] for c in control["commands"] if c["source"] == "prompt"]
    v.facts.append(
        f"对照（去掉三个 --no-* 开关、加 --approve）：系统提示里多出 {len(detected)} 处"
        f"（{'、'.join(place(m) for m in sorted(detected))}），提示模板 {len(control_templates)} 个"
    )
    if not detected:
        v.worsen(UNFINISHED)
        v.facts.append("对照里也没有多出标记：放的文件本身没被发现，这次的结论不算数")
    return v


def judge_q4(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q4", "--session-dir D --session-id S：第一次新建，第二次恢复", HOLDS)
    first, second, files = raw["first"], raw["second"], raw["files"]
    turns = [m for m in first["messages"] if m["role"] in ("user", "assistant")]
    resumed = [m for m in second["messages_on_start"] if m["role"] in ("user", "assistant")]
    after = [m for m in second["messages_after_third"] if m["role"] in ("user", "assistant")]
    v.numbers = {
        "messages_first": len(turns),
        "messages_on_restart": len(resumed),
        "messages_after_third": len(after),
        "session_files": len(files["after_second"]),
        "exit_seconds": [first["exit_seconds"], second["exit_seconds"]],
    }
    same_file = first["state"]["sessionFile"] == second["state"]["sessionFile"]
    sent = second.get("last_request_users", [])
    if (
        resumed == turns
        and len(after) == len(turns) + 2
        and same_file
        and len(files["after_second"]) == 1
        and sent == ["第一句", "第二句", "第三句"]
    ):
        v.facts.append(
            f"第二次起来时 get_messages 是第一次的 {len(turns)} 条消息，同一个会话文件；"
            "接着说的第三句和回复追加在后面，发给模型的请求里依次是三句话"
        )
    else:
        v.worsen(FAILS)
        v.facts.append(
            f"第一次 {len(turns)} 条，再起时 {len(resumed)} 条；会话文件 {files['after_second']}；"
            f"第三句发给模型的请求里的用户消息 {sent}"
        )
    context = second.get("context_after_restart")
    v.numbers["context_after_restart"] = context
    changed = "两次启动之间换了 --append-system-prompt 的文件："
    v.facts.append(
        {
            "second": changed + "恢复后发给模型的系统提示用的是新文件"
            "（系统提示每次启动重新拼，不用会话文件里存的那份）",
            "first": changed + "恢复后发给模型的仍是第一次的内容（用的是会话文件里存的系统提示）",
        }.get(str(context), f"恢复后的系统提示里两份 context.md 都没有（{context}）")
    )
    v.facts.append(
        "第一次起时 stderr 有一行「No project session found with id …; creating a new session」"
        "的提示，不影响 RPC"
    )
    return v


JUDGES: dict[str, Callable[[dict[str, Any]], Verdict]] = {
    "q1": judge_q1,
    "q2": judge_q2,
    "q3": judge_q3,
    "q4": judge_q4,
}


def judge(question: str, raw: dict[str, Any]) -> Verdict:
    if not raw.get("ok"):
        return Verdict(question, question, UNFINISHED, [str(raw.get("error", "没有输出"))])
    return JUDGES[question](raw)


def render(verdicts: list[Verdict], versions: dict[str, str]) -> str:
    lines = [
        "# rpcprobe",
        "",
        f"pi {versions.get('pi', '?')}，Node {versions.get('node', '?')}，假的模型端点。",
        "",
        "| # | 问题 | 结论 |",
        "|---|---|---|",
    ]
    for v in verdicts:
        lines.append(f"| {v.question[1:]} | {v.title} | {v.verdict} |")
    for v in verdicts:
        lines += ["", f"## {v.question[1:]}. {v.title}：{v.verdict}", ""]
        lines += [f"- {fact}" for fact in v.facts]
    return "\n".join(lines) + "\n"


# ---- 环境 ----


def probe_container(stack: Stack) -> str:
    return stack.name("rpcprobe")


def models_json() -> str:
    spec = {**FAKE, "endpoint": f"http://127.0.0.1:{FAKE_PORT}/v1"}
    return json.dumps(Model("fake", spec).pi_models_json(), ensure_ascii=False)


def prepare(stack: Stack, evals_dir: Path) -> str:
    """重置环境、准备工作区，重建探针容器，放好脚本和模型文件，起假的模型端点。"""
    stack.reset()
    ToolCheck().seed(stack)
    stack.ensure_remote_image()
    container = probe_container(stack)
    stack._run(
        "rpcprobe",
        stack.remote_image,
        ["sleep", "infinity"],
        hostname="rpcprobe",
        extra=["--memory", "2g"],
    )
    d.sh(container, f"mkdir -p {PROBE_DIR} {ROOT} {ToolCheck.workspace}")
    for name in SCRIPTS:
        d.copy_in(str(evals_dir / "container" / name), container, f"{PROBE_DIR}/{name}")
    d.docker(
        "exec", "-i", container, "sh", "-c", f"cat > {ROOT}/models.json", input_text=models_json()
    )
    d.detach(
        container,
        [
            "sh",
            "-c",
            f"exec python3 {PROBE_DIR}/fake_model.py --port {FAKE_PORT} --tasks /nonexistent "
            f"--dump {ROOT}/dump >> {ROOT}/fake.log 2>&1",
        ],
    )
    d.sh(
        container,
        f"for i in $(seq 50); do curl -fsS -o /dev/null http://127.0.0.1:{FAKE_PORT}/v1/models "
        "&& exit 0; sleep 0.2; done; exit 1",
    )
    return container


def run(
    stack: Stack, results: Path, evals_dir: Path, questions: tuple[str, ...] = QUESTIONS
) -> int:
    results.mkdir(parents=True, exist_ok=True)
    container = prepare(stack, evals_dir)
    versions = {
        "pi": d.sh(container, "pi --version", check=False).stdout.strip(),
        "node": d.sh(container, "node --version", check=False).stdout.strip(),
    }
    verdicts = []
    for question in questions:
        out = f"{ROOT}/{question}.json"
        d.sh(
            container,
            f"cd {PROBE_DIR} && python3 rpcprobe_run.py {question} --out {out}",
            timeout=1800,
        )
        raw = json.loads(d.sh(container, f"cat {out}").stdout)
        (results / f"rpcprobe-{question}.json").write_text(json.dumps(raw, ensure_ascii=False))
        verdict = judge(question, raw)
        verdicts.append(verdict)
        print(f"{question}：{verdict.verdict}")
    d.copy_out(container, f"{ROOT}/.", str(results / "rpcprobe-container"), check=False)
    report = render(verdicts, versions)
    (results / "rpcprobe.md").write_text(report)
    (results / "rpcprobe.json").write_text(
        json.dumps(
            {"versions": versions, "verdicts": [v.as_dict() for v in verdicts]},
            ensure_ascii=False,
            indent=2,
        )
    )
    print(report)
    return 0 if all(v.verdict != UNFINISHED for v in verdicts) else 1
