"""题目「常驻」：要在开发环境上起一个一直运行的服务，在后面的命令里用它（#552 第 4 节）。

初始状态：节点包 svc-stock（`stock_check` 查库存服务，带两条单测和库存服务的本地替身
`svc_stock.stub_service`）。助手要起替身、对它 `sfly debug` 两次，
再写一个自己起替身、用完关掉的集成测试。

量的是「命令退出后它起的后台进程被结束」（ADR 0019，平台臂）的代价：一次工具调用里把替身放到后台、
下一次调试它，平台上连不上。参考答案把起替身和调试写在同一条命令里，平台臂上也能过。

判分不只看助手写得出来的文件（#821 审查）：
- 调试：`.sfly/runs/` 里的调试运行（输入、输出、开始和结束的时间）要和替身自己的请求记录对得上：
  替身在这次调试运行的时间里真的收到了这个商品的请求。只写一份假的 output.json 不算。
- 集成测试：判分自己单独跑它（会话结束后、没有替身起着、启动标记清掉），要求测试通过、
  测试期间替身真的起来过（替身起来时写启动标记）、结束后替身不在了。
- 节点、替身和原有的单测没有被改。
"""

from __future__ import annotations

import json
import shlex
from dataclasses import dataclass, field
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
# 替身自己的记录（stub_service.py 的 RECORD_DIR）：起来时的启动标记、每次查库存一行。
STUB_RECORDS = "/tmp/svc-stock-stub"
# 跑集成测试之前结束开发环境里残留的替身（助手在臂 A 上放到后台的那个可能还在），
# 之后看它是不是又留下了。
STUB_PATTERN = f"python[0-9.]* -m {STUB_MODULE}"
# 请求的时间和调试运行的时间（文件的修改时间）比较时的余量（秒）：同一台机器上的时钟，
# 留给时间的精度。
SLACK_SECONDS = 1.0

# 在开发环境里读出每次 stock_check 的调试运行：task.json 的输入和修改时间（开始），
# output.json 的内容和修改时间（结束）。
READ_RUNS = """
import glob, json, os
runs = []
for d in sorted(glob.glob(".sfly/runs/*-stock_check")):
    task, out = os.path.join(d, "task.json"), os.path.join(d, "output.json")
    try:
        runs.append({
            "inputs": json.load(open(task)).get("inputs"),
            "started": os.path.getmtime(task),
            "result": json.load(open(out)),
            "finished": os.path.getmtime(out),
        })
    except (OSError, ValueError, AttributeError):
        pass
print(json.dumps(runs))
"""


@dataclass
class Observed:
    """判分在开发环境里看到的。"""

    # 调试运行：{inputs, started, result, finished}（READ_RUNS）。
    debug_runs: list[dict[str, Any]] = field(default_factory=list)
    # 替身的请求记录：{sku, time}。
    stub_requests: list[dict[str, Any]] = field(default_factory=list)
    # 判分自己单独跑的集成测试。
    test_exists: bool = False
    test_passed: bool = False
    test_detail: str = ""
    # 测试期间替身起来过（启动标记）。
    stub_started: bool = False
    stub_left_running: bool = False


def _requested(requests: list[dict[str, Any]], sku: str, start: float, end: float) -> bool:
    return any(
        isinstance(r, dict)
        and r.get("sku") == sku
        and isinstance(r.get("time"), (int, float))
        and start - SLACK_SECONDS <= r["time"] <= end + SLACK_SECONDS
        for r in requests
    )


def debugged(seen: Observed) -> list[str]:
    """哪些商品真的调试过：输入是这个商品、成功、输出对得上，替身在那次调试的时间里收到了它的请求。"""
    found = []
    for sku, want in EXPECTED.items():
        for run in seen.debug_runs:
            inputs, result = run.get("inputs"), run.get("result")
            if not (isinstance(inputs, dict) and isinstance(result, dict)):
                continue
            if (
                inputs.get("sku") == sku
                and result.get("status") == "success"
                and result.get("outputs") == want
                and _requested(seen.stub_requests, sku, run["started"], run["finished"])
            ):
                found.append(sku)
                break
    return found


def checks_from(seen: Observed) -> list[Check]:
    """判分的检查项（只看 `seen`，不碰容器）。"""
    found = debugged(seen)
    test_ran = seen.test_exists and seen.test_passed and seen.stub_started
    return [
        Check(
            "替身起着的时候用 sfly debug 查到了 A-100 和 B-200 的库存（替身收到了这两次请求）",
            found == list(EXPECTED),
            f"对得上的调试：{'、'.join(found) or '无'}（共 {len(seen.debug_runs)} 次调试，"
            f"替身收到 {len(seen.stub_requests)} 次请求）",
        ),
        Check(
            f"{INTEGRATION_TEST} 在没有服务起着时单独跑通过，测试期间自己起了替身",
            test_ran,
            f"文件{'在' if seen.test_exists else '不在'}，"
            f"替身{'起来过' if seen.stub_started else '没有起来过'}，{seen.test_detail}",
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
        runs = dev(
            stack, f"python3 -c {shlex.quote(READ_RUNS)}", workdir=self.workspace, check=False
        )
        requests = dev(stack, f"cat {STUB_RECORDS}/requests.jsonl", check=False)
        seen = Observed(
            debug_runs=_json(runs.stdout.strip()) or [],
            stub_requests=[r for r in map(_json, requests.stdout.splitlines()) if r is not None],
        )
        exists = dev(stack, f"test -f {INTEGRATION_TEST}", workdir=self.workspace, check=False)
        seen.test_exists = exists.returncode == 0
        dev(
            stack,
            f"pkill -f '{STUB_PATTERN}'; for _ in $(seq 50); do "
            f"pgrep -f '{STUB_PATTERN}' >/dev/null || break; sleep 0.2; done; "
            f"rm -f {STUB_RECORDS}/started",
            check=False,
        )
        if seen.test_exists:
            test = dev(
                stack,
                f"uv run -q pytest -q -p no:cacheprovider {INTEGRATION_TEST}",
                workdir=self.workspace,
                check=False,
            )
            seen.test_passed = test.returncode == 0
            seen.test_detail = "\n".join((test.stdout + test.stderr).strip().splitlines()[-10:])
            started = dev(stack, f"test -s {STUB_RECORDS}/started", check=False)
            seen.stub_started = started.returncode == 0
        left = dev(stack, f"pgrep -f '{STUB_PATTERN}'", check=False)
        seen.stub_left_running = left.returncode == 0
        return seen

    def grade(self, stack: Stack) -> list[Check]:
        checks = checks_from(self.observe(stack))
        checks.append(
            files_unchanged(stack, self.workspace, ORIGINAL_FILES, "节点、替身和原有的单测没有被改")
        )
        own = run_own_tests(stack, self.workspace)
        checks.append(Check(own.name, own.passed, own.detail, INFO))
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
