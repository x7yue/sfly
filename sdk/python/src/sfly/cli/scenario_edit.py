"""`sfly scenario` 的编辑命令：`pull`、`push`、`create`、`copy`、`rename`。

编辑场景是「pull 下载文件 → 改 → push 上传」。文件的格式：

    {"scenario": "<场景 id>", "base_version": 7, "document": {"default_agent": …, "nodes": […], …}}

`document` 就是场景文档本身。`base_version` 是编辑起点的版本号，push 时带给控制面：
控制面上已经有更新的版本时返回 409 `version_conflict`，命令提示重新 pull、合并后再 push，
不提供强制覆盖。没有 `position` 的节点不用写坐标：控制面保存时按画布的「整理布局」补上，
压住已有节点时挪到附近的空位；push 成功后文件里的 `document` 换成控制面实际保存的内容。

secret 参数的默认值，控制面读出来是占位符 `******`，pull 下来的文件里也是它：
不改它直接 push，新版本沿用上一个版本里同名参数的值；
写成别的值才会替换，删掉 `default` 就是去掉默认值。
占位符沿用不了时（新场景、参数改了名……）控制面拒绝保存。
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
from sfly.cli.removed_document_fields import removed_fields_in, removed_fields_message
from sfly.cli.removed_nodes import REMOVED_NODE_KINDS, removed_kind_label, removed_outputs_advice
from sfly.cli.scenario_lookup import find_scenario
from sfly.cli.session import Session, command, common_options

if TYPE_CHECKING:
    from jsonschema.exceptions import ValidationError

# 读取接口给 secret 参数的默认值打的码：packages/schema 的 SECRET_MASK，
# 和日志、运行视图、运行预设里的是同一个。
SECRET_MASK = "******"

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
        "文件已存在时覆盖。secret 参数的默认值在文件里是占位符 ******（读不到原值）："
        "不改它直接 push，新版本沿用最新版本里同名参数的默认值"
        "（拉旧版本时也是最新版本的，不是旧版本的）。",
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
        "并把文件里的 base_version 更新为新版本号、document 换成控制面实际保存的内容"
        "（包括补好的坐标），方便接着改、接着 push。"
        "控制面上已经有更新的版本时报冲突（退出码 2）：重新 pull，把改动合并进去再 push，"
        "不提供强制覆盖。没有 position 的节点由控制面按整理布局补上坐标"
        "（压住已有节点时挪到附近的空位），已有坐标的节点不动。"
        "secret 参数的默认值是占位符 ******（pull 写出来的）时沿用上一个版本里同名参数的默认值；"
        "沿用不了（参数改了名、类型变了、不再是 secret 参数……）时拒绝保存，"
        "给新的默认值或删掉 default。写成新的值就保存新的值。",
    )
    p_push.add_argument("file", metavar="文件", help="pull 写出的 JSON 文件")
    p_push.set_defaults(func=command(_push))

    p_create = group.add_parser(
        "create",
        parents=[common_options()],
        help="新建场景，可以用文件里的场景文档保存第一个版本",
        description="新建场景。给了 --from 文件时同时保存第一个版本"
        "（文件里需要有 document，scenario 和 base_version 不需要；文档本地校验没通过时不新建）。"
        "文件里 secret 参数的默认值不能是占位符 ******"
        "（新场景没有上一个版本可以沿用，报错、不新建）："
        "要连同 secret 的默认值复制一个场景，用 copy。",
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
        description="复制场景并取新名字：说明、运行通知设置和运行预设一起复制，"
        "源场景最新版本的内容作为第 1 版"
        "（secret 参数的默认值和预设里的 secret 值一样跟着复制，读出来仍打码）。",
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

    target = os.path.abspath(args.output or _default_file_name(scenario))
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
        note=_placeholder_note(document, version, latest),
    )


def _default_file_name(scenario: dict[str, Any]) -> str:
    safe = _UNSAFE_FILE_NAME.sub("-", scenario["name"]).strip("-.")
    return f"{safe or scenario['id']}.scenario.json"


# —— push ——


def _push(session: Session, args: argparse.Namespace) -> None:
    client = session.client
    target = os.path.abspath(args.file)
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
        _write_json(
            target, {**content, "base_version": saved["number"], "document": saved["document"]}
        )
    except CliError as error:
        note = f"新版本已保存，但没能更新文件里的 base_version 和 document：{error.message}"
    warnings = saved["warnings"]
    lines = [f"已保存场景 {scenario_id} 的版本 {saved['number']}（文件基于版本 {base_version}）。"]
    lines.extend(_warning_lines(warnings))
    if note is None:
        lines.append(
            f"文件 {target} 的 base_version 已更新为 {saved['number']}，"
            "document 换成了控制面实际保存的内容（包括补好的坐标）。"
        )
    session.out.emit(
        {
            "scenario": scenario_id,
            "version": saved["number"],
            "base_version": base_version,
            "author": saved["author"],
            "author_via": saved["author_via"],
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
    if error.code == "secret_default_placeholder" and isinstance(error.details, list):
        lines = [
            f"  节点 {p.get('node_id')} 的参数 {p.get('param')}："
            f"{_PLACEHOLDER_REASONS.get(p.get('reason'), '')}"
            for p in error.details
        ]
        return CliError(
            error.code,
            f"文件里有 secret 参数的默认值是占位符 {SECRET_MASK}，没有可以沿用的原值，没有保存：\n"
            + "\n".join(lines)
            + "\n给这些参数写上新的默认值，或者删掉它们的 default，再 push。",
        )
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


# —— secret 参数的默认值：占位符 ——

_PLACEHOLDER_REASONS = {
    "no_previous_value": "上一个版本里没有这个参数的默认值可以沿用"
    "（新增的参数、改了名，或者场景还没有保存过版本）",
    "type_changed": "参数的类型变了，上一个版本里的默认值不能沿用",
    "unsecured": "参数不再是 secret 参数：占位符不能存成默认值，原来的默认值也不会带到普通参数上",
}


def _masked_defaults(document: Any) -> list[tuple[str, str]]:
    """文档里默认值是占位符的 secret 参数：（入口节点 id，参数名）。"""
    found: list[tuple[str, str]] = []
    nodes = document.get("nodes") if isinstance(document, dict) else None
    for node in nodes if isinstance(nodes, list) else []:
        if not isinstance(node, dict) or node.get("kind") not in ("entry", "subflow_entry"):
            continue
        for param in node.get("params") or []:
            if (
                isinstance(param, dict)
                and param.get("secret") is True
                and param.get("default") == SECRET_MASK
            ):
                found.append((str(node.get("id")), str(param.get("name"))))
    return found


def _placeholder_note(document: Any, version: int, latest: int) -> str | None:
    """pull 的提示：文件里 secret 参数的默认值是占位符，原样 push 沿用原值，写成别的值才替换。
    拉的是旧版本时，沿用的是最新版本的值，不是这个旧版本的。"""
    masked = _masked_defaults(document)
    if not masked:
        return None
    lines = [
        f"文件里有 {len(masked)} 个 secret 参数的默认值是占位符 {SECRET_MASK}（读不到原值）："
        "不改它直接 push，新版本沿用上一个版本里同名参数的默认值；"
        "写成别的值才会替换，删掉 default 就是去掉默认值。"
    ]
    if version != latest:
        lines.append(
            f"这个文件是版本 {version} 的内容，但占位符沿用的是最新版本 {latest} 里的值，"
            f"不是版本 {version} 的。"
        )
    return "".join(lines)


def _check_no_placeholders(document: Any, source: Any) -> None:
    """新建场景没有上一个版本可以沿用：文档里 secret 参数的默认值是占位符时在新建之前就报错。"""
    masked = _masked_defaults(document)
    if not masked:
        return
    lines = [f"  节点 {node} 的参数 {param}" for node, param in masked]
    copy = (
        f"sfly scenario copy {shlex.quote(source)} --name <新名称>"
        if isinstance(source, str) and source
        else None
    )
    raise CliError(
        "secret_default_placeholder",
        f"文件里有 secret 参数的默认值是占位符 {SECRET_MASK}，"
        "新场景没有上一个版本可以沿用，没有新建场景：\n"
        + "\n".join(lines)
        + "\n给这些参数写上默认值，或者删掉它们的 default；"
        "要连同 secret 的默认值一起复制一个场景，用 sfly scenario copy。",
        next=copy,
    )


# —— create / copy / rename ——


def _create(session: Session, args: argparse.Namespace) -> None:
    client = session.client
    name = _checked_name(args.name)
    document = None
    if args.source:
        content = _read_file(os.path.abspath(args.source))
        document = content["document"]
        _check_document(document)
        _check_no_placeholders(document, content.get("scenario"))
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
    节点上的错误在位置后面标出节点 id。顶层带着已移除的字段（便签 `sticky_notes`，ADR 0028）时
    不报 JSON Schema 的「不允许的属性」，写明这一项已不再支持、怎么办（和控制面同一句）。"""
    from jsonschema import Draft202012Validator

    from sfly.schemas import load_schema

    validator = Draft202012Validator(load_schema("orchestration-document"))
    found: dict[tuple[tuple[bool, int | str], ...], set[str]] = {}
    where: dict[tuple[tuple[bool, int | str], ...], str] = {}
    removed = removed_fields_in(document)
    if removed:
        found[()] = {removed_fields_message(removed)}
        where[()] = "(根)"
        document = {k: v for k, v in document.items() if k not in removed}
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
        if isinstance(shown, str) and shown in REMOVED_NODE_KINDS:
            # 已移除的节点种类（ADR 0028）：说明怎么替换，和控制面拒绝保存时的说法一致。
            _, replacement = REMOVED_NODE_KINDS[shown]
            return [
                ValidationError(
                    f"{removed_kind_label(shown)}：这种节点已不再支持，先删掉再保存。替换办法：{replacement}"
                    + (f"。{advice}" if (advice := removed_outputs_advice(shown)) else ""),
                    path=[*error.absolute_path, "kind"],
                )
            ]
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
