"""题目「写」：按一段需求写一个节点和它的单测，`sfly debug` 跑通。

初始状态：刚 `sfly init` 的节点包 svc-logs（只有示例节点），开发环境容器里有 /fixtures/app.log。
"""

from __future__ import annotations

import json
import shlex

from aeval.env import Stack
from aeval.tasks import (
    INFO,
    Check,
    Task,
    copy_to,
    dev,
    files_unchanged,
    init_package,
    run_hidden_tests,
    run_own_tests,
)

# sfly init 生成的示例节点和单测：题目没让动它们。
EXAMPLE_FILES = ("src/svc_logs/example.py", "tests/test_example.py")
EXPECTED = {"total": 61, "counts": {"INFO": 40, "WARN": 9, "ERROR": 7}, "error_ratio": 0.1148}


def parse_debug_output(stdout: str) -> object:
    """`sfly debug` 的标准输出：「输出：」后面是缩进的 JSON，直到「指标：」或「运行目录：」。"""
    lines = stdout.splitlines()
    if "输出：" not in lines:
        return None
    start = lines.index("输出：") + 1
    body: list[str] = []
    for line in lines[start:]:
        if line.startswith(("指标：", "运行目录：", "产物（")):
            break
        body.append(line)
    try:
        return json.loads("\n".join(body))
    except ValueError:
        return None


class Write(Task):
    id = "write"
    files = ("write/fixtures/app.log", "write/hidden/test_hidden.py", "write/reference")
    category = "写"
    workspace = "/work/svc-logs"

    def seed(self, stack: Stack) -> None:
        copy_to(stack.dev, self.data("fixtures", "app.log"), "/fixtures/app.log")
        init_package(stack, "svc-logs")

    def apply_breakage(self, stack: Stack) -> None:
        self.apply_reference(stack)
        dev(stack, "git rm -q tests/test_example.py", workdir=self.workspace)

    def grade(self, stack: Stack) -> list[Check]:
        # 先看助手自己有没有跑过 sfly debug（下面判分自己也要跑一次）。
        ran = dev(
            stack,
            "ls -d .sfly/runs/*-level_counts 2>/dev/null | wc -l",
            workdir=self.workspace,
            check=False,
        )
        ran_by_assistant = int(ran.stdout.strip() or 0) > 0
        own = dev(
            stack,
            "grep -rl --include='*.py' level_counts tests/",
            workdir=self.workspace,
            check=False,
        )
        tests = run_own_tests(stack, self.workspace)
        checks = [
            Check(
                "给新节点写了单测，节点包的单测全部通过",
                bool(own.stdout.strip()) and tests.passed,
                f"引用 level_counts 的测试：{own.stdout.strip() or '无'}\n{tests.detail}",
            )
        ]
        checks.append(
            run_hidden_tests(stack, self.workspace, self.data("hidden", "test_hidden.py"))
        )
        params = json.dumps({"path": "/fixtures/app.log"})
        debug = dev(
            stack,
            f"uv run -q sfly debug level_counts --params {shlex.quote(params)}",
            workdir=self.workspace,
            check=False,
        )
        output = parse_debug_output(debug.stdout)
        checks.append(
            Check(
                "sfly debug 对 /fixtures/app.log 的输出符合预期",
                debug.returncode == 0 and output == EXPECTED,
                f"退出码 {debug.returncode}，输出 {json.dumps(output, ensure_ascii=False)}",
            )
        )
        checks.append(
            files_unchanged(
                stack,
                self.workspace,
                EXAMPLE_FILES,
                "原有的示例节点和它的单测没有被改",
            )
        )
        checks.append(Check("助手自己用 sfly debug 跑过这个节点", ran_by_assistant, kind=INFO))
        lint = dev(
            stack,
            "uv run -q ruff check && uv run -q ruff format --check",
            workdir=self.workspace,
            check=False,
        )
        checks.append(Check("ruff 检查通过", lint.returncode == 0, lint.stdout[-500:], INFO))
        return checks
