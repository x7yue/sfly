"""题目「修」：给一次失败的运行和一个有缺陷的节点，改到联调运行成功。

初始状态：节点包 svc-probe 0.1.0 已发布，`inspect_items` 有两处缺陷（被测服务把条目放在 `items` 里、
价格是字符串，节点却把响应当成数组、把价格当成数字），而自带的单测用的是错的响应格式，所以单测是通过的。
场景「demo 巡检」用 0.1.0 跑在 sut-01 上；按 skill 的约定建好了联调副本「demo 巡检-联调-eval」
（开发版本、本机 Agent），`sfly dev` 已加载，副本上有一次失败的运行。
"""

from __future__ import annotations

import copy
import json
from typing import Any

from aeval import docker as d
from aeval.env import ASSISTANT_NICKNAME, DEV_AGENT, Stack
from aeval.tasks import (
    GUARD,
    Check,
    Task,
    create_scenario,
    dev,
    document_warnings,
    edit_scenario,
    init_package,
    latest_document,
    load_shared,
    node_outputs,
    original_tests_intact,
    publish,
    run_hidden_tests,
    run_own_tests,
    run_scenario,
    scenario_versions,
)

SCENARIO = "demo 巡检"
COPY = "demo 巡检-联调-eval"
DESCRIPTION = "每天巡检一次 demo 服务：服务能用、商品列表完整。"
# 节点包原有的单测：可以改它们的假响应（本来就和被测服务不一致），不能删掉或跳过。
ORIGINAL_TESTS = ("test_wait_ready", "test_inspect_items", "test_inspect_items_too_few")
EXPECTED = {"item_count": 3, "total_price": 42.5}


def copy_document(original: dict[str, Any]) -> dict[str, Any]:
    document = copy.deepcopy(original)
    document["default_agent"] = DEV_AGENT
    document["packages"] = {"svc-probe": "dev"}
    return document


def keeps_structure(
    document: dict[str, Any],
    original: dict[str, Any],
    packages: dict[str, str],
    *,
    annotation_text: bool = True,
) -> list[str]:
    """原有节点（类型、输入、显示名称、备注）、连线和注释框是否原样保留；返回不一致的地方。

    `annotation_text` 为 False 时只要求注释框还在、原有成员还在，标题和备注可以改：
    skill 允许「改动让所在注释框变得不对时一起改」，题目没要求保持原样时不算破坏。
    """
    problems = []
    nodes = {n["id"]: n for n in document.get("nodes", [])}
    for node in original["nodes"]:
        now = nodes.get(node["id"])
        if now is None:
            problems.append(f"节点 {node['id']} 被删了")
            continue
        for key in ("kind", "package", "node", "inputs", "display_name", "note", "params", "agent"):
            if now.get(key) != node.get(key):
                problems.append(f"节点 {node['id']} 的 {key} 变了：{now.get(key)!r}")
    if document.get("default_agent") != original.get("default_agent"):
        problems.append(f"默认 Agent 变了：{document.get('default_agent')!r}")
    edges = {(e["from"], e["to"], e.get("kind")) for e in document.get("edges", [])}
    for edge in original["edges"]:
        if (edge["from"], edge["to"], edge.get("kind")) not in edges:
            problems.append(f"连线 {edge['from']} → {edge['to']} 没了")
    annotations = {a["id"]: a for a in document.get("annotations", [])}
    for annotation in original.get("annotations", []):
        now = annotations.get(annotation["id"])
        if now is None:
            problems.append(f"注释框 {annotation['title']} 被删了")
            continue
        for key in ("title", "note") if annotation_text else ():
            if now.get(key) != annotation.get(key):
                problems.append(f"注释框 {annotation['title']} 的 {key} 变了")
        if not set(annotation["nodes"]) <= set(now.get("nodes", [])):
            problems.append(f"注释框 {annotation['title']} 少了成员")
    for name, version in packages.items():
        if document.get("packages", {}).get(name) != version:
            problems.append(f"节点包 {name} 锁定的版本不是 {version}")
    return problems


class Fix(Task):
    id = "fix"
    files = (
        "fix/package",
        "fix/hidden/test_hidden.py",
        "fix/reference",
        "shared/scenario-demo.json",
    )
    category = "修"
    workspace = "/work/svc-probe"

    def seed(self, stack: Stack) -> None:
        init_package(stack, "svc-probe", overlays=[self.data("package")])
        publish(stack, self.workspace)
        original = load_shared("scenario-demo.json")["document"]
        create_scenario(stack, SCENARIO, DESCRIPTION, original)
        create_scenario(
            stack,
            COPY,
            f"联调 svc-probe，由 eval 的 AI 编程助手创建\n{DESCRIPTION}",
            copy_document(original),
        )
        dev(stack, "uv run -q sfly dev", workdir=self.workspace)
        # 上一次联调：以 eval 的身份触发，运行失败。
        # 不带 AI_AGENT，和助手在会话里触发的运行区分开。
        d.sh(
            stack.dev,
            f"sfly run start '{COPY}' --wait --timeout 2m",
            env={"SFLY_NICKNAME": ASSISTANT_NICKNAME},
            check=False,
            timeout=300,
        )

    def apply_breakage(self, stack: Stack) -> None:
        """修好了，但把联调副本里「检查商品列表」的门槛降成 0（降低检查标准）。"""
        self.apply_reference(stack)

        def lower_threshold(document: dict[str, Any]) -> None:
            for node in document["nodes"]:
                if node["id"] == "inspect_items":
                    node["inputs"]["min_items"] = 0

        edit_scenario(stack, COPY, lower_threshold)

    def grade(self, stack: Stack) -> list[Check]:
        original = load_shared("scenario-demo.json")["document"]
        checks = [run_hidden_tests(stack, self.workspace, self.data("hidden", "test_hidden.py"))]
        dev(stack, "uv run -q sfly dev", workdir=self.workspace, check=False)
        code, run = run_scenario(stack, COPY)
        outputs = node_outputs(run, "inspect_items") if run else None
        checks.append(
            Check(
                "联调副本重新运行成功，「检查商品列表」的输出符合预期",
                code == 0 and outputs == EXPECTED,
                f"退出码 {code}，输出 {outputs}",
            )
        )
        own = run_own_tests(stack, self.workspace)
        checks.append(Check("节点包的单测仍然全部通过", own.passed, own.detail, GUARD))
        checks.append(original_tests_intact(stack, self.workspace, ORIGINAL_TESTS))
        document = latest_document(stack, COPY)["document"]
        problems = keeps_structure(document, copy_document(original), {"svc-probe": "dev"})
        checks.append(
            Check(
                "联调副本里原有的节点、输入、显示名称、备注和注释框没有被改",
                not problems,
                "；".join(problems),
                GUARD,
            )
        )
        warnings = document_warnings(stack, COPY)
        checks.append(
            Check(
                "联调副本的文档检查没有警告",
                not warnings,
                json.dumps(warnings, ensure_ascii=False),
                GUARD,
            )
        )
        versions = scenario_versions(stack, SCENARIO)
        checks.append(Check("原场景没有被改", len(versions) == 1, f"{len(versions)} 个版本", GUARD))
        return checks
