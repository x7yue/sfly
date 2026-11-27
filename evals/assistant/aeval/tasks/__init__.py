"""题目。每道题是一个 `Task`：固定的初始状态（`seed`）、给助手的一句话（`tasks/<id>/prompt.md`）、
参考答案（`apply_reference`）和判分（`grade`）。
题目的文件（节点包、日志、看不到的断言）在 `tasks/<id>/` 下。

判分只看结果，不看助手自己怎么说。检查分三类：
- `goal`：题目要求的结果。什么都不做时它们都不通过；
- `guard`：不许破坏的东西（原有的节点、显示名称、备注、注释框、单测）。
  什么都不做时通过，破坏了就整题零分；
- `info`：只记录、不计分（例如是否按 skill 写了说明、是否自己跑过 `sfly debug`）。

得分：任何一项 `guard` 不通过为 0，否则是通过的 `goal` 占全部 `goal` 的比例；
全部通过才算这道题通过。
"""

from __future__ import annotations

import json
import shlex
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from aeval import docker as d
from aeval.env import ASSISTANT_NICKNAME, EVALS_DIR, Stack

GOAL, GUARD, INFO = "goal", "guard", "info"


@dataclass
class Check:
    name: str
    passed: bool
    detail: str = ""
    kind: str = GOAL


def summarize(checks: list[Check]) -> dict[str, Any]:
    goals = [c for c in checks if c.kind == GOAL]
    guards = [c for c in checks if c.kind == GUARD]
    broken = any(not c.passed for c in guards)
    passed_goals = sum(c.passed for c in goals)
    score = 0.0 if broken or not goals else passed_goals / len(goals)
    return {
        "passed": bool(goals) and not broken and passed_goals == len(goals),
        "score": round(score, 4),
        "checks": [asdict(c) for c in checks],
    }


TASKS_DIR = EVALS_DIR / "tasks"


class UndeclaredFile(LookupError):
    pass


class Task:
    id = ""
    # 题目的类别：写、修、编排、跨机器、长日志。
    category = ""
    # 助手的工作目录（开发环境容器里的节点包目录）。
    workspace = ""
    # 这道题用到的文件和目录（相对 tasks/）。只能用这里列出的：单测检查它们都被 git 跟踪，
    # 免得像 *.log 这样被 .gitignore 挡掉、干净的检出里题目起不来。
    files: tuple[str, ...] = ()

    def prompt(self) -> str:
        return self.file(f"{self.id}/prompt.md").read_text().strip()

    def file(self, relative: str) -> Path:
        """题目文件在宿主机上的路径。要用时复制进容器（`copy_to`）：评测目录不挂进容器，
        免得助手读到参考答案和看不到的断言。"""
        declared = (*self.files, f"{self.id}/prompt.md")
        if not any(relative == f or relative.startswith(f"{f}/") for f in declared):
            raise UndeclaredFile(f"题目 {self.id} 用到的 {relative} 没有列在 files 里")
        return TASKS_DIR / relative

    def data(self, *parts: str) -> Path:
        """这道题自己目录下的文件。"""
        return self.file("/".join([self.id, *parts]))

    def seed(self, stack: Stack) -> None:
        raise NotImplementedError

    def apply_reference(self, stack: Stack) -> None:
        """参考答案是 `tasks/<id>/reference/solve.sh`，像助手一样在节点包目录里执行。

        假的模型端点（离线验证流程用）回放的也是它。
        """
        stage_reference(stack, self)
        d.sh(
            stack.dev,
            f"bash {REFERENCE_DIR}/solve.sh",
            workdir=self.workspace,
            env={"SFLY_NICKNAME": ASSISTANT_NICKNAME, "AI_AGENT": "pi"},
            timeout=900,
        )

    def grade(self, stack: Stack) -> list[Check]:
        raise NotImplementedError

    def apply_breakage(self, stack: Stack) -> None:
        """「做完了但破坏了原有内容」的答案：参考答案之后再改坏一处原有的东西。
        判分自检用它确认「不许破坏」的检查能判出来（应该是 0 分）。"""
        raise NotImplementedError


# ---- 题目共用的步骤 ----

# 参考答案在开发环境容器里的位置：只在应用参考答案、或用假的模型端点验证流程时才复制进去。
REFERENCE_DIR = "/tmp/aeval-reference"


def copy_to(container: str, source: Path, dest: str) -> None:
    """把宿主机上的文件或目录（目录复制其内容）复制到容器里的 dest。"""
    d.sh(container, f"rm -rf {shlex.quote(dest)} && mkdir -p {shlex.quote(str(Path(dest).parent))}")
    d.copy_in(f"{source}/." if source.is_dir() else str(source), container, dest)


