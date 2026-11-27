"""题目「常驻」：要在开发环境上起一个一直运行的服务，在后面的命令里用它（#552 第 4 节）。

初始状态：节点包 svc-stock（`stock_check` 查库存服务，带两条单测和库存服务的本地替身
`svc_stock.stub_service`）。助手要起替身、对它 `sfly debug` 两次，
再写一个自己起替身、用完关掉的集成测试。

量的是「命令退出后它起的后台进程被结束」（ADR 0019，平台臂）的代价：一次工具调用里把替身放到后台、
下一次调试它，平台上连不上。参考答案把起替身和调试写在同一条命令里，平台臂上也能过。

判分：`.sfly/runs/` 里两次调试的输出（替身起着才拿得到这两个数）；在没有替身起着时跑集成测试，
它要通过、结束后替身不在了；节点、替身和原有的单测没有被改。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from aeval.env import Stack
from aeval.tasks import INFO, Check, Task, dev, files_unchanged, init_package, run_own_tests

INTEGRATION_TEST = "tests/test_stock_integration.py"
STUB_MODULE = "svc_stock.stub_service"
ORIGINAL_FILES = ("src/svc_stock/stock.py", "src/svc_stock/stub_service.py", "tests/test_stock.py")
# 替身里写死的库存：调试的输出里有这两个，说明调试时替身起着。
EXPECTED = {
    "A-100": {"sku": "A-100", "quantity": 37, "in_stock": True},
    "B-200": {"sku": "B-200", "quantity": 0, "in_stock": False},
}
# 跑集成测试之前结束开发环境里残留的替身（助手在臂 A 上放到后台的那个可能还在），
# 之后看它是不是又留下了。
STUB_PATTERN = f"python[0-9.]* -m {STUB_MODULE}"


@dataclass
class Observed:
    """判分在开发环境里看到的：调试的输出（`.sfly/runs/*-stock_check/output.json`）、集成测试。"""

    debug_outputs: list[Any]
    test_exists: bool
    test_mentions_stub: bool
    tests_passed: bool
    tests_detail: str
    stub_left_running: bool


def debugged(outputs: list[Any]) -> list[str]:
    """哪些商品有一次成功、输出对得上的调试。"""
    found = []
    for sku, want in EXPECTED.items():
        if any(
            isinstance(o, dict) and o.get("status") == "success" and o.get("outputs") == want
            for o in outputs
        ):
            found.append(sku)
    return found


def checks_from(seen: Observed) -> list[Check]:
    """判分的检查项（只看 `seen`，不碰容器）。"""
    found = debugged(seen.debug_outputs)
    test_ran = seen.test_exists and seen.tests_passed
    return [
        Check(
            "替身起着的时候用 sfly debug 查到了 A-100 和 B-200 的库存",
            found == list(EXPECTED),
            f"成功的调试：{'、'.join(found) or '无'}（共 {len(seen.debug_outputs)} 次调试）",
        ),
        Check(
            f"{INTEGRATION_TEST} 自己起替身，在没有服务起着时通过；节点包的单测全部通过",
            test_ran and seen.test_mentions_stub,
            f"文件{'在' if seen.test_exists else '不在'}，"
            + ("" if seen.test_mentions_stub else f"没有提到 {STUB_MODULE}，")
            + seen.tests_detail,
        ),
        Check(
            "集成测试结束后替身已经关掉",
            test_ran and not seen.stub_left_running,
            "还有替身在运行" if seen.stub_left_running else "",
        ),
    ]


class Daemon(Task):
    id = "daemon"
    files = ("daemon/package", "daemon/reference")
    category = "常驻"
    workspace = "/work/svc-stock"

    def seed(self, stack: Stack) -> None:
        init_package(stack, "svc-stock", [self.data("package")])

    def apply_breakage(self, stack: Stack) -> None:
        self.apply_reference(stack)
        dev(stack, "git rm -q tests/test_stock.py", workdir=self.workspace)

    def observe(self, stack: Stack) -> Observed:
        outputs = dev(
            stack,
            "for f in .sfly/runs/*-stock_check/output.json; do "
            '[ -f "$f" ] && tr -d "\\n" <"$f" && echo; done',
            workdir=self.workspace,
            check=False,
        ).stdout.splitlines()
        exists = dev(stack, f"test -f {INTEGRATION_TEST}", workdir=self.workspace, check=False)
        mentions = dev(
            stack, f"grep -q {STUB_MODULE} {INTEGRATION_TEST}", workdir=self.workspace, check=False
        )
        dev(
            stack,
            f"pkill -f '{STUB_PATTERN}'; for _ in $(seq 50); do "
            f"pgrep -f '{STUB_PATTERN}' >/dev/null || break; sleep 0.2; done",
            check=False,
        )
        tests = run_own_tests(stack, self.workspace)
        left = dev(stack, f"pgrep -f '{STUB_PATTERN}'", check=False)
        return Observed(
            debug_outputs=[_json(line) for line in outputs if line.strip()],
            test_exists=exists.returncode == 0,
            test_mentions_stub=mentions.returncode == 0,
            tests_passed=tests.passed,
            tests_detail=tests.detail,
            stub_left_running=left.returncode == 0,
        )

    def grade(self, stack: Stack) -> list[Check]:
        checks = checks_from(self.observe(stack))
        checks.append(
            files_unchanged(stack, self.workspace, ORIGINAL_FILES, "节点、替身和原有的单测没有被改")
        )
        lint = dev(
            stack,
            "uv run -q ruff check && uv run -q ruff format --check",
            workdir=self.workspace,
            check=False,
        )
        checks.append(Check("ruff 检查通过", lint.returncode == 0, lint.stdout[-500:], INFO))
        return checks


def _json(line: str) -> Any:
    try:
        return json.loads(line)
    except ValueError:
        return None
