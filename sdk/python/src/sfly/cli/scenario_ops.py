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
import re
import shlex
from collections.abc import Callable
from typing import Any

from sfly.cli import scenario_check
from sfly.cli.client import ApiError, Client, segment
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
        "值（--input、set 的值）按 JSON 解析，不是 JSON 的当字符串：3 是数字，true 是布尔；"
        '节点类型声明这个输入是字符串时按原样存字符串（1.10 存成 "1.10"，不会变成数字 1.1）；'
        "查不到节点类型时（例如开发版本没有在线的 Agent 上报）要字符串就写成 JSON 字符串，"
        "例如 '\"1.10\"'。值以 - 开头时在它前面加 --，例如 set probe_1 inputs.offset -- -5。"
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
        help="节点的输入，可以重复。引用入口参数写 ${{ params.<参数名> }}，"
        "引用前面节点的输出写 ${{ nodes.<节点 ID>.outputs.<输出键> }}，"
        "「运行状态」类型的输入写 ${{ run.state }}（新节点会自动填好）；"
        "在 shell 里用单引号括起来，例如 --input 'url=${{ nodes.fetch_data.outputs.body }}'",
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
        "always、timeout、retries、queue_timeout；入口节点、异步任务节点能改 display_name、note，"
        "停止子流程节点还能改 always，子流程入口节点只能改 note。"
        "不写值就是去掉这个字段。",
    )
    p_set.add_argument("node", metavar="节点", help="节点 ID")
    p_set.add_argument("field", metavar="字段", help="例如 inputs.url、display_name")
    p_set.add_argument(
        "value",
        metavar="值",
        nargs="?",
        help="新的值（按 JSON 解析；输入声明是字符串时按原样）；不写就是去掉；"
        "以 - 开头时前面加 --，例如 set probe_1 inputs.offset -- -5",
    )

    parser.set_defaults(func=command(_edit))


def _value(text: str, schema: dict[str, Any] | None = None) -> Any:
    """值按 JSON 解析，不是 JSON 的当字符串。`schema` 是节点类型里这个输入的声明：
    它收字符串、不收按 JSON 解析出来的值时（声明是字符串，写的是 1.10、true、3）
    按原样存字符串，不改写成数字或布尔。"""
    try:
        parsed = json.loads(text)
    except ValueError:
        return text
    if schema is not None and not isinstance(parsed, str):
        if _accepts(schema, text) and not _accepts(schema, parsed):
            return text
    return parsed


_JSON_TYPES: dict[str, Any] = {
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, int | float) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
    "array": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
}


def _accepts(schema: dict[str, Any], value: Any) -> bool:
    """输入的声明收不收这个值：只看 type、anyOf、enum（和控制面检查输入类型的规则一致，
    packages/orchestration/src/inputs.ts）；没有类型信息时什么都收。"""
    if isinstance(schema.get("enum"), list):
        return value in schema["enum"]
    if isinstance(schema.get("anyOf"), list):
        return any(_accepts(s, value) for s in schema["anyOf"] if isinstance(s, dict))
    kind = schema.get("type")
    kinds = [kind] if isinstance(kind, str) else kind if isinstance(kind, list) else None
    if not kinds:
        return True
    # 认不出的类型（包括不是字符串的，比如数组里套着数组）什么都收，和控制面的 matchesType 一样。
    return any(not isinstance(k, str) or _JSON_TYPES.get(k, lambda _v: True)(value) for k in kinds)


def _needs_types(texts: list[str]) -> bool:
    """有按 JSON 解析出来不是字符串的值时，才要查节点类型（查不到也照常按 JSON 解析）。"""
    for text in texts:
        try:
            if not isinstance(json.loads(text), str):
                return True
        except ValueError:
            continue
    return False


def _node_inputs(
    client: Client,
    document: dict[str, Any],
    package: str,
    node: str,
    version: str | None,
    agent: str | None = None,
) -> dict[str, Any]:
    """节点类型的输入声明（输入名 → schema）；查不到时是空的（值照常按 JSON 解析）。

    版本和控制面加节点时一样取：给了用给的，场景锁定了用锁定的，否则最新发布的（按版本号比较），
    没有发布过（`GET /packages/<名>` 是 404）时用开发版本。`agent` 是这个节点另选的 Agent。"""
    version = version or document.get("packages", {}).get(package)
    try:
        if version is None:
            try:
                published = client.get(client.in_project(f"/packages/{segment(package)}"))[
                    "versions"
                ]
            except ApiError as e:
                if e.status != 404:
                    raise
                published = []
            version = _newest_version([str(v["version"]) for v in published]) or "dev"
        if version == "dev":
            nodes = _dev_nodes(client, document, package, agent)
        else:
            detail = client.get(
                client.in_project(f"/packages/{segment(package)}/versions/{segment(version)}")
            )
            nodes = _field(detail.get("metadata"), "nodes")
    except (ApiError, KeyError, TypeError, IndexError, AttributeError):
        return {}
    candidates = nodes if isinstance(nodes, list) else []
    found = next((n for n in candidates if isinstance(n, dict) and n.get("name") == node), None)
    properties = _field(_field(found, "inputs"), "properties")
    return properties if isinstance(properties, dict) else {}