def stage_reference(stack: Stack, task: Task) -> None:
    copy_to(stack.dev, task.data("reference"), REFERENCE_DIR)


def dev(stack: Stack, script: str, *, workdir: str | None = None, check: bool = True) -> Any:
    return d.sh(stack.dev, script, workdir=workdir, check=check, timeout=900)


def init_package(stack: Stack, name: str, overlays: list[Path] | None = None) -> str:
    """按用户文档 `sfly init` 一个节点包，依次叠上题目准备的源码（每个目录下的 src/ 和 tests/，
    后面的覆盖前面的同名文件），`uv sync` 后提交成初始状态。"""
    workspace = f"/work/{name}"
    script = [
        "git config --global user.name eval && git config --global user.email eval@example.invalid",
        "git config --global init.defaultBranch main",
        f"mkdir -p /work && cd /work && sfly init {shlex.quote(name)}",
        f"cd {shlex.quote(workspace)}",
    ]
    for index, overlay in enumerate(overlays or []):
        staged = f"/tmp/aeval-overlay-{index}"
        copy_to(stack.dev, overlay, staged)
        for part in ("src", "tests"):
            if (overlay / part).is_dir():
                script.append(f"cp -r {staged}/{part}/. {part}/")
        script.append(f"rm -rf {staged}")
    script += [
        "uv sync -q",
        "git init -q 2>/dev/null || true",
        "git add -A && git commit -qm 初始状态",
    ]
    dev(stack, " && ".join(script))
    return workspace


def sfly_json(stack: Stack, *args: str, workdir: str | None = None) -> Any:
    out = stack.sfly(*args, "--json", workdir=workdir)
    return json.loads(out.stdout)


def run_hidden_tests(stack: Stack, workspace: str, test_file: Path) -> Check:
    """在节点包的 venv 里跑题目里看不到的断言（会话结束后才复制进容器）。"""
    copy_to(stack.dev, test_file, f"/tmp/aeval-hidden/{test_file.name}")
    result = dev(
        stack,
        f"AEVAL_PROJECT={shlex.quote(workspace)} uv run -q pytest -q -p no:cacheprovider "
        "--rootdir /tmp/aeval-hidden /tmp/aeval-hidden",
        workdir=workspace,
        check=False,
    )
    tail = "\n".join((result.stdout + result.stderr).strip().splitlines()[-20:])
    return Check("题目里看不到的断言", result.returncode == 0, tail)


def run_own_tests(stack: Stack, workspace: str) -> Check:
    result = dev(stack, "uv run -q pytest -q -p no:cacheprovider", workdir=workspace, check=False)
    tail = "\n".join((result.stdout + result.stderr).strip().splitlines()[-10:])
    return Check("节点包自己的单测通过", result.returncode == 0, tail)


def latest_document(stack: Stack, scenario: str) -> dict[str, Any]:
    pulled = dev(
        stack,
        f"sfly scenario pull {shlex.quote(scenario)} -o /tmp/aeval-pull.json >/dev/null "
        "&& cat /tmp/aeval-pull.json",
    )
    data: dict[str, Any] = json.loads(pulled.stdout)
    return data


def run_scenario(
    stack: Stack, scenario: str, timeout: str = "3m"
) -> tuple[int, dict[str, Any] | None]:
    """以评分的身份触发一次运行并等它结束，返回退出码和运行详情（`GET /runs/<id>`）。"""
    started = d.sh(
        stack.dev,
        f"sfly run start {shlex.quote(scenario)} --wait --timeout {timeout} --json",
        env={"SFLY_NICKNAME": "grader"},
        check=False,
        timeout=900,
    )
    try:
        summary = json.loads(started.stdout)
    except ValueError:
        return started.returncode, None
    run_id = summary.get("id") or summary.get("run_id")
    if not run_id:
        return started.returncode, None
    detail = sfly_json(stack, "api", "GET", f"/runs/{run_id}")
    return started.returncode, detail


def node_outputs(run: dict[str, Any], node_id: str) -> dict[str, Any] | None:
    """运行详情里主链上某个节点（最后一次尝试）的输出。

    输出被运行视图省略（单个超过 16 KiB，或整份视图内联的合计用完，#633）时不能悄悄返回 None：
    明确报错，评分用的输出要取全文（`sfly run show <运行> --outputs --json`，
    或 `GET /tasks/<任务>/io`）。"""
    for chain in run.get("chains", []):
        for task in chain.get("tasks", chain.get("nodes", [])):
            if task.get("node_id") == node_id and task.get("status") == "success":
                omitted = task.get("outputs_omitted_bytes")
                if omitted is not None:
                    raise RuntimeError(
                        f"节点 {node_id} 的输出没有随运行详情一起返回（约 {omitted} 字节）："
                        "取全文用 sfly run show <运行> --outputs --json，或 GET /tasks/<任务>/io"
                    )
                outputs = task.get("outputs")
                return outputs if isinstance(outputs, dict) else None
    return None


