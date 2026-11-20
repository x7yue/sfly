"""题目「编排」：在已有的场景里加一个节点并跑通，不破坏原有的显示名称、备注和注释框。

初始状态：节点包 svc-probe 0.2.0 已发布（等服务就绪、检查商品列表、扫描远端日志），
场景「demo 巡检」锁定 0.2.0、跑在 sut-01 上，有显示名称、备注和一个注释框；
被测机上有一份固定的 /var/log/demo-svc/app.log（240 行，7 行 ERROR）。
新节点要放在 dev-root-dev 上执行，经 Agent 能力从 sut-01 读日志
（真实使用里「从另一台机器取文件」的形态）。
"""

from __future__ import annotations

import copy
import json
import re
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
    run_scenario,
)
from aeval.tasks.fix import DESCRIPTION, keeps_structure

SCENARIO = "demo 巡检"
LOG = "/var/log/demo-svc/app.log"
EXPECTED = {"lines": 240, "matches": 7}


def original_document() -> dict[str, Any]:
    document: dict[str, Any] = copy.deepcopy(load_shared("scenario-demo.json")["document"])
    document["packages"] = {"svc-probe": "0.2.0"}
    return document


def find_new_node(document: dict[str, Any]) -> dict[str, Any] | None:
    for node in document.get("nodes", []):
        if node.get("package") == "svc-probe" and node.get("node") == "scan_remote_log":
            return dict(node)
    return None


class Orchestrate(Task):
    id = "orchestrate"
    # 节点包是「修」的参考答案（修好的 svc-probe）加上读远端日志的节点。
    files = (
        "orchestrate/fixtures/app.log",
        "orchestrate/package",
        "orchestrate/reference",
        "fix/reference",
        "shared/scenario-demo.json",
    )
    category = "编排"
    workspace = "/work/svc-probe"

    def seed(self, stack: Stack) -> None:
        copy_to(stack.sut, self.data("fixtures", "app.log"), LOG)
        init_package(
            stack, "svc-probe", overlays=[self.file("fix/reference"), self.data("package")]
        )
        dev(
            stack,
            'sed -i \'s/^version = "0.1.0"/version = "0.2.0"/\' pyproject.toml && uv sync -q && '
            "git commit -qam 'svc-probe 0.2.0'",
            workdir=self.workspace,
        )
        publish(stack, self.workspace)
        create_scenario(stack, SCENARIO, DESCRIPTION, original_document())

    def apply_breakage(self, stack: Stack) -> None:
        """加好了节点，但把原有的注释框删了。"""
        self.apply_reference(stack)
        edit_scenario(stack, SCENARIO, lambda document: document.update(annotations=[]))

    def grade(self, stack: Stack) -> list[Check]:
        pulled = latest_document(stack, SCENARIO)
        document = pulled["document"]
        node = find_new_node(document)
        checks: list[Check] = []
        inputs = (node or {}).get("inputs", {})
        pattern = str(inputs.get("pattern", "ERROR"))
        right_inputs = (
            node is not None
            and inputs.get("source") == SUT_AGENT
            and inputs.get("path") == LOG
            and bool(re.search(pattern, "2026-11-20T08:00:00Z ERROR GET /items 500"))
            and not re.search(pattern, "2026-11-20T08:00:00Z INFO GET /items 200")
        )
        checks.append(
            Check(
                "加了 scan_remote_log 节点，从 sut-01 读 /var/log/demo-svc/app.log、统计 ERROR",
                right_inputs,
                f"节点：{node}",
            )
        )
        checks.append(
            Check(
                "新节点在 dev-root-dev 上执行",
                node is not None
                and (node.get("agent") or document.get("default_agent")) == DEV_AGENT
                and document.get("default_agent") == SUT_AGENT,
                f"节点的 agent：{(node or {}).get('agent')}，"
                f"默认 Agent：{document.get('default_agent')}",
            )
        )
        edges = {(e["from"], e["to"], e.get("kind")) for e in document.get("edges", [])}
        checks.append(
            Check(
                "新节点接在「检查商品列表」后面",
                node is not None and ("inspect_items", node["id"], "chain") in edges,
                f"连线：{sorted(edges)}",
            )
        )
        checks.append(
            Check(
                "新节点有显示名称",
                bool(node and str(node.get("display_name") or "").strip()),
                str((node or {}).get("display_name")),
            )
        )
        code, run = run_scenario(stack, SCENARIO)
        outputs = node_outputs(run, node["id"]) if (run and node) else None
        got = {k: outputs.get(k) for k in EXPECTED} if outputs else None
        checks.append(
            Check(
                "场景重新运行成功，新节点统计出 240 行、7 行 ERROR",
                code == 0 and got == EXPECTED,
                f"退出码 {code}，输出 {got}",
            )
        )
        problems = keeps_structure(document, original_document(), {"svc-probe": "0.2.0"})
        checks.append(
            Check(
                "原有的节点、输入、显示名称、备注和注释框没有被改",
                not problems,
                "；".join(problems),
                GUARD,
            )
        )
        warnings = document_warnings(stack, SCENARIO)
        checks.append(
            Check(
                "场景文档检查没有警告",
                not warnings,
                json.dumps(warnings, ensure_ascii=False),
                GUARD,
            )
        )
        checks.append(
            Check("新节点写了备注", bool(node and str(node.get("note") or "").strip()), kind=INFO)
        )
        return checks
