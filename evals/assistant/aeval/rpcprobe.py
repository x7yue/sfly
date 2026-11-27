"""探针（#539）：助手服务那套启动参数下 pi 的 RPC 模式实际怎么表现。用假的模型端点，不花模型的钱。

`./aeval.sh rpcprobe`：重置环境、在开发环境里准备工具自检的工作区，
起一个单独的探针容器（`sfly-aeval-<槽位>-rpcprobe`，工作台镜像，每次重建），放进**产品的远程工具扩展**
（从助手镜像里取 `dist/extension.mjs`，#552 起；以前用的是评测集臂 B 的原型扩展），
在里面起假的模型端点，
照 `container/rpcprobe_run.py` 逐题做实验；这里对着它记下的观察下结论，写 `rpcprobe.md` 和
`rpcprobe.json`。
第 1 题的对照是臂 A（原版 pi，工具在本地执行）在开发环境里跑的同一个工具自检剧本。

以后升级 pi（或者改了产品的扩展）时重跑它：协议里「依赖 pi 的几条是 rpcprobe 测过的」靠它。
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from aeval import docker as d
from aeval.classify import read_events, tool_result_text
from aeval.env import ASSISTANT_NICKNAME, Stack
from aeval.models import FAKE, Model, load_models
from aeval.session import run_session
from aeval.toolcheck import EXPECT_B, ToolCheck

PROBE_DIR = "/opt/aeval-probe"
ROOT = "/root/rpcprobe"
FAKE_PORT = 8101
SCRIPTS = (
    "rpcprobe_run.py",
    "fake_model.py",
    "toolcheck.json",
    "rpcprobe-kill.json",
    "rpcprobe-abort.json",
    "rpcprobe-steer.json",
    "rpcprobe-slow-text.json",
    "rpcprobe-midstream.json",
    "rpcprobe-compact.json",
    "rpcprobe-threshold.json",
    "rpcprobe-handled.ts",
)
QUESTIONS = (
    "q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10",
    "q11", "q12", "q13", "q14", "q15", "q16", "q17",
)  # fmt: skip
# 工作台上要看什么时候消失的命令（剧本里的长命令）：第 5、6、8 题。
WATCHED = ("sleep 601", "sleep 602", "sleep 6; echo")
WATCH_LOG = "/tmp/rpcprobe-watch.log"

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


# 第 1 题里允许和臂 A 不一样的步骤，逐条写死（远程工具适配不了的：命令退出之后，
# 它起的后台进程被结束）。值是预期的样子：（报不报错，输出里要有的字）。
# 臂 A 里进程还在（200），远程里已经没了（curl 连不上，输出 000dead）。
# 别的步骤一律和臂 A 逐字比。
KNOWN_DIFFERENCES: dict[str, tuple[bool, str]] = {
    "bash_background_alive": (False, "dead"),
    "bash_setsid_alive": (False, "dead"),
}
DIFFERENCES_DOC = "evals/assistant/remote-tools/README.md「本地和远程的语义差别」第 12、13 条"


def judge_q1(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q1", "RPC 模式下四个工具都落到 Agent 的能力端口", HOLDS)
    steps = json.loads((Path(__file__).parent.parent / "container" / "toolcheck.json").read_text())[
        "steps"
    ]
    a, b = tool_results(raw["arm_a"]), tool_results(raw["rpc"])
    v.numbers = {"steps": len(steps), "arm_a_results": len(a), "rpc_results": len(b)}
    if len(b) != len(steps):
        v.worsen(FAILS)
        v.facts.append(f"RPC 模式只有 {len(b)} 个工具结果，剧本有 {len(steps)} 步")
    if len(a) != len(steps):
        v.worsen(FAILS)
        v.facts.append(f"臂 A 只有 {len(a)} 个工具结果，剧本有 {len(steps)} 步")
    # 只有 KNOWN_DIFFERENCES 里写死的两步允许和臂 A 不一样，而且要是写明的那个样子；
    # 别的步骤（含工具自检里没有预期的后台进程那几步）一律和臂 A 逐字比。
    pairs = [
        (steps[i]["id"], x, y) for i, (x, y) in enumerate(zip(a, b, strict=False)) if i < len(steps)
    ]
    differ = [
        step_id
        for step_id, x, y in pairs
        if step_id not in KNOWN_DIFFERENCES and (x["error"], x["text"]) != (y["error"], y["text"])
    ]
    known_differ, known_gone, known_unexpected = [], [], []
    for step_id, x, y in pairs:
        if step_id not in KNOWN_DIFFERENCES:
            continue
        if (x["error"], x["text"]) == (y["error"], y["text"]):
            known_gone.append(step_id)
            continue
        failed, word = KNOWN_DIFFERENCES[step_id]
        if y["error"] == failed and word in y["text"]:
            known_differ.append(step_id)
        else:
            known_unexpected.append(
                f"{step_id}（远程：{'报错' if y['error'] else '没报错'}，{y['text'][:60]!r}）"
            )
    unexpected = []
    for i, step in enumerate(steps):
        expect = EXPECT_B.get(step["id"])
        got = b[i] if i < len(b) else None
        if expect and not (got and got["error"] == expect[0] and expect[1] in got["text"]):
            unexpected.append(step["id"])
    known = [s["id"] for s in steps if s["id"] in KNOWN_DIFFERENCES]
    compared = len(steps) - len(known)
    v.numbers["known_differences"] = known_differ
    if differ:
        v.worsen(FAILS)
        v.facts.append("和臂 A（本地执行）结果不同的步骤：" + "、".join(differ))
    else:
        v.facts.append(
            f"除已知差别外的 {compared} 步的工具结果和臂 A（本地执行）"
            f"逐字相同（截断输出的临时文件名除外）"
        )
    if known_differ:
        v.facts.append(
            "和臂 A 不同、是已知差别的步骤（命令退出后它起的后台进程被结束，不报错、输出里有 dead；"
            f"{DIFFERENCES_DOC}）：" + "、".join(known_differ)
        )
    if known_gone:
        v.facts.append(
            "已知差别的步骤这次和臂 A 一样了（后台进程留下来了）："
            + "、".join(known_gone)
            + f"；{DIFFERENCES_DOC}该改了"
        )
    if known_unexpected:
        v.worsen(FAILS)
        v.facts.append(
            "已知差别的步骤不是预期的样子（预期：不报错、输出里有 dead）："
            + "、".join(known_unexpected)
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
                + "），pi 要写设置目录"
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
    default = raw.get("default")
    if default is None:
        v.worsen(UNFINISHED)
        v.facts.append("没有设置目录里不放 SYSTEM.md 的那次运行（助手服务走的路径）")
    else:
        _judge_q3_default(v, default)
    seen = set(_MARK.findall(probe["system_prompt"]))
    missing = GIVEN - seen
    extra = sorted(seen - GIVEN)
    templates = [c["name"] for c in probe["commands"] if c["source"] == "prompt"]
    v.numbers.update({"extra_markers": extra, "templates": templates})
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
        v.facts.append(
            "设置目录里放了 SYSTEM.md 时（系统提示整个被换掉）："
            "各个默认位置放的 AGENTS.md、CLAUDE.md、skill、提示模板都没有进来"
        )
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


def _judge_q3_default(v: Verdict, default: dict[str, Any]) -> None:
    """设置目录里不放 SYSTEM.md（默认系统提示，助手服务走的路径）：除了给的，别的标记都不该进来。"""
    prompt = default["system_prompt"]
    seen = set(_MARK.findall(prompt))
    extra = sorted(seen - GIVEN)
    templates = [c["name"] for c in default["commands"] if c["source"] == "prompt"]
    v.numbers["default_extra_markers"] = extra
    v.numbers["default_templates"] = templates
    if not prompt:
        v.worsen(UNFINISHED)
        v.facts.append("不放 SYSTEM.md 的那次运行没有存下发给模型的请求")
        return
    if GIVEN - seen:
        v.worsen(FAILS)
        v.facts.append(
            "不放 SYSTEM.md 时给的东西不在系统提示里：" + "、".join(sorted(GIVEN - seen))
        )
    if extra or templates:
        v.worsen(FAILS)
        v.facts.append(
            "不放 SYSTEM.md 时（默认系统提示，助手服务走的路径）系统提示里还有："
            + "、".join([place(m) for m in extra] + [f"提示模板 {t}" for t in templates])
        )
    else:
        v.facts.append(
            "不放 SYSTEM.md 时（默认系统提示，助手服务走的路径）：给的 skill 和 context.md 在，"
            "各个默认位置放的 AGENTS.md、CLAUDE.md、skill、提示模板都没有进来"
        )


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
    if not sent:
        v.worsen(UNFINISHED)
        v.facts.append("第三句发给模型的请求没有存下来")
    if (
        resumed == turns
        and len(after) == len(turns) + 2
        and same_file
        and len(files["after_second"]) == 1
        and sent == ["第一句", "第二句", "第三句"]
    ):
        v.facts.append(
            f"第二次起来时 get_messages 里的 user、assistant 是第一次的 {len(turns)} 条"
            "（role=system 的另算，见下），同一个会话文件；"
            "接着说的第三句和回复追加在后面，发给模型的请求里依次是三句话"
        )
    elif sent:
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
    # 每次起 pi，会话里多一条 role=system 的消息（存着系统提示的各段）：
    # 翻译事件、读会话文件的代码要认它。
    systems = [
        sum(m["role"] == "system" for m in first["messages"]),
        sum(m["role"] == "system" for m in second["messages_after_third"]),
    ]
    v.numbers["system_messages"] = systems
    if systems == [1, 2]:
        v.facts.append(
            "每次起 pi，会话里多一条 role=system 的消息：第一次起后 1 条，再起、说完第三句后 2 条"
            f"（get_messages 第一次共 {len(first['messages'])} 条，不只是 user 和 assistant）"
        )
    else:
        v.worsen(PARTLY)
        v.facts.append(
            f"会话里 role=system 的消息：第一次起后 {systems[0]} 条，再起后 {systems[1]} 条"
        )
    stderr = str(first.get("stderr", "")).strip()
    v.facts.append(f"第一次起时 stderr：{stderr[:160]}" if stderr else "第一次起时 stderr 是空的")
    return v


# ---- 第 5 到 10 题 ----


def parse_watch(log: str) -> list[tuple[float, str]]:
    """工作台上每 0.2 秒记一行：时间（秒）和当时在跑的、要看的命令。"""
    samples = []
    for line in log.splitlines():
        stamp, _, rest = line.partition(" ")
        try:
            samples.append((float(stamp), rest))
        except ValueError:
            continue
    return samples


def gone_after(samples: list[tuple[float, str]], marker: str, since: float) -> dict[str, Any]:
    """工作台上的命令 `marker` 在 `since` 之后多久不见了。

    只有 `since` 之前采到过它（命令确实在跑），之后第一个不含它的采样才算「消失」：
    `{"seen": True, "gone_seconds": 秒数}`；一直在时 `gone_seconds` 是 None。
    `since` 之前一次都没采到（模式写错、命令名变了、采样没起来）时是 `{"seen": False}`：
    分不清「已经消失」和「没采到」，不给秒数。`since` 之后一个采样都没有时 `after` 是 False：
    看不出它有没有消失，也不算「一直在」。"""
    seen = any(stamp <= since and marker in running for stamp, running in samples)
    after = any(stamp >= since for stamp, _ in samples)
    if not seen:
        return {"seen": False, "after": after, "gone_seconds": None}
    for stamp, running in samples:
        if stamp >= since and marker not in running:
            return {"seen": True, "after": True, "gone_seconds": round(stamp - since, 2)}
    return {"seen": True, "after": after, "gone_seconds": None}


def _workbench_fact(v: Verdict, label: str, watch: dict[str, Any] | None) -> None:
    """工作台上的命令：结束之前在跑、之后不在了才算消失（预期）；一直在是不成立，没采到是没跑完。"""
    if not watch or not watch.get("seen"):
        v.worsen(UNFINISHED)
        v.facts.append(f"{label}：结束之前没采到工作台上的命令，看不出它有没有消失")
    elif watch.get("gone_seconds") is None and watch.get("after") is False:
        v.worsen(UNFINISHED)
        v.facts.append(f"{label}：结束之后一个采样都没有，看不出工作台上的命令有没有消失")
    elif watch.get("gone_seconds") is None:
        v.worsen(FAILS)
        v.facts.append(f"{label}：工作台上的命令结束之前在跑，之后一直没消失（看到采样结束）")
    else:
        v.facts.append(
            f"{label}：工作台上的命令结束之前在跑，{watch['gone_seconds']} 秒内消失"
            "（采样间隔 0.2 秒）"
        )


def judge_q5(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q5", "工具执行中途被 kill -9，同一条命令再起能不能接着做", HOLDS)
    for variant, label in (
        ("as_killed", "直接再起"),
        ("half_line", "会话文件末尾有写了一半的一行"),
    ):
        x = raw[variant]
        if not x.get("restart_ok") or not x.get("prompt_ok"):
            v.worsen(FAILS)
            v.facts.append(
                f"{label}：再起失败（{x.get('restart_error') or x.get('prompt_error')}）"
            )
            continue
        request = x.get("first_request", [])
        tool_results = [m for m in request if m.get("role") == "tool"]
        filled = [m["text"] for m in tool_results]
        v.numbers[f"{variant}_tool_results"] = filled
        if filled:
            v.facts.append(
                f"{label}：没有报错；再起后会话里是被打断时的样子（最后一条是带工具调用的助手消息，"
                f"没有工具结果）；发「继续」时发给模型的请求里，pi 给那次工具调用补了一个结果"
                f"「{filled[0]}」，后面接「继续」"
            )
        else:
            v.worsen(PARTLY)
            v.facts.append(f"{label}：发给模型的请求里那次工具调用没有结果")
        if x.get("reran_tool"):
            v.facts.append(f"{label}：再起后模型（假的）又发了一次工具调用")
        if x.get("stderr", "").strip():
            v.facts.append(f"{label}：stderr：{x['stderr'].strip()[:160]}")
        watch = x.get("workbench")
        v.numbers[f"{variant}_workbench"] = watch
        _workbench_fact(v, f"{label}，pi 被结束后", watch)
    v.facts.append("「接着做」用真模型试的那一半：欠着（这次只用假的模型端点）")
    return v


def judge_q6(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q6", "abort 要多久，之后还能不能接着发下一轮", HOLDS)
    watch = raw.get("workbench")
    v.numbers = {
        "abort_response_seconds": raw["abort_response_seconds"],
        "settled_seconds": raw["settled_seconds"],
        "workbench": watch,
    }
    v.facts.append(
        f"远程执行 sleep 602 时发 abort：{raw['abort_response_seconds']} 秒收到响应，"
        f"{raw['settled_seconds']} 秒 agent_settled（aborted={raw.get('settled_aborted')}），"
        f"工具结果是「{raw.get('tool_result')}」"
    )
    # 预期：这一轮被中止（agent_settled 的 aborted 为 true，命令的结果是 Command aborted）。
    if raw.get("settled_aborted") is not True or "aborted" not in str(raw.get("tool_result")):
        v.worsen(FAILS)
        v.facts.append("这一轮没有被中止：agent_settled 不是 aborted，或者命令照常跑完了")
    _workbench_fact(v, "abort 之后", watch)
    gone = (watch or {}).get("gone_seconds") or 0
    if max(raw["abort_response_seconds"], raw["settled_seconds"], gone) > 10:
        v.worsen(FAILS)
        v.facts.append("超过 10 秒")
    _judge_after_abort(v, raw.get("next_turn"))
    return v


def _judge_after_abort(v: Verdict, nxt: dict[str, Any] | None) -> None:
    """abort 之后同一个进程再发一轮：发不发得出去，
    发给模型的请求里有没有那条空的 assistant 消息。"""
    if nxt is None:
        v.worsen(UNFINISHED)
        v.facts.append("abort 之后没有再发一轮")
        return
    request = nxt.get("request") or []
    if not request:
        v.worsen(UNFINISHED)
        v.facts.append("abort 之后再发一轮：发给模型的请求没有存下来")
        return
    empty = [
        m
        for m in request
        if m.get("role") == "assistant" and not m.get("text") and not m.get("tool_calls")
    ]
    roles = [m.get("role") for m in request]
    v.numbers["after_abort_request_roles"] = roles
    before = nxt.get("messages_before") or []
    left = bool(before) and before[-1].get("role") == "assistant" and not before[-1].get("text")
    v.numbers["after_abort_session_keeps_empty_assistant"] = left
    if left:
        v.facts.append("abort 之后会话里留下一条内容为空的 assistant 消息（中止的那次回复）")
    if not nxt.get("prompt_ok") or not nxt.get("settled") or nxt.get("error"):
        v.worsen(FAILS)
        v.facts.append(f"abort 之后再发一轮没有做完：{nxt.get('error') or nxt.get('prompt_error')}")
    else:
        v.facts.append("abort 之后同一个进程再发一轮：照常做完")
    if empty:
        # 有的模型端点拒收内容为空的 assistant 消息：发出去了就不能说「abort 之后能照常接着用」。
        v.worsen(PARTLY)
    v.facts.append(
        f"这一轮发给模型的请求里依次是 {roles}；"
        + (
            f"带着 abort 留下的 {len(empty)} 条内容为空的 assistant 消息"
            "（假的模型端点收了；有的模型端点可能拒收，助手服务要按真的端点处理）"
            if empty
            else "没有带 abort 留下的那条空的 assistant 消息"
        )
    )
    v.numbers["after_abort_empty_assistant"] = len(empty)


def _user_texts(request: list[dict[str, Any]]) -> list[str]:
    return [m["text"] for m in request if m.get("role") == "user"]


def judge_q7(raw: dict[str, Any], steer: str = "插话：顺便看一下日志") -> Verdict:
    v = Verdict("q7", "steer 什么时候送到", HOLDS)
    during = raw["during_tool"]
    if not during["requests"] or not raw["text_only"]["requests"]:
        v.worsen(UNFINISHED)
        v.facts.append("发给模型的请求没有存下来")
    second = during["requests"][1] if len(during["requests"]) > 1 else []
    roles = [m.get("role") for m in second]
    if second and roles[-2:] == ["tool", "user"] and second[-1]["text"] == steer:
        v.facts.append(
            "命令执行中插话：命令的结果回来之后、下一次请求模型之前送到；"
            "下一次请求里是工具结果后面接这句插话"
        )
    else:
        v.worsen(FAILS)
        v.facts.append(f"命令执行中插话：下一次请求的最后几条是 {roles[-3:]}")
    updates = [len(u["steering"] or []) for u in during["queue_updates"]]
    v.numbers["queue_updates_during_tool"] = updates
    # 「送出」= steering 变空，并且随后出现了这句插话的用户消息
    # （clear_queue 之后 steering 也会变空）。
    emptied = next((u["t"] for u in during["queue_updates"] if not u["steering"]), None)
    shown = [m for m in during.get("user_messages", []) if m.get("text") == steer]
    delivered = emptied is not None and any(m["t"] >= emptied for m in shown)
    v.numbers["steer_user_message_after_empty"] = delivered
    if updates == [1, 0] and delivered:
        v.facts.append(
            "queue_update：插话时一条（steering 里是这句话），送出去时一条（steering 变空），"
            "随后这句插话作为用户消息出现（message_end，role=user）：两样都看到才算送出"
        )
    else:
        v.worsen(FAILS)
        v.facts.append(
            f"queue_update 的 steering 条数依次是 {updates}；"
            f"steering 变空之后{'出现了' if delivered else '没有出现'}这句插话的用户消息"
        )
    text_only = raw["text_only"]
    asked = [_user_texts(r) for r in text_only["requests"]]
    if len(asked) >= 2 and steer in asked[-1]:
        v.facts.append(
            "最后一次回复不带工具调用时插话：这次回复照常结束，pi 带着插话再请求一次模型"
            "（插话不会丢，也不会等到下一次 prompt）。假的模型端点先等 4 秒才开始输出，"
            "所以测的是模型还没开始输出时插话，不是输出到一半时"
        )
    else:
        v.worsen(PARTLY)
        v.facts.append(f"最后一次回复不带工具调用时插话：各次请求里的用户消息 {asked}")
    clear = raw["clear_then_abort"]
    cleared = (clear.get("clear_queue") or {}).get("steering", [])
    sent_after = any(steer in _user_texts(r) for r in clear["requests"])
    in_session = any(m.get("text") == steer for m in clear.get("messages", []))
    if cleared == [steer] and not sent_after and not in_session:
        v.facts.append(
            "插话之后先 clear_queue 再 abort：clear_queue 的响应里有这句插话，"
            "之后没有发给模型，也不在会话里；"
            "clear_queue 之后也有一条 steering 变空的 queue_update，"
            "所以只看 steering 变空分不清送出和清掉"
        )
    else:
        v.worsen(FAILS)
        v.facts.append(
            f"先 clear_queue 再 abort：清掉的 {cleared}，"
            f"之后发给了模型 {sent_after}，在会话里 {in_session}"
        )
    return v


Q8_VARIANTS = (
    ("mid_turn", "一轮进行中关 stdin"),
    ("mid_turn_sigterm", "一轮进行中关 stdin 同时发 SIGTERM"),
    ("sigterm_only", "一轮进行中只发 SIGTERM（stdin 开着）"),
)


def q8_outcome(x: dict[str, Any]) -> str:
    """一轮进行中被结束时 pi 怎么收场：「中止」（正在跑的命令被中止）、
    「等做完」（命令照常跑完才退出）、
    「看不出来」（会话文件和事件里都没有这次命令的结果）。"""
    # 容器里对会话文件的整行判断（session_tail 截到 300 个字符，长一点就找不到了）；
    # 旧的记录没有这一项时退回看截短的那几行。
    whole = x.get("session_tool_result")
    if whole == "aborted":
        return "中止"
    if whole == "slept":
        return "等做完"
    texts = [x.get("tool_result", ""), *x.get("session_tail", [])]
    if any("Command aborted" in t for t in texts):
        return "中止"
    if any("slept" in t for t in texts):
        return "等做完"
    return "看不出来"


def judge_q8(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q8", "关 stdin、SIGTERM 的收场", HOLDS)
    idle = raw["idle"]
    v.numbers["idle_exit_seconds"] = idle["exit_seconds"]
    v.facts.append(f"空闲时关 stdin：{idle['exit_seconds']} 秒退出，退出码 {idle['exit_code']}")
    for variant, label in Q8_VARIANTS:
        x = raw.get(variant)
        if x is None:
            v.worsen(UNFINISHED)
            v.facts.append(f"{label}：没有跑")
            continue
        outcome = q8_outcome(x)
        v.numbers[f"{variant}_exit_seconds"] = x["exit_seconds"]
        v.numbers[f"{variant}_outcome"] = outcome
        complete = x.get("session_last_line_json")
        v.facts.append(
            f"{label}：{x['exit_seconds']} 秒退出，退出码 {x['exit_code']}；结局：{outcome}"
            + ("（会话文件里记的工具结果是「Command aborted」）" if outcome == "中止" else "")
            + f"；会话文件最后一行{'能' if complete else '不能'}解析成 JSON"
        )
        # 预期：不等这一轮做完，正在跑的命令被中止，10 秒内退出，会话文件完整。
        if outcome == "等做完":
            v.worsen(FAILS)
        elif outcome == "看不出来":
            v.worsen(UNFINISHED)
        if x["exit_seconds"] is None or x["exit_seconds"] > 10:
            v.worsen(FAILS)
        elif x["exit_code"] not in (0, None, -15, 143):
            v.worsen(PARTLY)
        if not complete:
            v.worsen(PARTLY)
        _workbench_fact(v, f"{label}之后", x.get("workbench"))
    return v


def judge_q9(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q9", "内存和启动时间", HOLDS)
    runs = raw["runs"]

    def spread(key: str) -> str:
        values = sorted(r[key] for r in runs)
        return f"{values[0]}–{values[-1]}" if values[0] != values[-1] else str(values[0])

    v.numbers = {
        key: [r[key] for r in runs]
        for key in ("ready_seconds", "idle_rss_mib", "peak_hwm_mib", "after_turn_rss_mib")
    }
    v.facts.append(
        f"带远程工具扩展的 RPC 进程，{len(runs)} 次："
        f"从启动到回应第一条命令 {spread('ready_seconds')} 秒；"
        f"空闲常驻 {spread('idle_rss_mib')} MiB；跑完工具自检的一轮（19 次工具调用）"
        f"峰值（VmHWM）{spread('peak_hwm_mib')} MiB。这是下限：假的模型端点、很短的一轮，"
        "真实会话的上下文长得多"
    )
    slim = raw.get("slim")
    if slim is None:
        v.facts.append("助手镜像（Node 的 slim 镜像）：没有测")
    elif slim.get("ok"):
        v.facts.append(
            f"助手镜像（Node 的 slim 镜像，{slim.get('image') or slim.get('base')}）：能跑，"
            f"pi {slim.get('pi')}、Node {slim.get('node')}，产品的远程工具扩展把命令落到了工作台，"
            f"一轮提示正常结束；镜像 {slim.get('image_mib')} MiB"
        )
    else:
        v.worsen(PARTLY)
        v.facts.append(f"助手镜像（Node 的 slim 镜像）：没跑通（{slim.get('error', '')[:200]}）")
    return v


def judge_q10(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q10", "扩展能不能改系统提示里的工作目录", HOLDS)
    probe = [line for line in raw["probe"]["cwd_lines"] if "<location>" not in line]
    control = [line for line in raw["control"]["cwd_lines"] if "<location>" not in line]
    v.numbers = {"probe": probe, "control": control}
    if any("/work/tc" in line for line in probe) and not any(
        "/srv/assistant" in line for line in probe
    ):
        v.facts.append(
            "pi 在 /srv/assistant 里运行，扩展在 before_agent_start 里把 systemPromptOptions.cwd "
            "改成工作台上的路径：系统提示里写的工作目录就是改后的"
            "（对照：不加扩展时是 /srv/assistant）"
        )
    else:
        v.worsen(FAILS)
        v.facts.append(f"改了之后系统提示里是 {probe}，对照是 {control}")
    v.facts.append(
        "改的只是系统提示里写的工作目录；四个工具在哪个目录下解析路径，"
        "由扩展注册工具时给的 cwd 决定（create*Tool 的第一个参数），这一题没有测"
    )
    return v


# ---- 544-B 先测的七题 ----

STEER_A = "插话一：先别改测试"
STEER_B = "插话二：顺便看一下日志"


def _sent_users(request: list[dict[str, Any]]) -> list[str]:
    return [m["text"] for m in request if m.get("role") == "user"]


def judge_q11(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q11", "模型输出到一半时 abort，之后同一个进程再发一轮", HOLDS)
    v.numbers.update(
        deltas_before_abort=raw["deltas_before_abort"],
        abort_response_seconds=raw["abort_response_seconds"],
        settled_seconds=raw["settled_seconds"],
    )
    aborted = raw.get("aborted_message") or {}
    if raw["deltas_before_abort"] < 1:
        v.worsen(UNFINISHED)
        v.facts.append("abort 之前还没有收到模型的输出：测的不是「输出到一半」")
    if (
        raw["abort_ok"]
        and raw.get("settled_aborted") is True
        and aborted.get("stop_reason") == "aborted"
    ):
        v.facts.append(
            f"收到 {raw['deltas_before_abort']} 段输出之后 abort："
            f"{raw['abort_response_seconds']} 秒回应，"
            f"{raw['settled_seconds']} 秒 agent_settled（aborted），这条助手消息以 aborted 结束，"
            f"留下了 {len(aborted.get('text') or '')} 个字的半截文字"
        )
    else:
        v.worsen(FAILS)
        v.facts.append(
            f"abort 之后：回应 {raw['abort_ok']}，"
            f"agent_settled 的 aborted 是 {raw.get('settled_aborted')}，"
            f"助手消息的结局 {aborted.get('stop_reason')}"
        )
    nxt = raw.get("next_turn") or {}
    request = nxt.get("request") or []
    roles = [m.get("role") for m in request]
    half = [m for m in request if m.get("role") == "assistant" and m.get("text")]
    if nxt.get("prompt_ok") and nxt.get("settled") and nxt.get("stop_reason") == "stop":
        v.facts.append(
            "同一个进程再发一轮（「接着说」）照常做完；发给模型的请求里的角色依次是 "
            f"{roles}，{'带着' if half else '没有'}那条半截的助手消息"
        )
    else:
        v.worsen(FAILS)
        v.facts.append(
            f"再发一轮：接受 {nxt.get('prompt_ok')}（{nxt.get('prompt_error')}），"
            f"做完 {nxt.get('settled')}，"
            f"结局 {nxt.get('stop_reason')}（{nxt.get('error')}）"
        )
    if request and request[-1].get("role") != "user":
        v.worsen(FAILS)
        v.facts.append(f"再发一轮的请求最后一条不是用户消息：{roles}")
    return v


def judge_q12(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q12", "abort 紧跟在 clear_queue 后面写出，没有插话漏出去", HOLDS)
    leaks = []
    for n, r in enumerate(raw["rounds"]):
        steering = (r.get("clear_queue") or {}).get("steering") or []
        texts = [STEER_A] if len(steering) <= 1 else [STEER_A, STEER_B]
        leaked = [
            t
            for t in (STEER_A, STEER_B)
            if t in r["sent_during_turn"]
            or t in _sent_users(r["next_turn_request"])
            or any(m.get("text") == t for m in r["user_messages"])
            or any(m.get("text") == t for m in r["messages_after"])
        ]
        if leaked or steering != texts or not r["clear_before_abort"] or not r["abort_ok"]:
            where = "模型输出到一半，" if r.get("script") == "rpcprobe-midstream" else ""
            leaks.append(
                f"第 {n + 1} 遍（{where}"
                f"{'同一次写' if r['together'] else '接连两次写'}）：clear_queue 取回 {steering}，"
                f"漏出去的 {leaked}，clear_queue 先回应 {r['clear_before_abort']}"
            )
    v.numbers["rounds"] = len(raw["rounds"])
    if leaks:
        v.worsen(FAILS)
        v.facts += leaks
    else:
        v.facts.append(
            f"{len(raw['rounds'])} 遍（一句和两句插话；命令执行中十遍，"
            "clear_queue 和 abort 在同一次写里、接连两次写各一半；"
            "模型输出到一半时两遍）："
            "clear_queue 都取回了全部插话、先于 abort 回应；之后这一轮没有再请求模型带上它们，"
            "会话里没有它们，同一个进程的下一轮的请求里也没有"
        )
    return v


def q13_fate(r: dict[str, Any]) -> str:
    """这句插话最后去了哪里：
    「这一轮里送到」（停下之前成了这一轮的一条用户消息，没有再请求模型）、
    「清掉」（clear_queue 取回了）、
    「留在队列里」（停下之后还在 pi 的队列里，下一轮之前的 clear_queue 取回）、「漏」（别的，
    例如停下之后才成了用户消息、
    这一轮又请求了模型、下一轮带着它却不在会话里）。"""
    caught = STEER_B in ((r.get("clear_queue") or {}).get("steering") or [])
    shown = [m for m in r["turn_user_messages"] if m.get("text") == STEER_B]
    before_settle = [m for m in shown if m["t"] <= r["settled_t"]]
    pre_got = STEER_B in ((r.get("pre_clear_got") or {}).get("steering") or [])
    next_has = STEER_B in _sent_users(r["next_turn_request"])
    asked_in_turn = STEER_B in r["sent_during_turn"]
    if caught and not shown and not next_has:
        return "清掉"
    if before_settle and len(shown) == 1 and not asked_in_turn and not pre_got:
        return "这一轮里送到"
    if not shown and pre_got and not next_has and not asked_in_turn:
        return "留在队列里"
    return "漏"


def judge_q13(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q13", "steer 的回应回来之前 clear_queue 已经写出：这句话去了哪里", HOLDS)
    counts: dict[str, dict[str, int]] = {}
    for n, r in enumerate(raw["rounds"]):
        fate = q13_fate(r)
        label = "同一次写" if r["gap"] is None else f"隔 {round(r['gap'] * 1000)} 毫秒"
        if r.get("script") == "rpcprobe-midstream":
            label = f"模型输出到一半、{label}"
        else:
            label = f"命令执行中、{label}"
        counts.setdefault(label, {}).setdefault(fate, 0)
        counts[label][fate] += 1
        if fate == "漏":
            v.worsen(FAILS)
            v.facts.append(
                f"第 {n + 1} 遍（{label}）漏了：回应的先后 {r['order']}，"
                f"clear_queue 取回 {r['clear_queue']}，"
                f"这一轮的用户消息 {r['turn_user_messages']}（agent_settled 在 {r['settled_t']}），"
                f"下一轮之前取回 {r['pre_clear_got']}，"
                f"下一轮的请求里的用户消息 {_sent_users(r['next_turn_request'])}"
            )
    v.numbers["fates"] = counts
    v.facts.insert(
        0,
        "每种写法各五遍，这句话的去处："
        + "；".join(f"{label} {fates}" for label, fates in counts.items())
        + "。「这一轮里送到」：abort 收尾时 pi 把队列里的插话放进了对话（一条用户消息，"
        "在 agent_settled 之前），"
        "没有再请求模型，下一轮的请求里它是历史的一部分；按「出现用户消息就算送到」记，"
        "和会话里一致",
    )
    return v


def _two_in_one(run: dict[str, Any], first: str, second: str) -> tuple[bool, list[list[str]]]:
    """两句插话是不是在同一次请求里、紧挨着、各是一条用户消息。"""
    together = any(
        [(m.get("role"), m.get("text")) for m in r[-2:]] == [("user", first), ("user", second)]
        for r in run["requests"]
    )
    return together, [_sent_users(r)[1:] for r in run["requests"]]


def judge_q14(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q14", "插话设成一次全送：连着发的几句一次送完", HOLDS)
    all_mode = raw["all"]
    together, users = _two_in_one(all_mode, STEER_A, STEER_B)
    v.numbers["steering_mode"] = all_mode.get("steering_mode")
    if all_mode.get("steering_mode") == "all" and together:
        v.facts.append(
            "set_steering_mode all 之后，命令执行中连着发的两句在命令的结果之后的同一次请求里送到"
        )
    else:
        v.worsen(FAILS)
        v.facts.append(
            f"一次全送：模式 {all_mode.get('steering_mode')}，"
            f"各次请求里第一条之后的用户消息 {users}"
        )
    default = raw["default"]
    d_together, d_users = _two_in_one(default, STEER_A, STEER_B)
    v.facts.append(
        f"对照 pi 的默认模式（{default.get('steering_mode')}）："
        f"两句{'也在同一次请求里' if d_together else '分在两次请求里'}"
        f"（各次请求里第一条之后的用户消息 {d_users}）"
    )
    return v


def judge_q15(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q15", "两句连发是不是各一条用户消息", HOLDS)
    for key, texts in (("different", [STEER_A, STEER_B]), ("same", [STEER_A, STEER_A])):
        run = raw[key]
        shown = [m.get("text") for m in run["user_messages"]]
        together, _ = _two_in_one(run, *texts)
        label = "两句不同" if key == "different" else "两句相同"
        if shown == texts and together:
            v.facts.append(
                f"{label}：事件里各一条用户消息（message_end，role=user），请求里也是两条"
            )
        else:
            v.worsen(FAILS)
            v.facts.append(f"{label}：事件里的用户消息 {shown}，请求里紧挨着两条 {together}")
    return v


def judge_q16(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q16", "steer 的回应里 disposition 的实际表现（handled）", HOLDS)
    handled = (raw["handled"].get("data") or {}).get("disposition")
    queued = (raw["queued"].get("data") or {}).get("disposition")
    idle = raw["idle"]
    v.numbers.update(handled=handled, queued=queued)
    seen = (
        any("AEVAL-HANDLE" in s for u in raw["queue_updates"] for s in (u.get("steering") or []))
        or any("AEVAL-HANDLE" in (m.get("text") or "") for m in raw["user_messages"])
        or any("AEVAL-HANDLE" in t for t in raw["sent"])
    )
    if handled == "handled" and not seen:
        v.facts.append(
            "被扩展的输入处理器吃掉的一句：回应成功、disposition 是 handled；"
            "没有进队列（queue_update 里没有）、"
            "没有用户消息、没有送到模型"
        )
    else:
        v.worsen(FAILS)
        v.facts.append(
            f"被吃掉的一句：disposition {handled}，在队列、用户消息或请求里出现过 {seen}"
        )
    if queued == "queued" and STEER_B in raw["sent"]:
        v.facts.append("普通的一句：disposition 是 queued，之后送到了模型")
    else:
        v.worsen(FAILS)
        v.facts.append(f"普通的一句：disposition {queued}，送到模型 {STEER_B in raw['sent']}")
    v.facts.append(
        f"对照：没有一轮在做时 steer 的回应 {idle.get('success')}、"
        f"{idle.get('data') or idle.get('error')}"
    )
    return v


def judge_q17(raw: dict[str, Any]) -> Verdict:
    v = Verdict("q17", "一轮里除了这一轮的 prompt，role=user 的消息都是插话（含压缩上下文）", HOLDS)
    labels = {
        "plain": "没有压缩",
        "overflow": "中途上下文超长、压缩之后重试",
        "threshold": "收尾时到了阈值压缩",
    }
    for key, label in labels.items():
        run = raw[key]
        users = [
            e["text"] for e in run["timeline"] if e["type"] == "message_end" and e["role"] == "user"
        ]
        compactions = [e for e in run["timeline"] if e["type"] == "compaction_end"]
        others = users[1:]
        if key != "plain" and not any(
            c.get("error") is None and not c.get("aborted") for c in compactions
        ):
            v.worsen(UNFINISHED)
            v.facts.append(f"{label}：没有压缩成（compaction_end {compactions}）")
            continue
        if users and users[0] == run["prompt"] and others == [run["steer"]]:
            v.facts.append(
                f"{label}：这一轮的用户消息依次是这一轮的 prompt 和那句插话，没有别的"
                + (f"（压缩 {[c.get('reason') for c in compactions]}）" if compactions else "")
            )
        else:
            v.worsen(FAILS)
            v.facts.append(f"{label}：用户消息依次是 {users}")
    return v


JUDGES: dict[str, Callable[[dict[str, Any]], Verdict]] = {
    "q1": judge_q1,
    "q2": judge_q2,
    "q3": judge_q3,
    "q4": judge_q4,
    "q5": judge_q5,
    "q6": judge_q6,
    "q7": judge_q7,
    "q8": judge_q8,
    "q9": judge_q9,
    "q10": judge_q10,
    "q11": judge_q11,
    "q12": judge_q12,
    "q13": judge_q13,
    "q14": judge_q14,
    "q15": judge_q15,
    "q16": judge_q16,
    "q17": judge_q17,
}


def judge(question: str, raw: dict[str, Any]) -> Verdict:
    if not raw.get("ok"):
        return Verdict(question, question, UNFINISHED, [str(raw.get("error", "没有输出"))])
    return JUDGES[question](raw)


def short_id(image_id: str) -> str:
    return image_id.removeprefix("sha256:")[:12]


def version_warnings(versions: dict[str, str]) -> list[str]:
    """量的是不是产品里的那一份：探针里跑的 pi 是工作台镜像里的，产品跑的是助手镜像里的，
    两边分别固定。"""
    if "assistant_image" not in versions:
        return []
    probe_pi, product_pi = versions.get("pi", "?"), versions.get("assistant_pi", "?")
    if product_pi == "?":
        return ["没有读到助手镜像里 pi 的版本：不知道探针量的 pi 和产品跑的是不是同一版"]
    if probe_pi != product_pi:
        return [
            f"探针里跑的是工作台镜像里的 pi {probe_pi}，产品跑的是助手镜像里的 pi {product_pi}，"
            "版本不一样：除第 9 题 slim 镜像那一半（用的就是助手镜像里的 pi）以外，"
            f"结论量的是 pi {probe_pi} 的行为，不是产品的；把两边升到同一版之后重跑"
        ]
    return []


def render(verdicts: list[Verdict], versions: dict[str, str]) -> str:
    lines = [
        "# rpcprobe",
        "",
        f"pi {versions.get('pi', '?')}，Node {versions.get('node', '?')}，假的模型端点。",
    ]
    if "assistant_image" in versions:
        lines += [
            "",
            f"产品的远程工具扩展取自助手镜像 {versions['assistant_image']}"
            f"（ID {short_id(versions.get('assistant_image_id', '?'))}，"
            f"构建于 {versions.get('assistant_image_created', '?')}），"
            f"`extension.mjs` 的 sha256 是 {versions.get('extension_sha256', '?')}；"
            f"助手镜像里的 pi 是 {versions.get('assistant_pi', '?')}。",
        ]
    for warning in version_warnings(versions):
        lines += ["", f"**提醒：** {warning}"]
    lines += [
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


# 交给产品的远程工具扩展的这一轮的配置（apps/assistant/src/turn-config.ts 的 TurnConfig；
# container/rpcprobe_run.py 的 turn_config() 读的就是写进探针容器的这一份）：
# 工作台是开发环境里的 Agent。
TURN_CONFIG = {
    "address": "dev:50052",
    "workdir": ToolCheck.workspace,
    "env": {"SFLY_NICKNAME": ASSISTANT_NICKNAME, "AI_AGENT": "pi"},
    "defaultTimeoutSeconds": 1200,
    "secrets": [],
}

# 产品的远程工具扩展在助手镜像里的位置，和放进探针容器的位置（container/rpcprobe_run.py 的
# EXTENSION）。
PRODUCT_EXTENSION = "/app/dist/extension.mjs"
PROBE_EXTENSION = "/opt/aeval-product/extension.mjs"
# 助手镜像里 pi 的包（产品起的 pi 是它，不是工作台镜像里的 `pi`）。
ASSISTANT_PI_PACKAGE = "/app/node_modules/@earendil-works/pi-coding-agent/package.json"


def assistant_image_choice(stack: Stack, explicit: str | None) -> str | None:
    """探针从哪个助手镜像取产品的扩展：明确给的；没给时是这个槽位的助手容器用的（`make_stack` 已经
    照它接着用）。两样都没有时是 None：**不退到默认标签**，默认标签可能是几天前构建的旧镜像，
    量到的是旧扩展，结论照出。"""
    if explicit:
        return explicit
    return stack.assistant_image if stack.assistant else None


def copy_product_extension(stack: Stack, container: str, workdir: Path) -> dict[str, str]:
    """从助手镜像里取产品的远程工具扩展，放进探针容器（不起助手容器：建一个不运行的容器、复制出来、删掉）。
    返回这次量的是哪一份：镜像的名字、ID、构建时间、扩展文件的 sha256、助手镜像里 pi 的版本。"""
    if not d.exists("image", stack.assistant_image):
        raise d.DockerError(
            f"没有助手镜像 {stack.assistant_image}：探针用产品的远程工具扩展，先从源码构建助手镜像"
            "（README.md「平台的助手」），或用 --assistant-image 指定"
        )
    holder = stack.name("rpcprobe-extension")
    d.docker("rm", "-f", holder, check=False)
    d.docker("create", "--name", holder, stack.assistant_image)
    try:
        d.docker("cp", f"{holder}:{PRODUCT_EXTENSION}", str(workdir / "extension.mjs"))
        d.docker(
            "cp", f"{holder}:{ASSISTANT_PI_PACKAGE}", str(workdir / "assistant-pi-package.json")
        )
    finally:
        d.docker("rm", "-f", holder, check=False)
    d.sh(container, f"mkdir -p {Path(PROBE_EXTENSION).parent}")
    d.copy_in(str(workdir / "extension.mjs"), container, PROBE_EXTENSION)
    info = d.docker(
        "image", "inspect", "--format", "{{.Id}}\t{{.Created}}", stack.assistant_image
    ).stdout.strip()
    image_id, _, created = info.partition("\t")
    return {
        "assistant_image": stack.assistant_image,
        "assistant_image_id": image_id,
        "assistant_image_created": created,
        "extension_sha256": hashlib.sha256((workdir / "extension.mjs").read_bytes()).hexdigest(),
        "assistant_pi": str(
            json.loads((workdir / "assistant-pi-package.json").read_text()).get("version", "?")
        ),
    }


def arm_a_toolcheck(stack: Stack, results: Path) -> list[dict[str, Any]]:
    """第 1 题的对照：臂 A（原版 pi，工具在本地执行）在开发环境里跑工具自检的剧本，
    返回它的工具结果事件。"""
    record = run_session(
        stack, ToolCheck(), load_models()["fake"], results, session_id="rpcprobe-arm-a", arm="a"
    )
    events = read_events(results / record["session"] / "events.jsonl")
    return [e for e in events if e.get("type") == "tool_execution_end"]


def prepare(stack: Stack, evals_dir: Path, results: Path) -> tuple[str, dict[str, str]]:
    """重置环境、准备工作区，重建探针容器，放好脚本、模型文件和产品的远程工具扩展，起假的模型端点。
    返回探针容器的名字和这次用的产品扩展的出处（`copy_product_extension`）。"""
    stack.reset()
    ToolCheck().seed(stack)
    container = probe_container(stack)
    stack._run(
        "rpcprobe",
        stack.workbench_image,
        ["sleep", "infinity"],
        hostname="rpcprobe",
        extra=["--memory", "2g"],
    )
    d.sh(container, f"mkdir -p {PROBE_DIR} {ROOT} {ToolCheck.workspace}")
    product = copy_product_extension(stack, container, results)
    for name in SCRIPTS:
        d.copy_in(str(evals_dir / "container" / name), container, f"{PROBE_DIR}/{name}")
    d.docker(
        "exec", "-i", container, "sh", "-c", f"cat > {ROOT}/models.json", input_text=models_json()
    )
    d.docker(
        "exec", "-i", container, "sh", "-c", f"cat > {ROOT}/turn.json",
        input_text=json.dumps(TURN_CONFIG),
    )  # fmt: skip
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
    return container, product


# 工作台上的采样：每 0.2 秒一行「时间 正在跑的剧本命令|…」。
WATCH_SCRIPT = (
    "while :; do "
    f"echo \"$(date +%s.%N) $(ps -eo args= | grep -E 'sleep 60[12]|sleep 6; echo' "
    f"| grep -v grep | tr '\\n' '|')\" >> {WATCH_LOG}; "
    "sleep 0.2; done"
)


def start_watch(stack: Stack) -> None:
    """在工作台上起采样（第 5、6、8 题看剧本命令什么时候消失）。"""
    stop_watch(stack)
    d.sh(stack.dev, f"rm -f {WATCH_LOG}")
    d.detach(stack.dev, ["sh", "-c", WATCH_SCRIPT])


def stop_watch(stack: Stack) -> None:
    d.sh(stack.dev, "pkill -f '[r]pcprobe-watch.log' || true", check=False)


def attach_watch(question: str, raw: dict[str, Any], samples: list[tuple[float, str]]) -> None:
    """把「工作台上的命令多久之后消失」写进这题的观察里。"""
    if question == "q5":
        for variant in ("as_killed", "half_line"):
            x = raw[variant]
            x["workbench"] = gone_after(samples, "sleep 601", x["killed_at"])
    elif question == "q6":
        raw["workbench"] = gone_after(samples, "sleep 602", raw["abort_sent_at"])
    elif question == "q8":
        for variant, _ in Q8_VARIANTS:
            if variant in raw:
                x = raw[variant]
                x["workbench"] = gone_after(samples, "sleep 6; echo", x["closed_at"])


# 助手镜像里的 pi：容器里没有 `pi` 命令，助手服务用 node 直接跑它（apps/assistant/src/main.ts）。
ASSISTANT_PI = "node /app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"


def slim_check(stack: Stack) -> dict[str, Any] | None:
    """第 9 题的后一半：pi 和产品的远程工具扩展在助手镜像（Node 的 slim 镜像，只有助手服务、
    pi 和扩展）上
    能不能跑。镜像里没有 python3，用 shell 喂 RPC 命令；模型是探针容器里的假的模型端点；
    扩展的配置照产品。"""
    if not d.exists("image", stack.assistant_image):
        print(f"q9：没有助手镜像 {stack.assistant_image}，slim 镜像那一半没有测")
        return None
    name = stack.name("rpcprobe-slim")
    stack._run(
        "rpcprobe-slim",
        stack.assistant_image,
        ["sleep", "infinity"],
        extra=["--memory", "1g", "--user", "root", "--entrypoint", ""],
    )
    try:
        models = json.loads(models_json())
        models["providers"]["aeval"]["baseUrl"] = f"http://{probe_container(stack)}:{FAKE_PORT}/v1"
        config = TURN_CONFIG
        d.sh(name, f"mkdir -p /root/agent {ToolCheck.workspace}")
        for path, content in (("/root/agent/models.json", models), ("/root/turn.json", config)):
            d.docker(
                "exec", "-i", name, "sh", "-c", f"cat > {path}", input_text=json.dumps(content)
            )
        commands = (
            '{"id":"1","type":"get_state"}\n'
            '{"id":"2","type":"prompt","message":"AEVAL-SCRIPT:rpcprobe-steer 照剧本做。"}\n'
        )
        script = (
            f"cd {ToolCheck.workspace} && (printf '%s' '{commands}'; sleep 15) | "
            "env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root PI_CODING_AGENT_DIR=/root/agent "
            "PI_TELEMETRY=0 SFLY_ASSISTANT_TURN_CONFIG=/root/turn.json "
            f"{ASSISTANT_PI} --mode rpc --offline --no-extensions -e {PRODUCT_EXTENSION} "
            "--no-session --provider aeval --model fake 2>/root/stderr.log"
        )
        out = d.sh(name, script, check=False, timeout=120).stdout
        records = []
        for line in out.splitlines():
            try:
                records.append(json.loads(line))
            except ValueError:
                continue
        state: dict[str, Any] = next((r for r in records if r.get("id") == "1"), {})
        settled = any(r.get("type") == "agent_settled" for r in records)
        # 工具结果没有报错：命令经扩展落到了开发环境的能力端口上。
        tool_ok = any(
            r.get("type") == "tool_execution_end" and not r.get("isError") for r in records
        )
        size = d.docker(
            "image", "inspect", "--format", "{{.Size}}", stack.assistant_image
        ).stdout.strip()
        ok = bool(state.get("success")) and settled and tool_ok
        return {
            "ok": ok,
            "image": stack.assistant_image,
            "pi": d.sh(name, f"{ASSISTANT_PI} --version", check=False).stdout.strip(),
            "node": d.sh(name, "node --version", check=False).stdout.strip(),
            "image_mib": round(int(size) / 1024 / 1024) if size.isdigit() else None,
            **(
                {}
                if ok
                else {"error": d.sh(name, "tail -c 400 /root/stderr.log", check=False).stdout}
            ),
        }
    finally:
        d.docker("rm", "-f", name, check=False)


def run(
    stack: Stack, results: Path, evals_dir: Path, questions: tuple[str, ...] = QUESTIONS
) -> int:
    results.mkdir(parents=True, exist_ok=True)
    # 第 1 题的对照先跑（它自己重置环境）：臂 A 在开发环境里跑同一个工具自检的剧本。
    arm_a = arm_a_toolcheck(stack, results) if "q1" in questions else []
    container, product = prepare(stack, evals_dir, results)
    versions = {
        "pi": d.sh(container, "pi --version", check=False).stdout.strip(),
        "node": d.sh(container, "node --version", check=False).stdout.strip(),
        **product,
    }
    verdicts = []
    start_watch(stack)
    for question in questions:
        out = f"{ROOT}/{question}.json"
        d.sh(
            container,
            f"cd {PROBE_DIR} && python3 rpcprobe_run.py {question} --out {out}",
            timeout=1800,
        )
        raw = json.loads(d.sh(container, f"cat {out}").stdout)
        if question == "q1":
            raw["arm_a"] = arm_a
        if raw.get("ok"):
            watch_log = d.sh(stack.dev, f"cat {WATCH_LOG}").stdout
            # 原始采样也进结果目录：「x 秒内消失」能复核。
            (results / "rpcprobe-watch.log").write_text(watch_log)
            attach_watch(question, raw, parse_watch(watch_log))
            if question == "q9":
                raw["slim"] = slim_check(stack)
        (results / f"rpcprobe-{question}.json").write_text(json.dumps(raw, ensure_ascii=False))
        verdict = judge(question, raw)
        verdicts.append(verdict)
        print(f"{question}：{verdict.verdict}")
    stop_watch(stack)
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
