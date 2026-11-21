"""`sfly scenario check`、`sfly scenario diff`，以及 `sfly scenario push --strict` 的检查（#424）。

检查不保存：把 pull 格式的文件交给控制面的 `POST /orchestrations/:id/check`，它和保存走同一段校验，
返回保存时会有的错误和警告，以及保存之后相对最新版本的差异。对比两个版本用
`GET /orchestrations/:id/versions/:a/diff/:b`；本地文件和最新版本比也走检查接口（差异是控制面算的，
和画布上的版本对比是同一个函数）。

退出码：没有问题 0；只有警告 `EXIT_WARNINGS`（4，`check` 和 `push --strict`）；
有错误（文档不合法、版本冲突、场景不存在……）和其他命令一样是 2。
"""

from __future__ import annotations

import argparse
import os
from typing import Any

# scenario_edit 也引用这里（push --strict）：引用模块、调用时再取函数，两边谁先导入都行。
from sfly.cli import scenario_edit
from sfly.cli.client import ApiError, Client, segment
from sfly.cli.errors import EXIT_WARNINGS, CliError
from sfly.cli.output import dump_json
from sfly.cli.run_view import name_with_id, node_type_label
from sfly.cli.scenario_lookup import find_scenario
from sfly.cli.session import Session, command, common_options