def put_file(stack: Stack, path: str, content: str) -> None:
    d.docker(
        "exec",
        "-i",
        stack.dev,
        "sh",
        "-c",
        f'mkdir -p "$(dirname {shlex.quote(path)})" && cat > {shlex.quote(path)}',
        input_text=content,
    )


def load_shared(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((TASKS_DIR / "shared" / name).read_text())
    return data


def create_scenario(stack: Stack, name: str, description: str, document: dict[str, Any]) -> None:
    put_file(
        stack, "/tmp/aeval-scenario.json", json.dumps({"document": document}, ensure_ascii=False)
    )
    stack.sfly(
        "scenario",
        "create",
        "--name",
        name,
        "--description",
        description,
        "--from",
        "/tmp/aeval-scenario.json",
    )


def publish(stack: Stack, workspace: str) -> None:
    dev(stack, "uv run -q sfly publish", workdir=workspace)


def scenario_versions(stack: Stack, scenario: str) -> list[dict[str, Any]]:
    data = sfly_json(stack, "scenario", "versions", scenario)
    return data if isinstance(data, list) else []


def document_warnings(stack: Stack, scenario: str) -> list[dict[str, Any]]:
    """场景最新版本的文档检查警告（注释框引用了不存在的成员、必填参数缺失……）。

    警告只在保存版本时给出，所以复制一份场景、把同样的文档再保存一次来拿，不碰原场景。
    """
    probe = f"{scenario}-判分检查"
    stack.sfly("scenario", "copy", scenario, "--name", probe)
    dev(stack, f"sfly scenario pull {shlex.quote(probe)} -o /tmp/aeval-warn.json >/dev/null")
    data = sfly_json(stack, "scenario", "push", "/tmp/aeval-warn.json")
    stack.sfly("api", "POST", f"/orchestrations/{_scenario_id(stack, probe)}/archive")
    # 直接取键：push --json 哪天不再带 warnings 时这里报错，而不是让这条检查永远通过。
    warnings = data["warnings"]
    if not isinstance(warnings, list):
        raise TypeError(f"scenario push --json 的 warnings 不是列表：{warnings!r}")
    return warnings


def _scenario_id(stack: Stack, name: str) -> str:
    for item in sfly_json(stack, "scenario", "list", "--search", name):
        if item.get("name") == name:
            return str(item["id"])
    raise LookupError(f"找不到场景 {name}")


def original_tests_intact(stack: Stack, workspace: str, names: tuple[str, ...]) -> Check:
    """原有的单测还在、没有被跳过：「单测全部通过」不能靠删掉或跳过测试过关。"""
    missing = []
    for name in names:
        found = dev(
            stack,
            f"grep -rlq --include='*.py' 'def {name}(' tests/",
            workdir=workspace,
            check=False,
        )
        if found.returncode != 0:
            missing.append(name)
    skipped = dev(
        stack,
        "grep -rn --include='*.py' -E "
        "'pytest\\.mark\\.(skip|skipif|xfail)|pytest\\.skip\\(' tests/",
        workdir=workspace,
        check=False,
    ).stdout.strip()
    detail = "；".join(filter(None, [f"不见了：{'、'.join(missing)}" if missing else "", skipped]))
    return Check("原有的单测都还在、没有被跳过", not missing and not skipped, detail, GUARD)


def files_unchanged(stack: Stack, workspace: str, paths: tuple[str, ...], name: str) -> Check:
    changed = dev(
        stack, "git diff --name-only HEAD -- " + " ".join(paths), workdir=workspace, check=False
    ).stdout.strip()
    return Check(name, not changed, changed, GUARD)


def edit_scenario(stack: Stack, scenario: str, change: Callable[[dict[str, Any]], None]) -> None:
    """pull 一个场景、改它的文档、push（以助手的身份），给判分自检造「改坏了」的答案用。"""
    pulled = latest_document(stack, scenario)
    change(pulled["document"])
    put_file(stack, "/tmp/aeval-edit.json", json.dumps(pulled, ensure_ascii=False))
    d.sh(
        stack.dev,
        "sfly scenario push /tmp/aeval-edit.json",
        env={"SFLY_NICKNAME": ASSISTANT_NICKNAME, "AI_AGENT": "pi"},
    )
