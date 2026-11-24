"""工具自检：用假的模型端点照固定剧本（container/toolcheck.json）调用读、写、编辑、命令四个工具，
臂 A（原版 pi，工具在本地执行）和平台臂（平台内的助手，工具经工作台 Agent 的能力端口执行）各跑一遍，
逐步对比工具结果。不花模型的钱。要 `up --assistant`（假的模型端点）。

对比表就是「远程工具和本地工具的语义差别」（docs/ARCHITECTURE.md 讲助手服务的那一节）的实测部分；
每一步还核对平台臂的结果是否符合预期。工作目录是工作区 `/work`：平台的会话就在这个目录下。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from aeval import docker as d
from aeval.classify import read_events, tool_result_text
from aeval.env import Stack
from aeval.models import load_models
from aeval.session import run_session
from aeval.tasks import Check, Task, put_file

WORKSPACE = "/work"
SKILL = """---
name: demo
description: 工具自检用的 skill，确认 skill 来自开发环境。
---

# demo

这份 skill 只在开发环境里。
"""


AGENTS_MD = "# 项目约定\n\n只在开发环境里的上下文文件（AGENTS-MARKER）。\n"


def system_prompt_has(session_dir: Path, text: str) -> bool:
    """pi 的会话文件记着发给模型的系统提示：看里面有没有这段文字。"""
    return any(text in f.read_text() for f in (session_dir / "pi-session").glob("*.jsonl"))


class ToolCheck(Task):
    id = "toolcheck"
    category = "自检"
    workspace = WORKSPACE

    def prompt(self) -> str:
        return "AEVAL-TOOLCHECK：按剧本依次调用工具。"

    def seed(self, stack: Stack) -> None:
        put_file(stack, f"{WORKSPACE}/.agents/skills/demo/SKILL.md", SKILL)
        put_file(stack, f"{WORKSPACE}/AGENTS.md", AGENTS_MD)
        d.sh(
            stack.dev,
            f"cd {WORKSPACE} && git init -q && git add -A "
            "&& git -c user.name=e -c user.email=e@x commit -qm 初始状态",
        )

    def grade(self, stack: Stack) -> list[Check]:
        content = d.sh(stack.dev, f"cat {WORKSPACE}/new/dir/a.txt", check=False).stdout
        return [
            Check("写、编辑之后开发环境里的文件内容对", content == "hello\nremote\n", repr(content))
        ]


def step_results(session_dir: Path) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for event in read_events(session_dir / "events.jsonl"):
        if event.get("type") == "tool_execution_end":
            results.append(
                {"error": bool(event.get("isError")), "text": tool_result_text(event.get("result"))}
            )
    return results


# 平台臂每一步应该得到的结果：（应不应该报错，结果里应该包含的文字）。
EXPECT_P: dict[str, tuple[bool, str]] = {
    "write_new_dir": (False, "Successfully wrote"),
    "read_back": (False, "hello"),
    "edit": (False, "Successfully replaced"),
    "edit_no_match": (True, "Could not find"),
    "bash_cwd_env": (False, "agent=pi nick=eval"),
    "bash_exit_code": (True, "Command exited with code 3"),
    "bash_timeout": (True, "timed out after 1 seconds"),
    "bash_no_timeout": (False, "no-timeout-given"),
    "bash_truncated": (False, "Full output:"),
    "read_full_output": (False, "5000"),
    "read_missing": (True, "ENOENT"),
}

# 系统提示里的东西：臂 A 的 pi 加载工作目录里的 skill 和 AGENTS.md；平台的 pi 只加载平台自带的 skill
# （`--no-skills --skill`）和平台说明（`--no-context-files`），工作台上的 AGENTS.md 由模型自己读。
# 这是有意的差别：两臂各自应当有的，列在对比表里。
PROMPT_EXPECT: list[tuple[str, str, dict[str, bool]]] = [
    ("工作目录里的 skill（demo）", "<name>demo</name>", {"a": True, "p": False}),
    ("工作目录里的 AGENTS.md", "AGENTS-MARKER", {"a": True, "p": False}),
    ("平台自带的 skill", "<name>sfly-", {"a": False, "p": True}),
]
ARMS = ("a", "p")


def _short(text: str) -> str:
    lines = [line for line in text.strip().splitlines() if line.strip()]
    if len(lines) > 3:
        lines = [*lines[:2], "…", lines[-1]]
    return " ⏎ ".join(lines).replace("|", "\\|")[:240]


def run(stack: Stack, results: Path, evals_dir: Path) -> int:
    steps = json.loads((evals_dir / "container" / "toolcheck.json").read_text())["steps"]
    model = load_models()["fake"]
    task = ToolCheck()
    outcome: dict[str, list[dict[str, Any]]] = {}
    for arm in ARMS:
        record = run_session(stack, task, model, results, session_id=f"toolcheck-{arm}", arm=arm)
        outcome[arm] = step_results(results / record["session"])
        verdict = "通过" if record["grade"]["passed"] else "不通过"
        print(f"臂 {arm}：{len(outcome[arm])} 个工具结果，文件内容检查{verdict}")
    rows = [
        "| 步骤 | 工具 | 臂 A（本地） | 平台臂（远程） | 平台臂符合预期 |",
        "|---|---|---|---|---|",
    ]
    failed = 0
    for index, step in enumerate(steps):
        cells = []
        for arm in ARMS:
            got = outcome[arm][index] if index < len(outcome[arm]) else None
            mark = "✗ " if got and got["error"] else ""
            cells.append("（没有结果）" if got is None else f"{mark}{_short(got['text'])}")
        expect = EXPECT_P.get(step["id"])
        got_p = outcome["p"][index] if index < len(outcome["p"]) else None
        if expect is None:
            verdict = "只记录"
        else:
            ok = got_p is not None and got_p["error"] == expect[0] and expect[1] in got_p["text"]
            failed += not ok
            verdict = "是" if ok else "否"
        rows.append(f"| {step['id']} | {step['tool']} | {cells[0]} | {cells[1]} | {verdict} |")
    prompt_rows = ["| 系统提示里有 | 臂 A | 平台臂 | 符合预期 |", "|---|---|---|---|"]
    for label, text, want in PROMPT_EXPECT:
        found = {arm: system_prompt_has(results / f"toolcheck-{arm}", text) for arm in ARMS}
        ok = found == want
        failed += not ok
        prompt_rows.append(
            f"| {label} | {'是' if found['a'] else '否'} | {'是' if found['p'] else '否'} "
            f"| {'是' if ok else '否'} |"
        )
    report = "\n".join([*rows, "", *prompt_rows]) + "\n"
    (results / "toolcheck.md").write_text(report)
    print(report)
    return 1 if failed else 0
