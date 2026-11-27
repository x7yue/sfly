"""命令行入口：`./aeval.sh <命令>`，见 README.md。"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import date, datetime
from pathlib import Path

from aeval import bgcheck, e2e, probe, rpcprobe, toolcheck, transcript
from aeval import docker as d
from aeval.env import (
    DATA_HOME,
    DEFAULT_ASSISTANT_IMAGE,
    DEFAULT_SERVER_IMAGE,
    DEFAULT_WORKBENCH_IMAGE,
    EVALS_DIR,
    OPT,
    Stack,
)
from aeval.models import Model, load_models
from aeval.offline import pack
from aeval.report import arm_of, load_records, render
from aeval.session import ARMS, EndpointDown, prepare_pi, run_session, versions
from aeval.tasks import summarize
from aeval.tasks.registry import TASKS


def _stack(args: argparse.Namespace) -> Stack:
    # 只有 up（和 pack）指定镜像；之后的命令（run、seed、reset……）重建控制面和工作台时
    # 沿用这个槽位起好的容器用的镜像，没有起过时用默认镜像。
    slot = Stack(slot=args.slot)
    server_image = getattr(args, "server_image", None) or image_in_use(slot.name("cp"))
    workbench_image = getattr(args, "workbench_image", None) or image_in_use(slot.name("dev"))
    stack = Stack(
        slot=args.slot,
        server_image=server_image or DEFAULT_SERVER_IMAGE,
        workbench_image=workbench_image or DEFAULT_WORKBENCH_IMAGE,
        mirror_mode="serve" if getattr(args, "offline", False) else "record",
        internal=getattr(args, "isolated", False),
        fake_model=getattr(args, "fake_model", False),
    )
    if args.command != "up" and stack.network_internal():
        # `up --isolated` 起的槽位：之后的命令（reset、toolcheck、rpcprobe……）照网络的实际情况，
        # 不然重建控制面时会在断网的网络上发布端口。
        stack.internal = True
    if getattr(args, "cache", None):
        stack.cache_dir = args.cache.resolve()
    if getattr(args, "pypi_mirror", None):
        stack.pypi_mirror = args.pypi_mirror
    if getattr(args, "github_mirror", None):
        stack.github_mirror = args.github_mirror
    if args.command == "up":
        stack.assistant = getattr(args, "assistant", False)
        stack.assistant_image = getattr(args, "assistant_image", None) or stack.assistant_image
        stack.assistant_model = getattr(args, "assistant_model", None) or stack.assistant_model
    else:
        # up --assistant 起的槽位：之后的命令（reset、seed、e2e……）重建控制面和助手时沿用它的设置。
        stack.adopt_assistant()
    return stack


def image_in_use(container: str) -> str | None:
    """容器用的镜像；容器不存在时 None。"""
    found = d.docker("inspect", "-f", "{{.Config.Image}}", container, check=False)
    if found.returncode != 0:
        return None
    return found.stdout.strip() or None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aeval.sh", description="sfly 助手评测集")
    parser.add_argument("--slot", type=int, default=1, help="环境槽位，同时跑会话时用不同的槽位")
    sub = parser.add_subparsers(dest="command", required=True)
    up = sub.add_parser("up", help="起一套环境")
    up.add_argument("--server-image", default=DEFAULT_SERVER_IMAGE)
    up.add_argument("--workbench-image", default=DEFAULT_WORKBENCH_IMAGE)
    up.add_argument("--offline", action="store_true", help="镜像站只用缓存，不向上游取（离线环境）")
    up.add_argument(
        "--isolated",
        action="store_true",
        help="容器网络不通外网和宿主机（验证离线包），同时起假的模型端点",
    )
    up.add_argument("--fake-model", action="store_true", help="起假的模型端点（只验证流程）")
    up.add_argument(
        "--cache", type=Path, help="镜像站的缓存目录，默认 ~/.local/share/sfly/evals/mirror-cache"
    )
    up.add_argument("--pypi-mirror", help="用已有的 PyPI 镜像（例如内网的），不用自带的镜像站")
    up.add_argument("--github-mirror", help="用已有的 GitHub Release 镜像，不用自带的镜像站")
    up.add_argument(
        "--assistant",
        action="store_true",
        help="加上平台的助手：起助手容器，控制面把会话交给它（要用源码构建的控制面和助手镜像）",
    )
    up.add_argument("--assistant-image", default=DEFAULT_ASSISTANT_IMAGE)
    up.add_argument(
        "--assistant-model",
        default="fake",
        help="助手用模型配置里的哪个模型，默认 fake（假的模型端点，照剧本执行参考答案）",
    )
    sub.add_parser("down", help="删掉这个槽位的全部容器、网络和卷")
    sub.add_parser("reset", help="把环境恢复到刚起好的状态")
    seed = sub.add_parser("seed", help="重置环境并准备一道题的初始状态")
    seed.add_argument("task")
    grade = sub.add_parser("grade", help="给环境里当前的状态判分")
    grade.add_argument("task")
    ref = sub.add_parser("reference", help="在当前状态上应用参考答案")
    ref.add_argument("task")
    check = sub.add_parser("selfcheck", help="判分自检：参考答案满分，什么都不做零分")
    check.add_argument("tasks", nargs="*")
    run = sub.add_parser("run", help="跑会话：每个模型、每道题各跑若干次，判分并保存记录")
    run.add_argument("--task", action="append", required=True, help="题目 id，可以重复")
    run.add_argument("--model", action="append", required=True, help="模型配置里的模型名，可以重复")
    run.add_argument("--repeat", type=int, default=1)
    run.add_argument(
        "--arm",
        action="append",
        choices=list(ARMS),
        help="对照实验的臂：a 工具在本地执行（默认），b 工具经能力端口在开发环境里执行，"
        "p 平台（经控制面的会话接口交给平台内的助手，要 up --assistant）；可以重复",
    )
    run.add_argument("--max-turns", type=int, default=40)
    run.add_argument("--max-seconds", type=float, default=1200)
    run.add_argument("--results", type=Path, help="结果目录，默认 ~/.local/share/sfly/evals/<日期>")
    run.add_argument("--budget", type=int, default=40, help="这次最多跑多少次会话，超过就停")
    run.add_argument(
        "--fill",
        action="store_true",
        help="--repeat 是目标次数，结果目录里已有的有效会话算进去（中途停下后接着跑）",
    )
    run.add_argument(
        "--cap",
        action="append",
        help="会话上限，按臂分开：`臂=N`（例如 a=37），或 `N` 给每个臂；结果目录里这一臂已有的会话"
        "（作废的也算）到了 N 就不再跑这一臂",
    )
    camp = sub.add_parser(
        "campaign",
        help="一个新模型的全部会话：第一轮、过线补跑、对照实验的两臂；重跑同一条命令接着跑",
    )
    camp.add_argument("--model", required=True)
    camp.add_argument(
        "--results", type=Path, help="结果目录，默认 ~/.local/share/sfly/evals/<日期>-<模型>"
    )
    camp.add_argument("--budget", type=int, default=40, help="第一轮和臂 A 补跑的会话上限")
    camp.add_argument("--budget-b", type=int, default=40, help="臂 B 的会话上限")
    camp.add_argument("--max-turns", type=int, default=40)
    camp.add_argument("--max-seconds", type=float, default=1200)
    pack_cmd = sub.add_parser("pack", help="生成离线包（镜像、评测目录、镜像站缓存）")
    pack_cmd.add_argument("out", type=Path, help="离线包放在哪个目录")
    pack_cmd.add_argument("--server-image", default=DEFAULT_SERVER_IMAGE)
    pack_cmd.add_argument("--workbench-image", default=DEFAULT_WORKBENCH_IMAGE)
    pack_cmd.add_argument("--cache", type=Path, help="镜像站的缓存目录")
    trans = sub.add_parser("transcript", help="把一次会话压成便于阅读的文字")
    trans.add_argument("session", type=Path, help="会话目录")
    trans.add_argument("--lines", type=int, default=8, help="每个工具结果显示几行")
    tc = sub.add_parser(
        "toolcheck", help="工具自检：假的模型端点照剧本调用四个工具，对比臂 A 和臂 B"
    )
    tc.add_argument(
        "--results", type=Path, help="结果目录，默认 ~/.local/share/sfly/evals/<日期>-toolcheck"
    )
    pr = sub.add_parser(
        "probe", help="「循环在工作台里」的配置下，模型能不能改 pi 的设置、会话文件，读到令牌"
    )
    pr.add_argument("--model", required=True)
    pr.add_argument(
        "--results", type=Path, help="结果目录，默认 ~/.local/share/sfly/evals/<日期>-probe"
    )
    rp = sub.add_parser(
        "rpcprobe", help="助手服务那套启动参数下 pi 的 RPC 模式怎么表现（#539，假的模型端点）"
    )
    rp.add_argument(
        "questions",
        nargs="*",
        choices=rpcprobe.QUESTIONS,
        metavar="题号",
        help="只跑这几题（q1…q17），默认全部；题号写错时在重置环境之前就报错",
    )
    rp.add_argument(
        "--results", type=Path, help="结果目录，默认 ~/.local/share/sfly/evals/<日期>-rpcprobe"
    )
    rp.add_argument(
        "--assistant-image",
        help="从哪个助手镜像取产品的远程工具扩展（不给时用这个槽位的助手容器用的；槽位里也没有助手容器"
        "就报错，不退到默认标签）",
    )
    bg = sub.add_parser(
        "bgcheck", help="已有的会话记录里，模型多常跨两次命令依赖后台进程（#539，不调模型）"
    )
    bg.add_argument("results", type=Path, nargs="+", help="结果目录（可以写多个，会往下找会话）")
    bg.add_argument("--json", action="store_true", help="输出 JSON")
    bg.add_argument(
        "--include-fake", action="store_true", help="也算假的模型端点的会话（照剧本，默认不算）"
    )
    mem = sub.add_parser("memory", help="量 pi 进程（RPC 模式）空闲和工作时的内存")
    mem.add_argument("--model", required=True)
    mem.add_argument("--repeat", type=int, default=3)
    mem.add_argument(
        "--results", type=Path, help="结果目录，默认 ~/.local/share/sfly/evals/<日期>-memory"
    )
    e2e_cmd = sub.add_parser(
        "e2e",
        help="端到端：经控制面的接口建会话、发一道题，跟着事件流等到这一轮结束，"
        "再判分（要 up --assistant）",
    )
    e2e_cmd.add_argument("task", nargs="?", default="write")
    e2e_cmd.add_argument(
        "--results", type=Path, help="结果目录，默认 ~/.local/share/sfly/evals/<日期>-e2e"
    )
    e2e_cmd.add_argument(
        "--max-seconds",
        type=float,
        default=900,
        help="等这一轮结束的时限；没有事件时按控制面的心跳（15 秒一次）检查，最多晚这么久",
    )
    report = sub.add_parser("report", help="把结果目录汇总成 Markdown 表格")
    report.add_argument("results", type=Path)
    args = parser.parse_args(argv)
    if args.command == "transcript":
        print(transcript.render(args.session, args.lines))
        return 0
    if args.command == "bgcheck":
        found = bgcheck.scan(args.results, include_fake=args.include_fake)
        print(
            json.dumps(found, ensure_ascii=False, indent=2) if args.json else bgcheck.render(found)
        )
        return 0
    if args.command == "report":
        print(render(args.results))
        return 0
    stack = _stack(args)
    if args.command == "pack":
        args.out.mkdir(parents=True, exist_ok=True)
        print(pack(stack, args.out.resolve()))
        return 0
    if args.command == "up":
        stack.up()
    elif args.command == "down":
        stack.down()
    elif args.command == "reset":
        stack.reset()
    elif args.command == "seed":
        task = TASKS[args.task]
        stack.reset()
        task.seed(stack)
    elif args.command == "reference":
        TASKS[args.task].apply_reference(stack)
    elif args.command == "grade":
        result = summarize(TASKS[args.task].grade(stack))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["passed"] else 1
    elif args.command == "run":
        return run_many(stack, args)
    elif args.command == "campaign":
        return campaign(stack, args)
    elif args.command == "toolcheck":
        results = args.results or DATA_HOME / f"{date.today().isoformat()}-toolcheck"
        results.mkdir(parents=True, exist_ok=True)
        return toolcheck.run(stack, results, EVALS_DIR)
    elif args.command == "rpcprobe":
        image = rpcprobe.assistant_image_choice(stack, args.assistant_image)
        if image is None:
            parser.error(
                "没有指定助手镜像，这个槽位里也没有助手容器：用 --assistant-image 明确指定"
                "产品的助手镜像（不退到默认标签，免得量到几天前构建的旧扩展）"
            )
        stack.assistant_image = image
        results = args.results or DATA_HOME / f"{date.today().isoformat()}-rpcprobe"
        questions = tuple(args.questions) or rpcprobe.QUESTIONS
        return rpcprobe.run(stack, results, EVALS_DIR, questions)
    elif args.command == "probe":
        results = args.results or DATA_HOME / f"{date.today().isoformat()}-probe"
        # 假的模型端点照剧本把每件事都试一遍：看配置允许什么，不看模型愿不愿意做。
        text = "AEVAL-PROBE：照剧本试一遍。" if args.model == "fake" else probe.prompt_text()
        record = probe.run(stack, load_models()[args.model], results, text)
        print(json.dumps(record, ensure_ascii=False, indent=2))
    elif args.command == "memory":
        results = args.results or DATA_HOME / f"{date.today().isoformat()}-memory"
        print(
            json.dumps(
                memory(stack, load_models()[args.model], args.repeat, results), ensure_ascii=False
            )
        )
    elif args.command == "selfcheck":
        return selfcheck(stack, args.tasks or list(TASKS))
    elif args.command == "e2e":
        results = args.results or DATA_HOME / f"{date.today().isoformat()}-e2e"
        return e2e.run(stack, TASKS[args.task], results, args.max_seconds)
    return 0


def memory(stack: Stack, model: Model, repeat: int, results: Path) -> dict[str, object]:
    """在开发环境容器里起 pi 的 RPC 进程，量空闲和一轮提示时的内存。

    用题目「写」的初始状态（带两份 skill），和真实会话的启动条件一样。
    """
    stack.reset()
    TASKS["write"].seed(stack)
    prepare_pi(stack, model)
    task = TASKS["write"]
    samples = []
    for _ in range(repeat):
        out = d.sh(
            stack.dev,
            f"python3 {OPT}/pi_memory.py --cwd {task.workspace} "
            f"--provider aeval --model {model.model_id}",
            env={"PI_TELEMETRY": "0"},
            timeout=600,
        )
        samples.append(json.loads(out.stdout.strip().splitlines()[-1]))
    record: dict[str, object] = {"model": model.name, "samples": samples}
    results.mkdir(parents=True, exist_ok=True)
    (results / f"memory-{model.name}.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2)
    )
    return record


def selfcheck(stack: Stack, ids: list[str]) -> int:
    """每道题：什么都不做判分应为 0 分，应用参考答案后判分应为满分，
    参考答案之后再改坏一处原有内容应为 0 分（「不许破坏」的检查能判出来）。"""
    failed = 0
    for task_id in ids:
        task = TASKS[task_id]
        for label, apply, want in (
            ("什么都不做", None, 0.0),
            ("参考答案", task.apply_reference, 1.0),
            ("破坏了原有内容", task.apply_breakage, 0.0),
        ):
            stack.reset()
            task.seed(stack)
            if apply is not None:
                apply(stack)
            result = summarize(task.grade(stack))
            ok = result["score"] == want and result["passed"] == (want == 1.0)
            failed += not ok
            print(
                f"{'通过' if ok else '不通过'}  {task_id}  {label}："
                f"得分 {result['score']}（应为 {want}）",
                flush=True,
            )
            if not ok:
                for c in result["checks"]:
                    print(
                        f"    [{c['kind']}] {'✓' if c['passed'] else '✗'} {c['name']}  "
                        f"{c['detail'][:300]}"
                    )
    return 1 if failed else 0


def existing(results: Path) -> Counter[tuple[str, str, str]]:
    """结果目录里已有的有效会话数，按（题目、模型、臂）计。"""
    return Counter(
        (r["task"], r["model"], arm_of(r)) for r in load_records(results) if not r.get("invalid")
    )


def plan_sessions(
    tasks: list[str],
    models: list[str],
    arms: list[str],
    repeat: int,
    have: Counter[tuple[str, str, str]] | None = None,
) -> list[tuple[str, str, int, str]]:
    """要跑的会话：每个（题目、模型、臂）跑到 repeat 次；给了 have 时已有的有效会话也算进去。

    两臂交替：同一道题的同一次重复，臂 A 和臂 B 挨着跑。上游的状态随时间变，先跑完一臂再跑另一臂
    会把这种变化算到臂的头上。
    """
    plan = []
    for i in range(repeat):
        for model in models:
            for task in tasks:
                for arm in arms:
                    if have is not None and i < have[(task, model, arm)]:
                        continue
                    plan.append((task, model, i, arm))
    return plan


def parse_caps(values: list[str] | None, arms: list[str]) -> dict[str, int]:
    """--cap 的值：`N`（给每个臂）或 `臂=N`（例如 a=37），可以重复。"""
    caps: dict[str, int] = {}
    for value in values or []:
        arm, _, number = value.rpartition("=")
        for target in [arm] if arm else arms:
            caps[target] = int(number)
    return caps


def run_many(stack: Stack, args: argparse.Namespace) -> int:
    results: Path = args.results or DATA_HOME / date.today().isoformat()
    have = existing(results) if args.fill else None
    arms = args.arm or ["a"]
    plan = plan_sessions(args.task, args.model, arms, args.repeat, have)
    if not plan:
        print("计划是空的：要的会话都已经有了", flush=True)
        return 0
    if len(plan) > args.budget:
        print(f"计划 {len(plan)} 次会话，超过上限 {args.budget}，没有开始")
        return 2
    caps = parse_caps(args.cap, arms)
    return run_plan(stack, plan, results, args.max_turns, args.max_seconds, caps)


def run_plan(
    stack: Stack,
    plan: list[tuple[str, str, int, str]],
    results: Path,
    max_turns: int,
    max_seconds: float,
    caps: dict[str, int] | None = None,
) -> int:
    """依次跑计划里的会话。模型端点出故障时停下（返回 1），用 --fill 重跑会从停下的地方接着跑。

    caps：每个臂的会话上限，按结果目录里这个臂已有的会话（作废的也算）数，每跑一次之前都查；
    一个臂到了上限，它剩下的会话不跑，另一个臂照常；全部因为上限没跑完时返回 3。
    """
    capped = False
    models = load_models()
    results.mkdir(parents=True, exist_ok=True)
    info = {
        **versions(stack),
        "server_image": stack.server_image,
        "max_turns": max_turns,
        "max_seconds": max_seconds,
    }
    (results / "run-info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2))
    for task_id, model_name, i, arm in plan:
        if caps and arm in caps:
            used = sum(1 for r in load_records(results) if arm_of(r) == arm)
            if used >= caps[arm]:
                if not capped:
                    print(
                        f"臂 {arm} 到了会话上限 {caps[arm]}（已用 {used} 次），不再跑这一臂",
                        flush=True,
                    )
                capped = True
                continue
        label = model_name if arm == "a" else f"{model_name}-{arm}"
        try:
            record = run_session(
                stack,
                TASKS[task_id],
                models[model_name],
                results,
                max_turns=max_turns,
                max_seconds=max_seconds,
                session_id=f"{task_id}-{label}-{i + 1}-{datetime.now().strftime('%H%M%S')}",
                arm=arm,
            )
        except EndpointDown as error:
            print(error, flush=True)
            return 1
        driver = record["driver"]
        if record["invalid"]:
            fault = record.get("platform_fault") or {}
            what = (
                f"评测环境出了问题（{fault['reason']}）"
                if fault.get("kind") == "environment"
                else "模型端点出了故障"
            )
            print(f"{record['session']}：{what}，这次会话作废，后面的会话不再跑", flush=True)
            return 1
        verdict = (
            "通过"
            if record["grade"]["passed"]
            else f"不通过（{(record['failure'] or {}).get('primary')}）"
        )
        print(
            f"{record['session']}：{verdict}，得分 {record['grade']['score']}，"
            f"{driver.get('turns')} 轮，{driver.get('wall_seconds')} 秒，"
            f"内存峰值 {driver.get('pi_peak_rss_mib')} MiB",
            flush=True,
        )
    return 3 if capped else 0


ROUND_TASKS = ["write", "fix", "orchestrate", "cross"]


def campaign(stack: Stack, args: argparse.Namespace) -> int:
    """拿到一个新模型后要跑的全部会话，一条命令跑完；中途停下（模型端点故障）后重跑同一条命令接着跑。

    1. 第一轮：每道题 3 次（臂 A）；
    2. 对照实验：每道题臂 A、臂 B 各 5 次，两臂交替跑（臂 A 沿用第一轮的）。
    过线检查（「写」「修」的 2/3 和 4/5）在 report 里给出。两份上限分开算：臂 A 算 --budget，
    臂 B 算 --budget-b，都按结果目录里已有的会话（作废的也算）每跑一次之前检查。
    """
    results: Path = args.results or DATA_HOME / f"{date.today().isoformat()}-{args.model}"
    model = args.model
    caps = {"a": args.budget, "b": args.budget_b}
    first = plan_sessions(ROUND_TASKS, [model], ["a"], 3, existing(results))
    if first:
        code = run_plan(stack, first, results, args.max_turns, args.max_seconds, caps)
        if code:
            return code
    rest = plan_sessions(ROUND_TASKS, [model], ["a", "b"], 5, existing(results))
    code = run_plan(stack, rest, results, args.max_turns, args.max_seconds, caps) if rest else 0
    print(render(results))
    return code
