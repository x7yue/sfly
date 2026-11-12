"""`sfly run start / wait / cancel`：在平台上触发、等待、取消运行。

退出码：0 成功，1 运行失败，3 运行被取消，2 命令本身出错（参数不对、预检不通过、连不上控制面……），
124 等待超时，130 按 Ctrl-C 停止等待。超时和 Ctrl-C 都只停止等待，不取消运行。
场景的指定、错误和输出约定见 `scenario_lookup.py`、`session.py`、`output.py`。
"""

from __future__ import annotations

import argparse
import re
from typing import Any

from sfly.cli.client import ApiError, Client, segment
from sfly.cli.errors import CliError
from sfly.cli.run_params import build_params, describe_declared
from sfly.cli.run_summary import (
    EXIT_BY_STATUS,
    build_summary,
    format_duration,
    render_summary,
    run_url,
)
from sfly.cli.run_wait import WaitTimeout, wait_for_run
from sfly.cli.scenario_lookup import find_scenario
from sfly.cli.session import Session, command, common_options

EXIT_TIMEOUT = 124
EXIT_INTERRUPTED = 130


def register(run_sub: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    p_start = run_sub.add_parser(
        "start",
        parents=[common_options()],
        help="触发场景的最新版本，可以等它结束",
        description="先预检场景：有问题时列出问题并退出，不触发。入口参数用 --param 名=值 或 "
        "--params JSON 给出，值按入口节点声明的类型转换（string 原样，number 按数字，"
        "boolean 写 true 或 false，json 按 JSON）。总是触发场景的最新版本。"
        "不加 --wait 时输出运行 id 和控制台里的运行链接；加 --wait 时一直等到运行结束，"
        "节点状态每变化一次往 stderr 写一行进度，结束后在 stdout 输出摘要"
        "（状态、耗时、失败的节点及其错误、每个失败任务的最后 50 行日志）。"
        "退出码：成功 0，运行失败 1，命令出错 2，运行被取消 3，等待超时 124，Ctrl-C 130。"
        "等待超时和 Ctrl-C 只停止等待，不取消运行。",
    )
    p_start.add_argument("scenario", metavar="场景", help="场景 id 或准确名称")
    p_start.add_argument(
        "--param",
        action="append",
        metavar="名=值",
        help="入口参数，可以重复给出；与 --params 里的同名项相比，以这里的为准",
    )
    p_start.add_argument(
        "--params", metavar="JSON", help="入口参数的 JSON 对象，json 类型的参数用它传"
    )
    p_start.add_argument("--wait", action="store_true", help="等到运行结束，再输出摘要")
    _add_timeout_option(p_start)
    p_start.set_defaults(func=command(_start))

    p_wait = run_sub.add_parser(
        "wait",
        parents=[common_options()],
        help="等一次运行结束，输出摘要",
        description="订阅运行的实时更新，断线后自动重连。节点状态每变化一次往 stderr 写一行进度，"
        "运行结束后在 stdout 输出摘要"
        "（状态、耗时、失败的节点及其错误、每个失败任务的最后 50 行日志）。"
        "运行已经结束时直接输出摘要。"
        "退出码：成功 0，运行失败 1，命令出错 2，运行被取消 3，等待超时 124，Ctrl-C 130。"
        "等待超时和 Ctrl-C 只停止等待，不取消运行。",
    )
    p_wait.add_argument("run", metavar="运行", help="运行 id")
    _add_timeout_option(p_wait)
    p_wait.set_defaults(func=command(_wait))

    p_cancel = run_sub.add_parser(
        "cancel",
        parents=[common_options()],
        help="取消一次运行",
        description="取消整个运行：正在执行的任务收到取消，等它们结束后运行变为已取消。"
        "运行还没结束时再次取消即强制取消（立即杀掉任务进程）。"
        "运行已经结束时报 run_not_running。",
    )
    p_cancel.add_argument("run", metavar="运行", help="运行 id")
    p_cancel.set_defaults(func=command(_cancel))


def _add_timeout_option(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--timeout",
        type=_duration,
        metavar="时长",
        help="最多等多久，例如 90、90s、5m、1h（默认一直等）；超时后运行继续执行，不会被取消",
    )


def _duration(text: str) -> float:
    found = re.fullmatch(r"(\d+(?:\.\d+)?)([smh]?)", text.strip())
    seconds = float(found[1]) * {"": 1, "s": 1, "m": 60, "h": 3600}[found[2]] if found else 0.0
    if seconds <= 0:
        raise argparse.ArgumentTypeError(f"需要大于 0 的时长，例如 90、90s、5m、1h，收到 {text!r}")
    return seconds


def _start(session: Session, args: argparse.Namespace) -> int:
    if args.timeout is not None and not args.wait:
        raise CliError(
            "invalid_arguments",
            "--timeout 限制的是等待的时长，需要和 --wait 一起用",
        )
    client = session.client
    scenario = find_scenario(client, args.scenario, command="sfly run start")
    scenario_id = scenario["id"]
    show = f"sfly scenario show {scenario_id}"

    preflight = client.get(f"/orchestrations/{segment(scenario_id)}/preflight")
    if preflight["problems"]:
        problems = preflight["problems"]
        listed = "\n".join(f"  - {p['code']}：{p['message']}" for p in problems)
        raise CliError(
            "invalid_orchestration",
            f"场景「{scenario['name']}」现在不能触发，有 {len(problems)} 个问题：\n{listed}",
            next=show,
        )
    declared = preflight["params"]
    params = build_params(declared, args.param or [], args.params, next_command=show)
    try:
        run = client.request(
            "POST", f"/orchestrations/{segment(scenario_id)}/runs", body={"params": params}
        )
    except ApiError as error:
        if error.code == "invalid_params":
            raise CliError(
                "invalid_params",
                f"入口参数不对：{error.message}\n{describe_declared(declared)}",
                next=show,
            ) from None
        raise

    run_id: str = run["id"]
    url = run_url(client, run_id)
    if not args.wait:
        started = {
            "id": run_id,
            "status": run["status"],
            "scenario_id": scenario_id,
            "scenario_version": run["orchestration_version"],
            "url": url,
        }
        session.out.emit(
            started,
            f"已触发运行 {run_id}\n链接：{url}",
            note=f"等它结束：sfly run wait {run_id}",
        )
        return 0
    _progress(session, f"已触发运行 {run_id}，链接：{url}")
    return _follow(session, run_id, args.timeout)


def _wait(session: Session, args: argparse.Namespace) -> int:
    run = _get_run(session.client, args.run)
    if run["status"] != "running":
        return _finish(session, run)
    return _follow(session, args.run, args.timeout)


def _cancel(session: Session, args: argparse.Namespace) -> None:
    try:
        run = session.client.request("POST", f"/runs/{segment(args.run)}/cancel")
    except ApiError as error:
        raise _with_next(error, args.run) from None
    cancel = run["cancel"] or {}
    forced = cancel.get("forced_at") is not None
    cancelling = run["status"] == "running"
    view = {"id": run["id"], "status": run["status"], "cancelling": cancelling, "forced": forced}
    if not cancelling:
        session.out.emit(view, f"运行 {run['id']} 已取消")
    elif forced:
        session.out.emit(view, f"已强制取消运行 {run['id']}，正在结束剩下的任务")
    else:
        session.out.emit(
            view,
            f"已请求取消运行 {run['id']}，正在等任务结束、清理",
            note=f"等它结束：sfly run wait {run['id']}；"
            "清理期间再次取消会强制取消（立即杀掉任务进程）",
        )


def _follow(session: Session, run_id: str, timeout: float | None) -> int:
    """等运行结束并输出摘要；超时和 Ctrl-C 只停止等待。"""
    out = session.out
    hint = f"取消运行：sfly run cancel {run_id}"
    try:
        run = wait_for_run(
            session.client, run_id, timeout=timeout, log=lambda line: _progress(session, line)
        )
    except WaitTimeout:
        spent = format_duration(timeout or 0)
        out.error(
            CliError(
                "wait_timeout",
                f"等待超时（{spent}），运行 {run_id} 仍在继续，没有被取消。\n{hint}",
                next=f"sfly run wait {run_id}",
            )
        )
        return EXIT_TIMEOUT
    except KeyboardInterrupt:
        out.error(
            CliError(
                "interrupted",
                f"已停止等待，运行 {run_id} 仍在继续，没有被取消。\n{hint}",
                next=f"sfly run wait {run_id}",
            )
        )
        return EXIT_INTERRUPTED
    except ApiError as error:
        raise _with_next(error, run_id) from None
    return _finish(session, run)


def _finish(session: Session, run: dict[str, Any]) -> int:
    summary = build_summary(session.client, run)
    session.out.emit(summary, render_summary(summary))
    return EXIT_BY_STATUS[run["status"]]


def _progress(session: Session, line: str) -> None:
    print(line, file=session.out.stderr, flush=True)


def _get_run(client: Client, run_id: str) -> dict[str, Any]:
    try:
        run: dict[str, Any] = client.get(f"/runs/{segment(run_id)}")
    except ApiError as error:
        raise _with_next(error, run_id) from None
    return run


def _with_next(error: ApiError, run_id: str) -> ApiError:
    """给运行相关的错误补上下一步：找不到运行时列出最近的运行，运行已经结束时看它的结果。"""
    next_command = {404: "sfly run list", 409: f"sfly run show {run_id}"}.get(error.status)
    if next_command is None or error.next:
        return error
    return ApiError(error.status, error.code, error.message, error.details, next_command)