def _field(value: Any, name: str) -> Any:
    """对象的字段；不是对象（null、格式不对）时是 None。"""
    return value.get(name) if isinstance(value, dict) else None


def _dev_nodes(client: Client, document: dict[str, Any], package: str, agent: str | None) -> Any:
    """开发版本的节点类型，和控制面同一套取法（`@sfly/orchestration` 的 `devNodeTypes`）：
    只看用到这个包的节点派发到的 Agent（节点的 Agent，没写就用场景的默认 Agent）——
    场景里已有的（包锁定了开发版本时），加上这一个——都在线、都加载了、上报的内容合法且相同才用，
    否则当作不知道（None）。"""
    default = document.get("default_agent")
    targets = {agent or default}
    if document.get("packages", {}).get(package) == "dev":
        for n in document.get("nodes") or []:
            if isinstance(n, dict) and n.get("kind") == "package" and n.get("package") == package:
                targets.add(n.get("agent") or default)
    if None in targets or "" in targets:
        return None
    by_name = {
        a.get("name"): a
        for a in client.get(client.in_project("/agents"))["agents"]
        if isinstance(a, dict)
    }
    reported = []
    for name in targets:
        found = by_name.get(name)
        if not found or found.get("status") != "online":
            return None
        dev = next(
            (
                d
                for d in found.get("dev_packages") or []
                if isinstance(d, dict) and d.get("name") == package
            ),
            None,
        )
        nodes = _reported_node_types(_field(dev.get("metadata"), "nodes")) if dev else None
        if nodes is None:
            return None
        reported.append(nodes)
    first = reported[0]
    return first if all(_same_json(r, first) for r in reported) else None


def _same_json(a: Any, b: Any) -> bool:
    """两份 JSON 内容是否相同，和控制面的 `sameJson` 一样：`true` 和 `1` 不相同（Python 的 `==`
    认为相同），`1` 和 `1.0` 相同，对象不看键的顺序。"""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same_json(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same_json(x, y) for x, y in zip(a, b, strict=True))
    if isinstance(a, dict | list) or isinstance(b, dict | list):
        return False
    return bool(a == b)


def _reported_node_types(raw: Any) -> list[Any] | None:
    """上报的节点类型列表合不合法（和控制面的 `reportedNodeTypes` 同一条规则，按 `IoSchema`
    逐条照搬：每项有名字；输入、输出是 `type: object` 加 `properties`（名字 → 对象），
    `required`、`order` 有的话是字符串的数组；`description` 有的话是字符串。写了 `null`
    也不合法）；合法时原样返回。"""
    if not isinstance(raw, list):
        return None
    for node in raw:
        if not isinstance(node, dict) or not isinstance(node.get("name"), str):
            return None
        for io in (node.get("inputs"), node.get("outputs")):
            if not isinstance(io, dict) or io.get("type") != "object":
                return None
            props = io.get("properties")
            if not isinstance(props, dict) or not all(isinstance(v, dict) for v in props.values()):
                return None
            for key in ("required", "order"):
                if key in io and not _strings(io[key]):
                    return None
        if "description" in node and not isinstance(node["description"], str):
            return None
    return raw


