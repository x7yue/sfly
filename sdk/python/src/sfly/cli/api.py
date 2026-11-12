"""`sfly api`：直接调用控制面的接口，补 `sfly` 里没有专门命令的操作；`--list` 列出全部接口。

接口来自随 SDK 打包的路由清单（`routes.py`）：发请求前按清单校验方法、路径、查询参数和请求体，
对不上就在命令行里报错（并列出最接近的路由），不用发出去才知道。
清单只覆盖 JSON Schema 表达得了的约束，自定义校验和转换后的约束由控制面校验，
控制面的错误响应会原样带回来。
请求带公共的昵称和 `x-sfly-client` 请求头（见 `client.py`），响应原样写到 stdout。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Mapping, Sequence
from http.client import HTTPException
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from sfly.cli.client import ApiError
from sfly.cli.errors import CliError
from sfly.cli.output import dump_json, format_table
from sfly.cli.routes import KIND_LABELS, Resolution, Route, closest, load_routes, resolve
from sfly.cli.session import Session, command, common_options

DEFAULT_TIMEOUT_SECONDS = 30.0
_MAX_PROBLEMS = 10
_CHUNK = 64 * 1024
_STDIN = "-"
_ACCEPT = {"stream": "text/event-stream", "download": "*/*"}


def register(sub: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    parser = sub.add_parser(
        "api",
        parents=[common_options()],
        help="直接调用控制面的接口（按路由清单校验）；--list 列出全部接口",
        description="调用控制面的接口：sfly api <METHOD> <路径> [--query 名=值]… "
        "[--body JSON 或 @文件]。路径是带实际 id 的路径，不含 /api 前缀，例如 GET /runs/<运行 id>。"
        "发请求前按路由清单校验方法、路径、查询参数和请求体；对不上时报错并列出最接近的路由。"
        "响应原样写到 stdout（普通接口是 JSON，下载是文件内容，可以重定向到文件，"
        "SSE 读到 --timeout 秒或连接结束为止）。控制面返回错误时，错误码、说明和 details 写到"
        " stderr。"
        "--list 列出全部接口，后面可以跟关键字筛选，加 --json 看每个接口完整的 JSON Schema。"
        "退出码：成功 0，命令出错或接口返回错误 2，按 Ctrl-C 停止 130。",
    )
    parser.add_argument(
        "target",
        nargs="*",
        metavar="METHOD 路径",
        help="请求方法和路径；--list 时是筛选用的关键字（要同时出现在 `方法 路径模板` 里）",
    )
    parser.add_argument("--list", action="store_true", help="列出路由清单里的全部接口")
    parser.add_argument(
        "--query",
        action="append",
        default=[],
        metavar="名=值",
        help="查询参数，可以重复给出（也可以直接写在路径后面：/runs?limit=5）",
    )
    parser.add_argument(
        "--body",
        metavar="JSON 或 @文件",
        help="请求体：JSON 文本，或 @文件 从文件读（@- 从标准输入读）",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        metavar="秒",
        help=f"请求的超时（默认 {DEFAULT_TIMEOUT_SECONDS:g}）；SSE 读到这么久就停止并正常退出",
    )
    parser.set_defaults(func=command(_api))


def _api(session: Session, args: argparse.Namespace) -> int:
    routes = load_routes()
    if args.list:
        return _list(session, routes, args.target)
    if len(args.target) != 2:
        raise CliError(
            "invalid_arguments",
            "用法：sfly api <METHOD> <路径> [--query 名=值]… [--body JSON 或 @文件]",
            next="sfly api --list",
        )
    method, raw_path = args.target[0].upper(), args.target[1]
    path, inline_query = _split_path(raw_path)
    route, params = _locate(routes, method, path)
    query = _parse_query(args.query, inline_query)
    problems = [
        *_check_params(route, params),
        *_check_query(route, query),
    ]
    body, body_problems = _read_body(route, args.body)
    problems.extend(body_problems)
    if problems:
        raise _invalid_request(route, problems)
    if route.kind == "upload":
        raise _upload_unsupported(route)
    return _send(session, route, method, path, query, body, args.timeout)


# ---------------------------------------------------------------- 列出


def _list(session: Session, routes: Sequence[Route], words: Sequence[str]) -> int:
    shown = [
        route
        for route in routes
        if all(word.lower() in f"{route.method} {route.path}".lower() for word in words)
    ]
    if not shown:
        raise CliError(
            "no_route",
            f"没有接口匹配 {' '.join(words)}",
            next="sfly api --list",
        )
    rows = [
        [route.method, route.path, KIND_LABELS.get(route.kind, route.kind), _fields(route)]
        for route in shown
    ]
    text = format_table(["方法", "路径", "种类", "参数（* 必填）"], rows)
    note = (
        "路径里的 :名称 换成实际的值，末尾的 * 是剩余路径。"
        "sfly api --list <关键字> --json 输出匹配接口完整的 JSON Schema。"
    )
    session.out.emit([route.to_json() for route in shown], f"{text}\n{note}")
    return 0


def _fields(route: Route) -> str:
    parts = []
    for name, schema in (("query", route.query), ("body", route.body)):
        if schema is not None:
            parts.append(f"{name}: {_field_names(schema)}")
    return "；".join(parts) if parts else "-"


def _field_names(schema: Mapping[str, Any]) -> str:
    properties = schema.get("properties")
    if not isinstance(properties, dict) or not properties:
        return "JSON"
    required = set(schema.get("required", ()))
    return ", ".join(f"{name}{'*' if name in required else ''}" for name in properties)


# ---------------------------------------------------------------- 路径


def _split_path(raw: str) -> tuple[str, list[tuple[str, str]]]:
    """路径和写在路径后面的查询参数。"""
    if not raw.startswith("/"):
        raise CliError(
            "invalid_path",
            f"路径要以 / 开头，收到 {raw!r}（不含 /api 前缀，例如 GET /runs）",
            next="sfly api --list",
        )
    parts = urlsplit(raw)
    return parts.path, parse_qsl(parts.query, keep_blank_values=True)


def _locate(routes: Sequence[Route], method: str, path: str) -> tuple[Route, dict[str, str]]:
    resolution = resolve(routes, method, path)
    if resolution.route is not None:
        for value in resolution.params.values():
            if value.startswith(":") or value == "*":
                raise CliError(
                    "invalid_path",
                    f"路径里的 {value} 是清单里的占位符，换成实际的值：{path}",
                    next="sfly api --list",
                )
        return resolution.route, resolution.params
    raise _not_in_manifest(routes, method, path, resolution)


def _not_in_manifest(
    routes: Sequence[Route], method: str, path: str, resolution: Resolution
) -> CliError:
    if resolution.other_methods:
        allowed = "、".join(resolution.other_methods)
        return CliError(
            "method_not_allowed",
            f"路由清单里 {path} 不支持 {method}，支持的方法：{allowed}",
            next="sfly api --list",
        )
    near = closest(routes, method, path)
    lines = [f"路由清单里没有 {method} {path}"]
    if near:
        lines.append("最接近的路由：")
        lines.extend(f"  {route.method} {route.path}" for route in near)
    return CliError("route_not_found", "\n".join(lines), next="sfly api --list")


# ---------------------------------------------------------------- 校验


def _parse_query(options: Sequence[str], inline: Sequence[tuple[str, str]]) -> dict[str, str]:
    query: dict[str, str] = {}
    pairs = [*inline]
    for option in options:
        name, sep, value = option.partition("=")
        if not sep or not name:
            raise CliError(
                "invalid_query", f"--query 的格式是 名=值，收到 {option!r}", next="sfly api --help"
            )
        pairs.append((name, value))
    for name, value in pairs:
        if name in query:
            raise CliError("invalid_query", f"查询参数 {name} 给了不止一次")
        query[name] = value
    return query


def _check_params(route: Route, params: Mapping[str, str]) -> list[str]:
    if route.params is None:
        return []
    return _validate("params", route.params, dict(params))


def _check_query(route: Route, query: Mapping[str, str]) -> list[str]:
    if not query:
        return []
    names = "、".join(query)
    schema = route.query
    if schema is None:
        return [f"query：这个接口没有查询参数，去掉 --query（给了 {names}）"]
    declared = _declared_names(schema)
    if declared is not None and not _allows_extra(schema):
        unknown = sorted(name for name in query if name not in declared)
        if unknown:
            known = "、".join(sorted(declared)) or "没有"
            return [f"query：不认识的查询参数 {'、'.join(unknown)}（接受：{known}）"]
    return _validate("query", schema, _typed_query(schema, query))


def _declared_names(schema: Mapping[str, Any]) -> set[str] | None:
    properties = schema.get("properties")
    return set(properties) if isinstance(properties, dict) else None


def _allows_extra(schema: Mapping[str, Any]) -> bool:
    extra = schema.get("additionalProperties")
    return extra is True or isinstance(extra, dict)


def _typed_query(schema: Mapping[str, Any], query: Mapping[str, str]) -> dict[str, Any]:
    """查询参数在 URL 里是文本；schema 要求数字或布尔值的，按文本解析成对应的值再校验。
    解析不了的原样留着，校验时会报类型不对。"""
    properties = schema.get("properties", {})
    typed: dict[str, Any] = {}
    for name, text in query.items():
        wanted = properties.get(name, {}).get("type") if isinstance(properties, dict) else None
        typed[name] = _convert(text, wanted)
    return typed


def _convert(text: str, wanted: Any) -> Any:
    kinds = wanted if isinstance(wanted, list) else [wanted]
    if "string" in kinds:
        return text
    if "integer" in kinds:
        try:
            return int(text)
        except ValueError:
            pass
    if "integer" in kinds or "number" in kinds:
        try:
            return float(text)
        except ValueError:
            return text
    if "boolean" in kinds and text in ("true", "false"):
        return text == "true"
    return text


def _read_body(route: Route, option: str | None) -> tuple[Any, list[str]]:
    """读 `--body`，按清单校验；返回（请求体，问题列表）。"""
    if route.kind == "upload":
        return None, []
    if option is None:
        required = route.body.get("required") if route.body else None
        if required:
            return None, [f"body：缺少 --body，必填字段：{'、'.join(required)}"]
        return None, []
    if route.body is None:
        return None, ["body：这个接口没有请求体，去掉 --body"]
    body = _parse_body(option)
    return body, _validate("body", route.body, body)


def _parse_body(option: str) -> Any:
    if option.startswith("@"):
        source = option[1:]
        try:
            text = (
                sys.stdin.read()
                if source == _STDIN
                else Path(source).expanduser().read_text(encoding="utf-8")
            )
        except (OSError, UnicodeDecodeError) as error:
            raise CliError("invalid_body", f"读不了 --body 的文件 {source}：{error}") from None
    else:
        text = option
    try:
        return json.loads(text)
    except ValueError as error:
        raise CliError(
            "invalid_body", f"--body 不是合法的 JSON：{error}（文件用 --body @文件）"
        ) from None


def _validate(part: str, schema: Mapping[str, Any], value: Any) -> list[str]:
    """按 JSON Schema 校验，返回问题列表（每条以 `part.字段路径` 开头）。"""
    from jsonschema import Draft202012Validator

    problems: list[str] = []
    for error in Draft202012Validator(schema).iter_errors(value):
        problems.extend(_describe(part, error))
    return sorted(set(problems))


def _describe(part: str, error: Any) -> list[str]:
    from jsonschema.exceptions import best_match

    if error.validator in ("anyOf", "oneOf") and error.context:
        return _describe(part, best_match(error.context))
    where = ".".join([part, *(str(step) for step in error.absolute_path)])
    validator = error.validator
    if validator == "required":
        missing = [name for name in error.validator_value if name not in error.instance]
        return [f"{where}：缺少必填字段 {name}" for name in missing]
    if validator == "additionalProperties":
        known = set(error.schema.get("properties", {}))
        extra = sorted(name for name in error.instance if name not in known)
        names = "、".join(extra)
        return [f"{where}：不认识的字段 {names}（接受：{'、'.join(sorted(known)) or '没有'}）"]
    if validator == "type":
        return [f"{where}：需要 {error.validator_value}，收到 {_type_name(error.instance)}"]
    if validator == "enum":
        options = "、".join(json.dumps(item, ensure_ascii=False) for item in error.validator_value)
        return [f"{where}：取值要是 {options} 之一"]
    return [f"{where}：{error.message}"]


def _type_name(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if value is None:
        return "null"
    if isinstance(value, int):
        return "integer"
    return {float: "number", str: "string", list: "array", dict: "object"}.get(
        type(value), type(value).__name__
    )


def _invalid_request(route: Route, problems: Sequence[str]) -> CliError:
    shown = list(problems[:_MAX_PROBLEMS])
    if len(problems) > _MAX_PROBLEMS:
        shown.append(f"……还有 {len(problems) - _MAX_PROBLEMS} 个问题")
    head = f"请求不符合路由清单里 {route.method} {route.path} 的要求："
    return CliError(
        "invalid_request",
        "\n".join([head, *(f"  {line}" for line in shown)]),
        next=f"sfly api --list {route.method} {route.path} --json",
    )


def _upload_unsupported(route: Route) -> CliError:
    publish = route.key == ("packages", "publish")
    return CliError(
        "upload_unsupported",
        f"{route.method} {route.path} 的请求体是原始字节，sfly api 不支持上传",
        next="sfly publish <节点包文件或项目目录>" if publish else None,
    )


# ---------------------------------------------------------------- 发请求


def _send(
    session: Session,
    route: Route,
    method: str,
    path: str,
    query: Mapping[str, str],
    body: Any,
    timeout: float,
) -> int:
    accept = _ACCEPT.get(route.kind)
    headers = {"Accept": accept} if accept else None
    try:
        with session.client.open(
            method, path, query=query, body=body, headers=headers, timeout=timeout
        ) as response:
            if route.kind == "stream":
                return _copy_stream(session, response, timeout)
            return _copy_body(session, response)
    except ApiError as error:
        raise _with_details(error) from None
    except KeyboardInterrupt:
        return 130
    except (OSError, HTTPException) as error:
        raise CliError("read_failed", f"读取控制面的响应时出错：{error}") from None


def _with_details(error: ApiError) -> ApiError:
    message = f"HTTP {error.status} {error.message}"
    if error.details is not None:
        message += f"\ndetails：{dump_json(error.details)}"
    return ApiError(error.status, error.code, message, error.details, error.next)


def _copy_body(session: Session, response: Any) -> int:
    """响应体原样写到 stdout（二进制写 buffer，没有 buffer 时按 UTF-8 解码）；
    JSON 响应没有结尾换行时补一个。"""
    stdout = session.out.stdout
    buffer = getattr(stdout, "buffer", None)
    last = b""
    stdout.flush()
    while chunk := response.read(_CHUNK):
        if buffer is not None:
            buffer.write(chunk)
        else:
            stdout.write(chunk.decode("utf-8", "replace"))
        last = chunk
    if buffer is not None:
        buffer.flush()
    if (
        last
        and not last.endswith(b"\n")
        and response.headers.get_content_type() == "application/json"
    ):
        stdout.write("\n")
    stdout.flush()
    return 0


def _copy_stream(session: Session, response: Any, timeout: float) -> int:
    """SSE 一行一行原样写到 stdout，读到连接结束或 `timeout` 秒为止。"""
    stdout = session.out.stdout
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            line = response.readline()
        except TimeoutError:
            break
        if not line:
            return 0
        stdout.write(line.decode("utf-8", "replace"))
        stdout.flush()
    print(
        f"已读取 {timeout:g} 秒，到 --timeout 的时间，停止读取（事件流还在继续）",
        file=session.out.stderr,
    )
    return 0
