"""`sfly scenario` 的编辑命令：`pull`、`push`、`create`、`copy`、`rename`。

编辑场景是「pull 下载文件 → 改 → push 上传」。文件的格式：

    {"scenario": "<场景 id>", "base_version": 7, "document": {"default_agent": …, "nodes": […], …}}

`document` 就是场景文档本身。`base_version` 是编辑起点的版本号，push 时带给控制面：
控制面上已经有更新的版本时返回 409 `version_conflict`，命令提示重新 pull、合并后再 push，
不提供强制覆盖。没有 `position` 的节点不用写坐标：控制面保存时按画布的「整理布局」补上。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sfly.cli.client import ApiError, Client, segment
from sfly.cli.errors import CliError
from sfly.cli.scenario_lookup import find_scenario
from sfly.cli.session import Session, command, common_options

if TYPE_CHECKING:
    from jsonschema.exceptions import ValidationError

_UNSAFE_FILE_NAME = re.compile(r'[\\/:*?"<>|\s]+')
_NODE_PATH = re.compile(r"^nodes/(\d+)(?:/|$)")


def register(group: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    """把编辑命令注册进 `sfly scenario` 的命令组。"""
    p_pull = group.add_parser(
        "pull",
        parents=[common_options()],
        help="把场景的最新版本下载成 JSON 文件，改完用 push 保存",
        description="把场景的最新版本写成 JSON 文件 "
        '{"scenario": 场景 id, "base_version": 版本号, "document": 场景文档}。'
        "base_version 总是最新版本号：用 --version 拉旧版本时，"
        "push 就相当于以旧版本的内容为起点再保存一次。"
        "文件已存在时覆盖。",
    )
    p_pull.add_argument("scenario", metavar="场景", help="场景 id 或准确名称")
    p_pull.add_argument(
        "-o",
        "--output",
        metavar="文件",
        help="写到这个文件（默认当前目录的 <场景名>.scenario.json）",
    )
    p_pull.add_argument(
        "--version", type=_version_number, metavar="N", help="拉第 N 版（默认最新版本）"
    )
    p_pull.set_defaults(func=command(_pull))

    p_push = group.add_parser(
        "push",
        parents=[common_options()],
        help="把 pull 下来并改过的文件保存成场景的新版本",
        description="先按场景文档的 JSON Schema 在本地校验，没通过时列出出错的位置、不发请求；"
        "通过后带着文件里的 base_version 保存新版本，输出新版本号和控制面返回的警告，"
        "并把文件里的 base_version 更新为新版本号，方便接着改、接着 push。"
        "控制面上已经有更新的版本时报冲突（退出码 2）：重新 pull，把改动合并进去再 push，"
        "不提供强制覆盖。没有 position 的节点由控制面按整理布局补上坐标，已有坐标的节点不动。",
    )
    p_push.add_argument("file", metavar="文件", help="pull 写出的 JSON 文件")
    p_push.set_defaults(func=command(_push))

    p_create = group.add_parser(
        "create",
        parents=[common_options()],
        help="新建场景，可以用文件里的场景文档保存第一个版本",
        description="新建场景。给了 --from 文件时同时保存第一个版本"
        "（文件里需要有 document，scenario 和 base_version 不需要；文档本地校验没通过时不新建）。",
    )
    p_create.add_argument("--name", required=True, help="场景名称")
    p_create.add_argument("--description", default="", help="场景说明")
    p_create.add_argument(
        "--from", dest="source", metavar="文件", help="用这个 JSON 文件里的 document 保存第一个版本"
    )
    p_create.set_defaults(func=command(_create))

    p_copy = group.add_parser(
        "copy",
        parents=[common_options()],
        help="复制场景（联调时改副本，不影响原场景）",
        description="复制场景并取新名字：说明和运行通知设置一起复制，"
        "源场景最新版本的内容作为第 1 版。",
    )
    p_copy.add_argument("scenario", metavar="场景", help="源场景的 id 或准确名称")
    p_copy.add_argument("--name", required=True, help="新场景的名称")
    p_copy.set_defaults(func=command(_copy))

    p_rename = group.add_parser(
        "rename",
        parents=[common_options()],
        help="修改场景的名称和说明（不产生新版本）",
        description="修改场景的名称和说明，至少给一个。名称和说明不属于场景版本，不产生新版本，立即生效。",
    )
    p_rename.add_argument("scenario", metavar="场景", help="场景 id 或准确名称")
    p_rename.add_argument("--name", help="新名称")
    p_rename.add_argument("--description", help="新说明（给空字符串清空说明）")
    p_rename.set_defaults(func=command(_rename))


def _version_number(text: str) -> int:
    try:
        number = int(text)
    except ValueError:
        number = 0
    if number < 1:
        raise argparse.ArgumentTypeError(f"需要正整数的版本号，收到 {text!r}")
    return number


# —— pull ——


def _pull(session: Session, args: argparse.Namespace) -> None:
    client = session.client
    scenario = find_scenario(client, args.scenario, command="sfly scenario pull")
    base = f"/orchestrations/{segment(scenario['id'])}"
    head = client.get(f"{base}/head")
    latest = head["number"]
    version, document = latest, head["document"]
    if args.version is not None and args.version != latest:
        if latest == 0:
            raise CliError(
                "version_not_found",
                f"场景「{scenario['name']}」还没有保存过版本，不能指定 --version",
            )
        if args.version > latest:
            raise CliError(
                "version_not_found",
                f"场景「{scenario['name']}」没有版本 {args.version}，最新版本是 {latest}",
                next=f"sfly scenario pull {scenario['id']} --version {latest}",
            )
        version = args.version
        document = client.get(f"{base}/versions/{version}")["document"]

    target = _absolute(args.output or _default_file_name(scenario))
    _write_json(target, {"scenario": scenario["id"], "base_version": latest, "document": document})

    name = scenario["name"]
    if latest == 0:
        text = f"场景「{name}」还没有保存过版本，已把初始文档写到 {target}（base_version 0）。"
    elif version == latest:
        text = f"已把场景「{name}」的最新版本 {latest} 写到 {target}（base_version {latest}）。"
    else:
        text = (
            f"已把场景「{name}」的版本 {version} 写到 {target}"
            f"（base_version {latest}，是最新版本号："
            f"push 会以版本 {version} 的内容为起点保存新版本）。"
        )
    session.out.emit(
        {
            "scenario": scenario["id"],
            "name": name,
            "file": target,
            "version": version,
            "base_version": latest,
        },
        text,
    )


def _default_file_name(scenario: dict[str, Any]) -> str:
    safe = _UNSAFE_FILE_NAME.sub("-", scenario["name"]).strip("-.")
    return f"{safe or scenario['id']}.scenario.json"


# —— push ——


def _push(session: Session, args: argparse.Namespace) -> None:
    client = session.client
    target = _absolute(args.file)
    content = _read_file(target)
    scenario_id, base_version = content.get("scenario"), content.get("base_version")
    if (
        not isinstance(scenario_id, str)
        or not scenario_id
        or not isinstance(base_version, int)
        or isinstance(base_version, bool)
        or base_version < 0
    ):
        raise CliError(
            "invalid_file",
            f"{target} 里没有有效的 scenario（场景 id）和 base_version（非负整数）：push 的文件用 "
            "sfly scenario pull 生成",
            next="sfly scenario pull <场景> -o <文件>",
        )
    document = content["document"]
    _check_document(document)

    try:
        saved = _save_version(client, scenario_id, base_version, document)
    except ApiError as error:
        raise _explain_push_error(error, scenario_id, base_version, target) from None

    note = None
    try:
        _write_json(target, {**content, "base_version": saved["number"]})
    except CliError as error:
        note = f"新版本已保存，但没能更新文件里的 base_version：{error.message}"
    warnings = saved["warnings"]
    lines = [f"已保存场景 {scenario_id} 的版本 {saved['number']}（文件基于版本 {base_version}）。"]
    lines.extend(_warning_lines(warnings))
    if note is None:
        lines.append(f"文件 {target} 的 base_version 已更新为 {saved['number']}。")
    session.out.emit(
        {
            "scenario": scenario_id,
            "version": saved["number"],
            "base_version": base_version,
            "author": saved["author"],
            "created_at": saved["created_at"],
            "warnings": warnings,
            "file": target,
        },
        "\n".join(lines),
        note=note,
    )


def _save_version(
    client: Client, scenario_id: str, base_version: int, document: Any
) -> dict[str, Any]:
    saved: dict[str, Any] = client.request(
        "POST",
        f"/orchestrations/{segment(scenario_id)}/versions",
        body={"document": document, "base_version": base_version},
    )
    return saved


def _explain_push_error(
    error: ApiError, scenario_id: str, base_version: int, target: str
) -> CliError:
    if error.status == 404:
        return CliError(
            "scenario_not_found",
            f"没有 id 是 {scenario_id} 的场景（文件里的 scenario）",
            next="sfly scenario list",
        )
    if error.code == "version_conflict":
        details = error.details if isinstance(error.details, dict) else {}
        latest = details.get("head")
        pull = (
            f"sfly scenario pull {shlex.quote(scenario_id)} "
            f"-o {shlex.quote(str(Path(target).with_suffix('.latest.json')))}"
        )
        if isinstance(latest, dict):
            message = (
                f"场景已有更新的版本：版本 {latest['number']} 由 {latest['author']} "
                f"保存于 {latest['created_at']}，你的文件基于版本 {base_version}。"
                "重新 pull，把你的改动合并进去再 push"
            )
        else:
            message = (
                f"场景还没有保存过版本，你的文件基于版本 {base_version}。"
                "重新 pull，把你的改动合并进去再 push"
            )
        return CliError("version_conflict", message, next=pull)
    if error.code == "invalid_document" and isinstance(error.details, list):
        lines = [f"  {_issue_path(issue)}: {issue.get('message')}" for issue in error.details]
        return CliError(error.code, "控制面认为场景文档不合法：\n" + "\n".join(lines))
    return error


def _issue_path(issue: Any) -> str:
    path = issue.get("path") if isinstance(issue, dict) else None
    parts = [str(p) for p in path] if isinstance(path, list) else []
    return "/".join(parts[1:] if parts[:1] == ["body"] else parts) or "(根)"


def _warning_lines(warnings: list[dict[str, Any]]) -> list[str]:
    if not warnings:
        return []
    return [f"警告（{len(warnings)}）：", *(f"  {w['message']}" for w in warnings)]


# —— create / copy / rename ——


def _create(session: Session, args: argparse.Namespace) -> None:
    client = session.client
    name = _checked_name(args.name)
    document = None
    if args.source:
        document = _read_file(_absolute(args.source))["document"]
        _check_document(document)
    created = client.request(
        "POST", "/orchestrations", body={"name": name, "description": args.description}
    )
    saved = None
    if document is not None:
        try:
            saved = _save_version(client, created["id"], 0, document)
        except CliError as error:
            raise CliError(
                error.code,
                f"已新建场景「{name}」（{created['id']}），但保存第一个版本失败：{error.message}",
                next=f"sfly scenario push <文件>（文件里的 scenario 改成 {created['id']}）",
            ) from None
    warnings = saved["warnings"] if saved else []
    head_version = saved["number"] if saved else created["head_version"]
    summary = "，".join(
        [f"已新建场景「{name}」（{created['id']}）"]
        + ([f"保存了版本 {head_version}"] if saved else ["还没有保存过版本"])
    )
    session.out.emit(
        {
            "id": created["id"],
            "name": created["name"],
            "description": created["description"],
            "head_version": head_version,
            "warnings": warnings,
        },
        "\n".join([summary + "。", *_warning_lines(warnings)]),
    )


def _copy(session: Session, args: argparse.Namespace) -> None:
    client = session.client
    name = _checked_name(args.name)
    source = find_scenario(client, args.scenario, command="sfly scenario copy")
    copied = client.request(
        "POST", f"/orchestrations/{segment(source['id'])}/copy", body={"name": name}
    )
    detail = (
        f"第 1 版是「{source['name']}」最新版本 {source['head_version']} 的内容"
        if copied["head_version"]
        else f"「{source['name']}」还没有保存过版本，副本也没有"
    )
    session.out.emit(
        {
            "id": copied["id"],
            "name": copied["name"],
            "description": copied["description"],
            "head_version": copied["head_version"],
            "source": source["id"],
        },
        f"已把场景「{source['name']}」复制为「{copied['name']}」（{copied['id']}），{detail}。",
    )


def _rename(session: Session, args: argparse.Namespace) -> None:
    client = session.client
    if args.name is None and args.description is None:
        raise CliError(
            "nothing_to_change",
            "没有要修改的内容：用 --name 修改名称，用 --description 修改说明（可以同时给）",
            next=f"sfly scenario rename {shlex.quote(args.scenario)} --name <新名称>",
        )
    changes: dict[str, str] = {}
    if args.name is not None:
        changes["name"] = _checked_name(args.name)
    if args.description is not None:
        changes["description"] = args.description
    scenario = find_scenario(client, args.scenario, command="sfly scenario rename")
    updated = client.request("PATCH", f"/orchestrations/{segment(scenario['id'])}", body=changes)
    changed = []
    if "name" in changes:
        changed.append(f"名称「{scenario['name']}」改为「{updated['name']}」")
    if "description" in changes:
        changed.append("说明已更新")
    version = (
        f"场景的最新版本仍是 {updated['head_version']}，没有产生新版本。"
        if updated["head_version"]
        else "场景还没有保存过版本，没有产生新版本。"
    )
    session.out.emit(
        {
            "id": updated["id"],
            "name": updated["name"],
            "description": updated["description"],
            "head_version": updated["head_version"],
        },
        f"已修改场景「{updated['name']}」（{updated['id']}）：{'；'.join(changed)}。{version}",
    )


def _checked_name(name: str) -> str:
    if not name.strip():
        raise CliError("invalid_name", "场景名称不能是空白")
    return name


# —— 文件和本地校验 ——


def _absolute(path: str) -> str:
    return os.path.abspath(path)


def _read_file(path: str) -> dict[str, Any]:
    """读 pull 格式的文件：JSON 对象，里面要有对象类型的 `document`。"""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as error:
        raise CliError("file_unreadable", f"无法读取 {path}：{error.strerror or error}") from None
    try:
        content = json.loads(text)
    except ValueError as error:
        raise CliError("invalid_file", f"{path} 不是合法的 JSON：{error}") from None
    if not isinstance(content, dict) or not isinstance(content.get("document"), dict):
        raise CliError(
            "invalid_file",
            f'{path} 的格式不对：需要 {{"scenario": …, "base_version": …, "document": {{…}}}}，'
            "用 sfly scenario pull 生成",
            next="sfly scenario pull <场景> -o <文件>",
        )
    return content


def _write_json(path: str, value: Any) -> None:
    try:
        Path(path).write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except OSError as error:
        raise CliError("file_unwritable", f"无法写入 {path}：{error.strerror or error}") from None


def _check_document(document: Any) -> None:
    """按随 SDK 打包的场景文档 JSON Schema 校验；没通过时抛 `invalid_document`，列出出错的位置。"""
    problems = _document_problems(document)
    if problems:
        raise CliError(
            "invalid_document",
            f"场景文档没有通过校验（{len(problems)} 处），没有发请求：\n" + "\n".join(problems),
        )


def _document_problems(document: Any) -> list[str]:
    """场景文档没通过 JSON Schema 校验的地方，每处一行 `  位置: 原因`，按位置排序；通过时为空列表。
    节点上的错误在位置后面标出节点 id。"""
    from jsonschema import Draft202012Validator

    from sfly.schemas import load_schema

    validator = Draft202012Validator(load_schema("orchestration-document"))
    found: dict[tuple[tuple[bool, int | str], ...], set[str]] = {}
    where: dict[tuple[tuple[bool, int | str], ...], str] = {}
    for error in validator.iter_errors(document):
        for leaf in _leaves(error):
            key = tuple((isinstance(part, str), part) for part in leaf.absolute_path)
            found.setdefault(key, set()).add(leaf.message)
            where[key] = _location(leaf, document)
    return [f"  {where[key]}: {message}" for key in sorted(found) for message in sorted(found[key])]


def _leaves(error: ValidationError) -> list[ValidationError]:
    """oneOf（节点按 kind 分支）的错误只展开 kind 对得上的分支，免得每个节点报每个分支的错。"""
    from jsonschema.exceptions import ValidationError

    if not error.context:
        return [error]
    instance = error.instance
    if isinstance(instance, dict) and "kind" not in instance:
        return [ValidationError("'kind' is a required property", path=list(error.absolute_path))]
    branches: dict[str | int, list[ValidationError]] = {}
    for sub in error.context:
        branches.setdefault(sub.schema_path[0], []).append(sub)
    matching = [subs for subs in branches.values() if not any(map(_is_kind_mismatch, subs))]
    if not matching:
        kinds = list(
            dict.fromkeys(
                str(sub.validator_value) for sub in error.context if _is_kind_mismatch(sub)
            )
        )
        shown = instance.get("kind") if isinstance(instance, dict) else None
        return [
            ValidationError(
                f"kind {shown!r} 不是已知的节点类型，可选：{'、'.join(kinds)}",
                path=[*error.absolute_path, "kind"],
            )
        ]
    return [leaf for subs in matching for sub in subs for leaf in _leaves(sub)]


def _is_kind_mismatch(error: ValidationError) -> bool:
    return error.validator == "const" and list(error.relative_path)[-1:] == ["kind"]


def _location(error: ValidationError, document: Any) -> str:
    path = "/".join(map(str, error.absolute_path)) or "(根)"
    if match := _NODE_PATH.match(path):
        nodes = document.get("nodes") if isinstance(document, dict) else None
        index = int(match.group(1))
        if isinstance(nodes, list) and index < len(nodes) and isinstance(nodes[index], dict):
            node_id = nodes[index].get("id")
            if isinstance(node_id, str):
                return f"{path}（节点 {node_id}）"
    return path