def register(group: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    """把 `check`、`diff` 注册进 `sfly scenario` 的命令组。"""
    p_check = group.add_parser(
        "check",
        parents=[common_options()],
        help="检查 pull 下来并改过的文件：列出保存时会有的错误和警告、保存之后的改动，不保存",
        description="和 push 走同一段校验，但不保存、不产生版本："
        "先在本地按场景文档的 JSON Schema 校验，再交给控制面检查，"
        "返回的错误和警告与 push 时完全一样，并列出保存之后相对最新版本的改动。"
        f"退出码：没有问题 0；只有警告 {EXIT_WARNINGS}（push 照常保存，push --strict 不保存）；"
        "有错误（文档不合法、文件基于的版本已经不是最新……）2。",
    )
    p_check.add_argument("file", metavar="文件", help="pull 写出的 JSON 文件")
    p_check.set_defaults(func=command(_check))

    p_diff = group.add_parser(
        "diff",
        parents=[common_options()],
        help="对比场景的两个版本，或者本地文件和最新版本：新增、删除、改动的节点和连线",
        description="列出从版本 A 到版本 B 的差异：设置（默认 Agent、锁定的节点包版本）、"
        "新增和删除的节点（显示名称和节点 ID）、改动的节点和改动字段的前后值、"
        "连线、只改了位置的节点、注释框。"
        "不写版本时对比最新的两个版本，只写一个时和最新版本比。"
        "--file 对比最新版本和本地文件（保存这个文件之后会改变什么）。",
    )
    p_diff.add_argument("scenario", metavar="场景", help="场景 id 或准确名称")
    p_diff.add_argument(
        "versions",
        metavar="版本",
        nargs="*",
        type=scenario_edit.version_number,
        help="版本 A、版本 B（默认最新的两个；只写一个时 B 是最新版本）",
    )
    p_diff.add_argument("--file", metavar="文件", help="和最新版本比的本地文件（pull 的格式）")
    p_diff.set_defaults(func=command(_diff))


def add_strict_option(parser: argparse.ArgumentParser) -> None:
    """`push --strict`。"""
    parser.add_argument(
        "--strict",
        action="store_true",
        help=f"有警告时不保存，退出码 {EXIT_WARNINGS}（和 sfly scenario check 一样）",
    )


# —— 控制面的检查 ——


def _request_check(
    client: Client, scenario_id: str, document: Any, base_version: int | None, target: str
) -> dict[str, Any]:
    body: dict[str, Any] = {"document": document}
    if base_version is not None:
        body["base_version"] = base_version
    try:
        checked: dict[str, Any] = client.request(
            "POST", f"/orchestrations/{segment(scenario_id)}/check", body=body
        )
    except ApiError as error:
        raise scenario_edit.explain_save_error(
            error, scenario_id, base_version or 0, target
        ) from None
    return checked


def _check(session: Session, args: argparse.Namespace) -> int:
    target = os.path.abspath(args.file)
    _, scenario_id, base_version, document = scenario_edit.load_push_file(target)
    scenario_edit.check_document(document)
    checked = _request_check(session.client, scenario_id, document, base_version, target)
    warnings, diff = checked["warnings"], checked["diff"]
    where = f"对照场景 {scenario_id} 的版本 {base_version}"
    if warnings:
        lines = [
            f"文档有 {len(warnings)} 条警告（{where}）：push 照常保存，push --strict 不保存。",
            *(f"  {w['message']}" for w in warnings),
        ]
    else:
        lines = [f"文档没有问题：没有警告（{where}）。"]
    diff_lines = render_diff(diff)
    if diff_lines:
        lines.append(f"保存之后相对版本 {base_version} 的改动：")
        lines.extend(f"  {line}" for line in diff_lines)
    else:
        lines.append(f"和版本 {base_version} 相比没有改动。")
    session.out.emit(
        {
            "scenario": scenario_id,
            "base_version": base_version,
            "ok": not warnings,
            "warnings": warnings,
            "diff": diff,
        },
        "\n".join(lines),
    )
    return EXIT_WARNINGS if warnings else 0


def refuse_on_warnings(
    session: Session, scenario_id: str, base_version: int, document: Any, target: str
) -> int | None:
    """`push --strict`：先检查，有警告时输出警告、不保存，返回退出码；
    没有警告时返回 None，照常保存。"""
    warnings = _request_check(session.client, scenario_id, document, base_version, target)[
        "warnings"
    ]
    if not warnings:
        return None
    session.out.emit(
        {
            "scenario": scenario_id,
            "saved": False,
            "base_version": base_version,
            "warnings": warnings,
            "file": target,
        },
        "\n".join(
            [
                f"没有保存：文档有 {len(warnings)} 条警告（--strict），"
                f"场景 {scenario_id} 仍是版本 {base_version}。",
                *(f"  {w['message']}" for w in warnings),
                "改掉警告再 push；要带着警告保存，去掉 --strict。",
            ]
        ),
    )
    return EXIT_WARNINGS


# —— 对比 ——


def _diff(session: Session, args: argparse.Namespace) -> None:
    client = session.client
    if args.file is not None and args.versions:
        raise CliError(
            "invalid_args",
            "--file 和版本号不能一起写：--file 是本地文件和最新版本比",
            next=f"sfly scenario diff {args.scenario} --file {args.file}",
        )
    if len(args.versions) > 2:
        raise CliError("invalid_args", f"最多写两个版本号，收到 {len(args.versions)} 个")
    scenario = find_scenario(client, args.scenario, command="sfly scenario diff")
    name, head = scenario["name"], scenario["head_version"]
    if args.file is not None:
        target = os.path.abspath(args.file)
        document = scenario_edit.read_file(target)["document"]
        scenario_edit.check_document(document)
        diff = _request_check(client, scenario["id"], document, None, target)["diff"]
        heading = f"场景「{name}」最新版本 {head} → 文件 {target}"
        same = f"场景「{name}」最新版本 {head} 和文件 {target} 没有差异。"
        view = {"scenario": scenario["id"], "from": head, "file": target, "diff": diff}
    else:
        a, b = _versions(scenario, args.versions)
        diff = client.get(f"/orchestrations/{segment(scenario['id'])}/versions/{a}/diff/{b}")[
            "diff"
        ]
        heading = f"场景「{name}」版本 {a} → 版本 {b}"
        same = f"场景「{name}」版本 {a} 和版本 {b} 没有差异。"
        view = {"scenario": scenario["id"], "from": a, "to": b, "diff": diff}
    lines = render_diff(diff)
    text = "\n".join([f"{heading}：", *(f"  {line}" for line in lines)]) if lines else same
    session.out.emit(view, text)


def _versions(scenario: dict[str, Any], versions: list[int]) -> tuple[int, int]:
    head = scenario["head_version"]
    if not versions and head < 2:
        raise CliError(
            "not_enough_versions",
            f"场景「{scenario['name']}」只有 {head} 个版本，没有可以对比的两个版本",
            next=f"sfly scenario diff {scenario['id']} --file <文件>",
        )
    a, b = (versions + [head])[:2] if versions else (head - 1, head)
    for number in (a, b):
        if number > head:
            raise CliError(
                "version_not_found",
                f"场景「{scenario['name']}」没有版本 {number}，最新版本是 {head}",
                next=f"sfly scenario versions {scenario['id']}",
            )
    return a, b


_MISSING = object()


def _value(change: dict[str, Any], key: str) -> str:
    value = change.get(key, _MISSING)
    return "（无）" if value is _MISSING else dump_json(value)


def _field(change: dict[str, Any], label: str | None = None) -> str:
    return f"{label or change['path']}：{_value(change, 'before')} → {_value(change, 'after')}"


def _setting_label(path: str) -> str:
    if path == "default_agent":
        return "默认 Agent"
    if path.startswith("packages."):
        return f"节点包 {path.removeprefix('packages.')}"
    return path


def _node(ref: dict[str, Any]) -> str:
    return name_with_id(ref["id"], ref.get("display_name"))


def render_diff(diff: dict[str, Any]) -> list[str]:
    """控制面返回的差异（DocumentDiffView）写成文本，每节一个标题；没有差异时是空列表。
    新增、删除的节点写「显示名称（节点 ID）」和节点类型，改动的节点下面逐项写改动字段的前后值。"""
    lines: list[str] = []
    if diff["settings"]:
        lines.append("设置：")
        lines.extend(f"  {_field(c, _setting_label(c['path']))}" for c in diff["settings"])
    nodes = diff["nodes"]
    if nodes["added"] or nodes["removed"] or nodes["changed"]:
        lines.append("节点：")
        lines.extend(f"  + {_node(n)}  {node_type_label(n)}" for n in nodes["added"])
        lines.extend(f"  - {_node(n)}  {node_type_label(n)}" for n in nodes["removed"])
        for n in nodes["changed"]:
            lines.append(f"  ~ {_node(n)}")
            lines.extend(f"      {_field(c)}" for c in n["changes"])
    edges = diff["edges"]
    if edges["added"] or edges["removed"]:
        lines.append("连线：")
        lines.extend(f"  + {e['from']} → {e['to']}（{e['kind']}）" for e in edges["added"])
        lines.extend(f"  - {e['from']} → {e['to']}（{e['kind']}）" for e in edges["removed"])
    if diff["moved"]:
        lines.append(f"只改了位置的节点：{'、'.join(diff['moved'])}")
    annotations = diff["annotations"]
    if annotations["added"] or annotations["removed"] or annotations["changed"]:
        lines.append("注释框：")
        lines.extend(f"  + {a['title']}（{a['id']}）" for a in annotations["added"])
        lines.extend(f"  - {a['title']}（{a['id']}）" for a in annotations["removed"])
        for a in annotations["changed"]:
            lines.append(f"  ~ {a['title']}（{a['id']}）")
            lines.extend(f"      {_field(c)}" for c in a["changes"])
    return lines
