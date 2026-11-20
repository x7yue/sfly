"""题目「跨机器」：写一个经 Agent 能力读另一台机器上日志的节点，加进联调副本并跑通。

初始状态：节点包 svc-probe 0.1.0（没有缺陷的版本）已发布，场景「demo 巡检」和联调副本
「demo 巡检-联调-eval」已建好、`sfly dev` 已加载；被测机上有一份固定的昨天的访问日志。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from aeval.env import DEV_AGENT, SUT_AGENT, Stack
from aeval.tasks import (
    GUARD,
    INFO,
    Check,
    Task,
    copy_to,
    create_scenario,
    dev,
    document_warnings,
    edit_scenario,
    init_package,
    latest_document,
    load_shared,
    node_outputs,
    publish,
    run_hidden_tests,
    run_own_tests,
    run_scenario,
    scenario_versions,
)
from aeval.tasks.fix import COPY, DESCRIPTION, SCENARIO, copy_document, keeps_structure

LOG = "/var/log/demo-svc/access-2026-11-19.log"
EXPECTED = {"total": 300, "status_counts": {"200": 215, "404": 78, "500": 7}, "p95_ms": 95.0}


class Cross(Task):
    id = "cross"
    files = (
        "cross/fixtures/access-2026-11-19.log",
        "cross/hidden/test_hidden.py",
        "cross/reference",
        "fix/reference",
        "shared/scenario-demo.json",
    )
    category = "跨机器"
    workspace = "/work/svc-probe"

    def seed(self, stack: Stack) -> None:
        copy_to(stack.sut, self.data("fixtures", Path(LOG).name), LOG)
        init_package(stack, "svc-probe", overlays=[self.file("fix/reference")])
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

    def apply_breakage(self, stack: Stack) -> None:
        """加好了节点，但改掉了「等服务就绪」的备注。"""
        self.apply_reference(stack)

        def drop_note(document: dict[str, Any]) -> None:
            for node in document["nodes"]:
                if node["id"] == "wait_ready":
                    node["note"] = "等一会儿"

        edit_scenario(stack, COPY, drop_note)

    def grade(self, stack: Stack) -> list[Check]:
        own = dev(
            stack,
            "grep -rl --include='*.py' access_stats tests/",
            workdir=self.workspace,
            check=False,
        )
        tests = run_own_tests(stack, self.workspace)
        checks = [
            Check(
                "给新节点写了单测，节点包的单测全部通过",
                bool(own.stdout.strip()) and tests.passed,
                f"引用 access_stats 的测试：{own.stdout.strip() or '无'}\n{tests.detail}",
            ),
            run_hidden_tests(stack, self.workspace, self.data("hidden", "test_hidden.py")),
        ]
        document = latest_document(stack, COPY)["document"]
        node = next(
            (
                n
                for n in document["nodes"]
                if n.get("package") == "svc-probe" and n.get("node") == "access_stats"
            ),
            None,
        )
        inputs = (node or {}).get("inputs", {})
        edges = {(e["from"], e["to"], e.get("kind")) for e in document.get("edges", [])}
        checks.append(
            Check(
                "联调副本里「检查商品列表」后面加了这一步，在本机 Agent 上读 sut-01 的日志",
                node is not None
                and inputs.get("source") == SUT_AGENT
                and inputs.get("path") == LOG
                and (node.get("agent") or document.get("default_agent")) == DEV_AGENT
                and ("inspect_items", node["id"], "chain") in edges,
                f"节点：{json.dumps(node, ensure_ascii=False)}",
            )
        )
        dev(stack, "uv run -q sfly dev", workdir=self.workspace, check=False)
        code, run = run_scenario(stack, COPY)
        outputs = node_outputs(run, node["id"]) if (run and node) else None
        checks.append(
            Check(
                "联调副本重新运行成功，新节点的输出符合预期",
                code == 0 and outputs == EXPECTED,
                f"退出码 {code}，输出 {outputs}",
            )
        )
        original = copy_document(load_shared("scenario-demo.json")["document"])
        packages = {"svc-probe": "dev"}
        # 题目没要求注释框保持原样：把新节点框进去、相应改标题和备注都可以，只记录。
        problems = keeps_structure(document, original, packages, annotation_text=False)
        checks.append(
            Check(
                "联调副本里原有的节点、输入、显示名称、备注和注释框成员没有被改",
                not problems,
                "；".join(problems),
                GUARD,
            )
        )
        text = keeps_structure(document, original, packages)
        checks.append(Check("注释框的标题和备注也原样保留", not text, "；".join(text), INFO))
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
