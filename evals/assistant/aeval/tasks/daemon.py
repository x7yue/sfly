"""题目「常驻」：要在开发环境上起一个一直运行的服务，在后面的命令里用它（#552 第 4 节）。

初始状态：节点包 svc-stock（`stock_check` 查库存服务，带两条单测和库存服务的本地替身
`svc_stock.stub_service`）。助手要起替身、对它 `sfly debug` 两次，
再写一个自己起替身、用完关掉的集成测试。

量的是「命令退出后它起的后台进程被结束」（ADR 0019，平台臂）的代价：一次工具调用里把替身放到后台、
下一次调试它，平台上连不上。参考答案把起替身和调试写在同一条命令里，平台臂上也能过。

判分：
- 调试：`.sfly/runs/` 里两次调试运行（输入是这个商品、成功、输出对得上，替身起着才拿得到这两个数）。
  这是唯一靠助手留下的记录判的一项：故意伪造运行记录判不出来（已知边界，见 README「判分」）。
- 集成测试：判分自己跑两遍（会话结束后、没有替身起着）。第一遍照常，要通过、结束后替身不在；
  第二遍把替身的入口换成立即退出的，要不通过，跑完换回来。只断言常量或者 mock 的测试两遍都过，不算。
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
STUB_FILE = "src/svc_stock/stub_service.py"
ORIGINAL_FILES = ("src/svc_stock/stock.py", STUB_FILE, "tests/test_stock.py")
# 替身里写死的库存：调试的输出里有这两个，说明调试时替身起着。
EXPECTED = {
    "A-100": {"sku": "A-100", "quantity": 37, "in_stock": True},
    "B-200": {"sku": "B-200", "quantity": 0, "in_stock": False},
}
# 跑集成测试之前结束开发环境里残留的替身（助手在臂 A 上放到后台的那个可能还在），
# 之后看它是不是又留下了。
STUB_PATTERN = f"python[0-9.]* -m {STUB_MODULE}"
# 第二遍：替身的入口换成立即退出（节点包是可编辑安装，改源码就生效）；模块照样能导入。
STUB_ENTRY = 'if __name__ == "__main__":\n    main()\n'
BROKEN_ENTRY = 'if __name__ == "__main__":\n    raise SystemExit("判分：替身起不来")\n'
BACKUP = "/tmp/aeval-stub-service.py"

READ_RUNS = """
import glob, json, os
runs = []
for d in sorted(glob.glob(".sfly/runs/*-stock_check")):
    try:
        runs.append({
            "inputs": json.load(open(os.path.join(d, "task.json"))).get("inputs"),
            "result": json.load(open(os.path.join(d, "output.json"))),
        })
    except (OSError, ValueError, AttributeError):
        pass
print(json.dumps(runs))
"""
BREAK_STUB = f"""
from pathlib import Path
p = Path({STUB_FILE!r})
s = p.read_text()
if s.count({STUB_ENTRY!r}) != 1:
    raise SystemExit("替身的入口不是原来的写法，没法换")
p.write_text(s.replace({STUB_ENTRY!r}, {BROKEN_ENTRY!r}))
"""


@dataclass
class Observed:
    """判分在开发环境里看到的。"""

    # 调试运行：{inputs, result}（READ_RUNS）。
    debug_runs: list[dict[str, Any]] = field(default_factory=list)
    test_exists: bool = False
    # 第一遍：照常跑。
    test_passed: bool = False
    test_detail: str = ""
    stub_left_running: bool = False
    # 第二遍：替身起不来。
    fails_without_stub: bool = False
    without_stub_detail: str = ""


def debugged(seen: Observed) -> list[str]:
    """哪些商品有一次调试运行：输入是这个商品、成功、输出对得上。"""
    found = []
    for sku, want in EXPECTED.items():
        for run in seen.debug_runs:
            inputs, result = run.get("inputs"), run.get("result")
            if (
                isinstance(inputs, dict)
                and isinstance(result, dict)
                and inputs.get("sku") == sku
                and result.get("status") == "success"
                and result.get("outputs") == want
            ):
                found.append(sku)
                break
    return found


def checks_from(seen: Observed) -> list[Check]:
    """判分的检查项（只看 `seen`，不碰容器）。"""
    found = debugged(seen)
    test_ran = seen.test_exists and seen.test_passed and seen.fails_without_stub
    return [
        Check(
            "替身起着的时候用 sfly debug 查到了 A-100 和 B-200 的库存",
            found == list(EXPECTED),
            f"成功的调试：{'、'.join(found) or '无'}（共 {len(seen.debug_runs)} 次调试）",
        ),
        Check(
            f"{INTEGRATION_TEST} 在没有服务起着时通过，替身起不来时不通过",
            test_ran,
            f"文件{'在' if seen.test_exists else '不在'}。照常跑：{seen.test_detail}"
            f"\n替身起不来：{'不通过' if seen.fails_without_stub else '仍然通过'}，"
            f"{seen.without_stub_detail}",
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

    def _stop_stubs(self, stack: Stack) -> None:
        dev(
            stack,
            f"pkill -f '{STUB_PATTERN}'; for _ in $(seq 50); do "
            f"pgrep -f '{STUB_PATTERN}' >/dev/null || break; sleep 0.2; done",
            check=False,
        )

    def _integration_test(self, stack: Stack) -> tuple[bool, str]:
        test = dev(
            stack,
            f"uv run -q pytest -q -p no:cacheprovider {INTEGRATION_TEST}",
            workdir=self.workspace,
            check=False,
        )
        return test.returncode == 0, "\n".join(
            (test.stdout + test.stderr).strip().splitlines()[-10:]
        )

    def observe(self, stack: Stack) -> Observed:
        runs = dev(
            stack, f"python3 -c {shlex.quote(READ_RUNS)}", workdir=self.workspace, check=False
        )
        seen = Observed(debug_runs=_json(runs.stdout.strip()) or [])
        exists = dev(stack, f"test -f {INTEGRATION_TEST}", workdir=self.workspace, check=False)
        seen.test_exists = exists.returncode == 0
        self._stop_stubs(stack)
        if not seen.test_exists:
            return seen
        seen.test_passed, seen.test_detail = self._integration_test(stack)
        left = dev(stack, f"pgrep -f '{STUB_PATTERN}'", check=False)
        seen.stub_left_running = left.returncode == 0
        self._stop_stubs(stack)
        dev(stack, f"cp -p {STUB_FILE} {BACKUP}", workdir=self.workspace)
        broken = dev(
            stack, f"python3 -c {shlex.quote(BREAK_STUB)}", workdir=self.workspace, check=False
        )
        try:
            if broken.returncode != 0:
                seen.without_stub_detail = (broken.stdout + broken.stderr).strip()
            else:
                passed, seen.without_stub_detail = self._integration_test(stack)
                seen.fails_without_stub = not passed
        finally:
            dev(stack, f"mv {BACKUP} {STUB_FILE}", workdir=self.workspace)
        return seen

    def grade(self, stack: Stack) -> list[Check]:
        unchanged = files_unchanged(
            stack, self.workspace, ORIGINAL_FILES, "节点、替身和原有的单测没有被改"
        )
        checks = checks_from(self.observe(stack))
        checks.append(unchanged)
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