def _strings(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


def _newest_version(versions: list[str]) -> str | None:
    """一组版本号里最新的，和控制面一个口径（packages/orchestration 的 newestVersion）：
    按版本号比较，不是按发布时间；按版本号相等（1.0 和 1.0.0）时取字符串排在后面的那个。
    用例表在 testdata/version-order-cases.json。"""
    newest: str | None = None
    for version in versions:
        if newest is None or _compare_releases(version, newest) > 0:
            newest = version
    return newest


def _compare_releases(a: str, b: str) -> int:
    """先按版本号比，相等时按字符串（码位）比：结果总是确定的。"""
    return _compare_versions(a, b) or (-1 if a < b else 1 if a > b else 0)


def _compare_versions(a: str, b: str) -> int:
    """不是 PEP 440 的完整规则，只取它的核心：数字段逐段比较（缺的段当 0），字母段是预发布标记、
    排在同号正式版之前，都是字母时按字典序。小于 0 表示 a 更旧。"""
    ta, tb = _version_tokens(a), _version_tokens(b)
    for i in range(max(len(ta), len(tb))):
        x = ta[i] if i < len(ta) else None
        y = tb[i] if i < len(tb) else None
        if x is None:
            if isinstance(y, str):
                return 1
            if y != 0:
                return -1
            continue
        if y is None:
            if isinstance(x, str):
                return -1
            if x != 0:
                return 1
            continue
        if isinstance(x, int) and isinstance(y, int):
            if x != y:
                return x - y
            continue
        if isinstance(x, str) and isinstance(y, str):
            if x != y:
                return -1 if x < y else 1
            continue
        return -1 if isinstance(x, str) else 1
    return 0


def _version_tokens(version: str) -> list[int | str]:
    return [int(m) if m.isdigit() else m for m in re.findall(r"\d+|[a-z]+", version.lower())]


def _operations(
    args: argparse.Namespace, types: Callable[[], dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    """命令行参数变成操作。`types` 取这个操作涉及的节点类型的输入声明（只在有值要解析时才调用）。"""
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
        return [_add(args, types)]
    if args.edit_op == "remove":
        return [{"op": "remove_node", "node": args.node}]
    if args.edit_op in ("connect", "disconnect"):
        kind = "dispatch" if args.dispatch else "chain"
        return [{"op": args.edit_op, "from": args.source, "to": args.target, "kind": kind}]
    op: dict[str, Any] = {"op": "set", "node": args.node, "field": args.field}
    if args.value is not None:
        name = args.field.removeprefix("inputs.") if args.field.startswith("inputs.") else None
        schemas = types() if name is not None and types and _needs_types([args.value]) else {}
        op["value"] = _value(args.value, schemas.get(name) if name else None)
    return [op]


def _add(
    args: argparse.Namespace, types: Callable[[], dict[str, Any]] | None = None
) -> dict[str, Any]:
    package, slash, node = args.type.partition("/")
    if not slash or not package or not node:
        raise CliError(
            "invalid_args",
            f"节点类型要写成 包名/节点名，收到 {args.type!r}",
            next="sfly package show <包> 看节点类型",
        )
    pairs: list[tuple[str, str]] = []
    for item in args.input:
        name, eq, text = item.partition("=")
        if not eq or not name:
            raise CliError("invalid_args", f"--input 要写成 名=值，收到 {item!r}")
        pairs.append((name, text))
    schemas = types() if types and _needs_types([t for _, t in pairs]) else {}
    inputs = {name: _value(text, schemas.get(name)) for name, text in pairs}
    op: dict[str, Any] = {"op": "add_node", "package": package, "node": node, "inputs": inputs}
    for key in ("id", "after", "version", *(dest for _, dest, _, _ in _ADD_FIELDS), "always"):
        value = getattr(args, key)
        if value is not None:
            op[key] = value
    return op


def _types_for(client: Client, scenario_id: str, args: argparse.Namespace) -> dict[str, Any]:
    """`add` 的节点类型、`set inputs.<名>` 那个节点的节点类型的输入声明。"""
    try:
        document = client.get(f"/orchestrations/{segment(scenario_id)}/head")["document"]
    except (ApiError, KeyError, TypeError):
        return {}
    if args.edit_op == "add":
        package, _, node = args.type.partition("/")
        return _node_inputs(client, document, package, node, args.version, args.agent)
    target = next((n for n in document.get("nodes", []) if n.get("id") == args.node), None)
    if not target or target.get("kind") != "package":
        return {}
    return _node_inputs(
        client, document, target["package"], target["node"], None, target.get("agent")
    )


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
    _operations(args)  # 参数写错时先报错，不去查场景
    scenario = find_scenario(client, args.scenario, command="sfly scenario edit")
    scenario_id, name = scenario["id"], scenario["name"]
    operations = _operations(args, lambda: _types_for(client, scenario_id, args))
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
    elif result.get("unchanged"):
        lines = [f"没有改动，没有存出新版本（场景「{name}」仍是版本 {result['number']}）。"]
        view = {
            "scenario": scenario_id,
            "saved": False,
            "unchanged": True,
            "version": result["number"],
            "base_version": base,
        }
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
    if not result.get("unchanged"):
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
