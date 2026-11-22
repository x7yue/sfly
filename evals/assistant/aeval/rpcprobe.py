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
SCRIPTS = (
    "rpcprobe_run.py",
    "fake_model.py",
    "toolcheck.json",
    "rpcprobe-kill.json",
    "rpcprobe-abort.json",
    "rpcprobe-steer.json",
    "rpcprobe-slow-text.json",
)
QUESTIONS = ("q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10")
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
            f"第二次起来时 get_messages 是第一次的 {len(turns)} 条消息，同一个会话文件；"
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
    分不清「已经消失」和「没采到」，不给秒数。"""
    seen = any(stamp <= since and marker in running for stamp, running in samples)
    if not seen:
        return {"seen": False, "gone_seconds": None}
    for stamp, running in samples:
        if stamp >= since and marker not in running:
            return {"seen": True, "gone_seconds": round(stamp - since, 2)}
    return {"seen": True, "gone_seconds": None}


def _workbench_fact(v: Verdict, label: str, watch: dict[str, Any] | None) -> None:
    """工作台上的命令：结束之前在跑、之后不在了才算消失（预期）；一直在是不成立，没采到是没跑完。"""
    if not watch or not watch.get("seen"):
        v.worsen(UNFINISHED)
        v.facts.append(f"{label}：结束之前没采到工作台上的命令，看不出它有没有消失")
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
        v.facts.append("Node 26 的 slim 镜像：没有测")
    elif slim.get("ok"):
        v.facts.append(
            f"Node 26 的 slim 镜像（{slim.get('base')}，只复制 pi 的包和扩展）：能跑，"
            f"pi {slim.get('pi')}、Node {slim.get('node')}，远程工具扩展连上了工作台，"
            f"一轮提示正常结束；镜像 {slim.get('image_mib')} MiB"
        )
    else:
        v.worsen(PARTLY)
        v.facts.append(f"Node 26 的 slim 镜像：没跑通（{slim.get('error', '')[:200]}）")
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


SLIM_BASE = "node:26-trixie-slim"
SLIM_DOCKERFILE = """FROM {remote} AS pi
FROM {base}
COPY --from=pi /usr/local/lib/node_modules/@earendil-works \\
  /usr/local/lib/node_modules/@earendil-works
COPY --from=pi /opt/aeval-remote /opt/aeval-remote
RUN ln -s ../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js /usr/local/bin/pi
"""


def slim_check(stack: Stack) -> dict[str, Any] | None:
    """第 9 题的后一半：pi 和远程工具扩展在 Node 26 的 slim 镜像上能不能跑（只复制 pi 的包和扩展）。
    slim 镜像里没有 python3，用 shell 喂 RPC 命令；模型是探针容器里的假的模型端点。"""
    if not d.exists("image", SLIM_BASE):
        print(f"q9：没有镜像 {SLIM_BASE}，slim 镜像那一半没有测（docker pull 之后再跑）")
        return None
    image = "sfly-aeval-rpcprobe-slim:latest"
    dockerfile = SLIM_DOCKERFILE.format(remote=stack.remote_image, base=SLIM_BASE)
    built = d.docker("build", "-t", image, "-", input_text=dockerfile, check=False, timeout=900)
    if built.returncode != 0:
        return {"ok": False, "error": built.stderr[-400:]}
    name = stack.name("rpcprobe-slim")
    stack._run("rpcprobe-slim", image, ["sleep", "infinity"], extra=["--memory", "1g"])
    try:
        models = json.loads(models_json())
        models["providers"]["aeval"]["baseUrl"] = f"http://{probe_container(stack)}:{FAKE_PORT}/v1"
        d.sh(name, f"mkdir -p /root/agent {ToolCheck.workspace}")
        d.docker(
            "exec", "-i", name, "sh", "-c", "cat > /root/agent/models.json",
            input_text=json.dumps(models),
        )  # fmt: skip
        commands = (
            '{"id":"1","type":"get_state"}\n'
            '{"id":"2","type":"prompt","message":"AEVAL-SCRIPT:rpcprobe-steer 照剧本做。"}\n'
        )
        script = (
            f"cd {ToolCheck.workspace} && (printf '%s' '{commands}'; sleep 15) | "
            "env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root PI_CODING_AGENT_DIR=/root/agent "
            "PI_TELEMETRY=0 AEVAL_AGENT_ADDR=dev:50052 AEVAL_REMOTE_LOG=/root/remote.jsonl "
            "pi --mode rpc --offline --no-extensions -e /opt/aeval-remote/extension.mjs "
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
        tool_ok = any(
            r.get("type") == "tool_execution_end" and not r.get("isError") for r in records
        )
        connected = "connected" in d.sh(name, "cat /root/remote.jsonl", check=False).stdout
        size = d.docker("image", "inspect", "--format", "{{.Size}}", image).stdout.strip()
        ok = bool(state.get("success")) and settled and tool_ok and connected
        return {
            "ok": ok,
            "base": SLIM_BASE,
            "pi": d.sh(name, "pi --version", check=False).stdout.strip(),
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
    container = prepare(stack, evals_dir)
    versions = {
        "pi": d.sh(container, "pi --version", check=False).stdout.strip(),
        "node": d.sh(container, "node --version", check=False).stdout.strip(),
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
