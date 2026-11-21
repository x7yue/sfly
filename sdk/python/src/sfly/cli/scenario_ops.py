"""`sfly scenario edit`：场景的局部编辑（#470）。

增删节点和连线、改一个节点的字段，不用拉下整份 JSON。命令行只把参数变成操作
（`{"op": "add_node", …}`，格式见 @sfly/schema 的 EditOperation），交给控制面的
`POST /orchestrations/:id/edits`（`--dry-run` 时是 `/edits/check`）。
操作由控制面用画布的编辑函数执行，
一组操作要么全部生效存成一个新版本，要么都不生效。

退出码：保存成功 0；`--dry-run` 没有问题 0、只有警告 4；有错误（操作不合法、版本冲突……）2。
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
from typing import Any

from sfly.cli import scenario_check
from sfly.cli.client import ApiError, segment
from sfly.cli.errors import EXIT_WARNINGS, CliError
from sfly.cli.scenario_lookup import find_scenario
from sfly.cli.session import Session, command, common_options

_ADD_FIELDS = (
    ("--display-name", "display_name", str, "显示名称：说明它在这个场景里做什么"),
    ("--note", "note", str, "备注：配置有不明显的原因时写"),
    ("--agent", "agent", str, "执行它的 Agent（默认用场景的默认 Agent）"),
    ("--timeout", "timeout", int, "超时（秒）"),
    ("--retries", "retries", int, "失败后重试的次数"),
    ("--queue-timeout", "queue_timeout", int, "排队超时（秒）"),
)


def _edit_options(*, nested: bool) -> argparse.ArgumentParser:
    """`edit` 的选项：写在操作前后都行。写在操作后面的那一份不带默认值（`SUPPRESS`），
    免得盖掉写在前面的。"""
    parser = argparse.ArgumentParser(add_help=False)
    default: Any = argparse.SUPPRESS if nested else None
    if nested:
        parser.add_argument("--server", default=default, help=argparse.SUPPRESS)
        parser.add_argument("--nickname", default=default, help=argparse.SUPPRESS)
        parser.add_argument("--json", action="store_true", default=default, help=argparse.SUPPRESS)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=argparse.SUPPRESS if nested else False,
        help=f"只检查不保存：输出警告和这次会造成的改动，只有警告时退出码 {EXIT_WARNINGS}",
    )
    parser.add_argument(
        "--base-version",
        type=int,
        metavar="N",
        default=default,
        help="编辑基于的版本号（默认是最新版本）；之后有人保存了新版本时报冲突，不保存",
    )
    return parser


def register(group: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    """把 `edit` 注册进 `sfly scenario` 的命令组。"""
    parser = group.add_parser(
        "edit",
        parents=[common_options(), _edit_options(nested=False)],
        help="局部编辑场景：加节点、删节点、连线、断开、改节点的字段，不用 pull / push 整份文档",
        description="对场景的最新版本做一个操作（或者用 --file 一次做一组），存成一个新版本，"
        "输出新版本号、警告和这次的改动。操作由控制面执行，和画布上做同样的事得到同样的文档；"
        "一组操作里有一个不合法时都不生效，报错写明是第几个、为什么"
        "（节点 ID 写错时列出相近的 ID，缺必填输入时列出缺的输入和类型，"
        "连线接不上时写明两端各是什么）。"
        '值（--input、set 的值）按 JSON 解析，不是 JSON 的当字符串：3 是数字，"3" 要写成 \'"3"\'。'
        "入口参数、注释框、子流程的结构和场景的设置仍用 pull / push。"
        f"退出码：保存成功 0；--dry-run 没有问题 0、只有警告 {EXIT_WARNINGS}；有错误 2。",
    )
    parser.add_argument("scenario", metavar="场景", help="场景 id 或准确名称")
    parser.add_argument(
        "--file",
        metavar="文件",
        help='一次提交一组操作：JSON 文件，操作的数组或 {"operations": [...]}（操作的格式见文档）',
    )
    ops = parser.add_subparsers(dest="edit_op", metavar="操作")
    nested = [_edit_options(nested=True)]

    p_add = ops.add_parser(
        "add",
        parents=nested,
        help="加一个包节点",
        description="加一个包节点。--after 写了就接在那个节点后面（它后面还有节点时插在中间）；"
        "不写时只加节点、不连线。节点 ID 不写时按节点名加序号生成。"
        "包还没有锁定时一起锁定：--version 写了用它，不写时用最新发布的版本，"
        "只有在线的 Agent 加载着开发版本时用 dev。新节点不用写坐标。",
    )
    p_add.add_argument("type", metavar="包/节点", help="节点类型，例如 svc-probe/scan_remote_log")
    p_add.add_argument("--id", help="节点 ID（默认 节点名_序号）")
    p_add.add_argument("--after", metavar="节点", help="接在这个节点后面")
    p_add.add_argument("--version", help="包还没有锁定时用的版本")
    p_add.add_argument(
        "--input",
        action="append",
        default=[],
        metavar="名=值",
        help="节点的输入，可以重复；引用写成 ${{ params.名 }} 或 ${{ 节点.输出 }}",
    )
    for flag, dest, kind, text in _ADD_FIELDS:
        p_add.add_argument(flag, dest=dest, type=kind, help=text)
    p_add.add_argument("--always", action="store_true", default=None, help="前面的节点失败时也执行")

    p_remove = ops.add_parser(
        "remove",
        parents=nested,
        help="删一个节点（恰好一进一出时前后接上）",
        description="删一个节点，连同它的连线；它恰好一进一出时前后两个节点接上，注释框里的成员一起去掉。",
    )
    p_remove.add_argument("node", metavar="节点", help="节点 ID")

    for name, verb in (("connect", "连一条线"), ("disconnect", "断开一条线")):
        p = ops.add_parser(
            name,
            parents=nested,
            help=f"{verb}（默认链上的连线，--dispatch 是调度连线）",
            description=f"{verb}。链上的连线不分叉、不汇合、不成环；"
            "调度连线从异步任务节点连到子流程入口节点。",
        )
        p.add_argument("source", metavar="起点", help="起点的节点 ID")
        p.add_argument("target", metavar="终点", help="终点的节点 ID")
        p.add_argument("--dispatch", action="store_true", help="调度连线")

    p_set = ops.add_parser(
        "set",
        parents=nested,
        help="改一个节点的字段：inputs.<输入名>、agent、display_name、note、always、timeout……",
        description="改一个节点的一个字段：包节点能改 inputs.<输入名>、agent、display_name、note、"
        "always、timeout、retries、queue_timeout，其他节点能改 display_name、note。"
        "不写值就是去掉这个字段。",
    )
    p_set.add_argument("node", metavar="节点", help="节点 ID")
    p_set.add_argument("field", metavar="字段", help="例如 inputs.url、display_name")
    p_set.add_argument(
        "value", metavar="值", nargs="?", help="新的值（按 JSON 解析）；不写就是去掉"
    )

    parser.set_defaults(func=command(_edit))


def _value(text: str) -> Any:
    """值按 JSON 解析，不是 JSON 的当字符串。"""
    try:
        return json.loads(text)
    except ValueError:
        return text


def _operations(args: argparse.Namespace) -> list[dict[str, Any]]:
    if args.file is not None and args.edit_op is not None:
        raise CliError("invalid_args", "--file 和单个操作不能一起写")
    if args.file is not None:
        return _read_operations(os.path.abspath(args.file))
    if args.edit_op is None:
        raise CliError(
            "invalid_args",
            "要写一个操作（add、remove、connect、disconnect、set），或者用 --file 提交一组",
            next="sfly scenario edit --help",
        )
    if args.edit_op == "add":
        return [_add(args)]
    if args.edit_op == "remove":
        return [{"op": "remove_node", "node": args.node}]
    if args.edit_op in ("connect", "disconnect"):
        kind = "dispatch" if args.dispatch else "chain"
        return [{"op": args.edit_op, "from": args.source, "to": args.target, "kind": kind}]
    op: dict[str, Any] = {"op": "set", "node": args.node, "field": args.field}
    if args.value is not None:
        op["value"] = _value(args.value)
    return [op]


def _add(args: argparse.Namespace) -> dict[str, Any]:
    package, slash, node = args.type.partition("/")
    if not slash or not package or not node:
        raise CliError(
            "invalid_args",
            f"节点类型要写成 包名/节点名，收到 {args.type!r}",
            next="sfly package show <包> 看节点类型",
        )
    inputs: dict[str, Any] = {}
    for item in args.input:
        name, eq, text = item.partition("=")
        if not eq or not name:
            raise CliError("invalid_args", f"--input 要写成 名=值，收到 {item!r}")
        inputs[name] = _value(text)
    op: dict[str, Any] = {"op": "add_node", "package": package, "node": node, "inputs": inputs}
    for key in ("id", "after", "version", *(dest for _, dest, _, _ in _ADD_FIELDS), "always"):
        value = getattr(args, key)
        if value is not None:
            op[key] = value
    return op


def _read_operations(path: str) -> list[dict[str, Any]]:
    try:
        with open(path, encoding="utf-8") as f:
            content = json.load(f)
    except OSError as error:
        raise CliError("file_unreadable", f"无法读取 {path}：{error.strerror or error}") from None
    except ValueError as error:
        raise CliError("invalid_file", f"{path} 不是合法的 JSON：{error}") from None
    operations = content.get("operations") if isinstance(content, dict) else content
    if not isinstance(operations, list) or not operations:
        raise CliError(
            "invalid_file",
            f'{path} 的格式不对：需要操作的数组，或者 {{"operations": [...]}}',
        )
    return operations


def _edit(session: Session, args: argparse.Namespace) -> int:
    client = session.client
    operations = _operations(args)
    scenario = find_scenario(client, args.scenario, command="sfly scenario edit")
    scenario_id, name = scenario["id"], scenario["name"]
    base = args.base_version if args.base_version is not None else scenario["head_version"]
    body = {"base_version": base, "operations": operations}
    try:
        result: dict[str, Any] = (
            client.request("POST", f"/orchestrations/{segment(scenario_id)}/edits/check", body=body)
            if args.dry_run
            else client.request("POST", f"/orchestrations/{segment(scenario_id)}/edits", body=body)
        )
    except ApiError as error:
        raise _explain(
            error, scenario_id, base, explicit_base=args.base_version is not None
        ) from None
    warnings, diff = result["warnings"], result["diff"]
    changes = scenario_check.render_diff(diff)
    if args.dry_run:
        lines = [f"检查过了，没有保存（场景「{name}」仍是版本 {base}）：这组操作会造成的改动："]
        view: dict[str, Any] = {"scenario": scenario_id, "saved": False, "base_version": base}
    else:
        lines = [f"已保存场景「{name}」的版本 {result['number']}（基于版本 {base}）："]
        view = {
            "scenario": scenario_id,
            "saved": True,
            "version": result["number"],
            "base_version": base,
            "author": result["author"],
            "author_via": result["author_via"],
            "created_at": result["created_at"],
        }
    lines.extend(f"  {line}" for line in changes or ["没有改动。"])
    new = scenario_check.fresh(warnings)
    if new:
        lines.append(f"这次改动带进来的警告（{len(new)}）：")
        lines.extend(f"  {w['message']}" for w in new)
    note = "，不是这次改动带进来的" + ("，不影响退出码" if args.dry_run else "")
    lines.extend(scenario_check.existing_lines(warnings, note))
    session.out.emit({**view, "warnings": warnings, "diff": diff}, "\n".join(lines))
    return EXIT_WARNINGS if args.dry_run and new else 0


def _explain(error: ApiError, scenario_id: str, base: int, *, explicit_base: bool) -> CliError:
    if error.status == 404:
        return CliError(
            "scenario_not_found", f"没有 id 是 {scenario_id} 的场景", next="sfly scenario list"
        )
    if error.code == "invalid_operation":
        return CliError(
            error.code, f"没有保存，这组操作都不生效：{error.message}", hints=error.details
        )
    if error.code == "version_conflict":
        details = error.details if isinstance(error.details, dict) else {}
        latest = details.get("head")
        retry = (
            "去掉 --base-version 再执行一次"
            if explicit_base
            else "再执行一次同样的命令（会在最新版本上做）"
        )
        if isinstance(latest, dict):
            message = (
                f"场景已有更新的版本：版本 {latest['number']} 由 {latest['author']} "
                f"保存于 {latest['created_at']}，这次编辑基于版本 {base}。"
                f"看过最新版本的改动、确认这次编辑仍然要做之后{retry}"
            )
            next_command = (
                f"sfly scenario diff {shlex.quote(scenario_id)} {base} {latest['number']}"
            )
        else:
            message = f"场景还没有保存过版本，这次编辑基于版本 {base}"
            next_command = f"sfly scenario show {shlex.quote(scenario_id)}"
        return CliError("version_conflict", message, next=next_command)
    return error
