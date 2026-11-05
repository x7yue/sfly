"""扫描用户代码中的 `@node`，按类型注解生成节点类型元信息。

由 `sfly build` 在独立子进程中运行（`python -m sfly.cli.scan <源码根> <顶层模块>`），
避免导入用户代码污染 CLI 进程。结果以 JSON 写到标准输出；出错时把原因写到标准错误并以 1 退出。
只用标准库。
"""

from __future__ import annotations

import enum
import importlib
import inspect
import json
import pkgutil
import sys
import traceback
import types
import typing
from collections.abc import Mapping, Sequence
from typing import Any

from sfly.nodes import NODE_ATTR, NodeDeclaration, is_context_param


class ScanError(Exception):
    pass


JsonSchema = dict[str, Any]

_SCALARS: dict[Any, JsonSchema] = {
    str: {"type": "string"},
    bool: {"type": "boolean"},
    int: {"type": "integer"},
    float: {"type": "number"},
    type(None): {"type": "null"},
}


def _is_typeddict(tp: Any) -> bool:
    return isinstance(tp, type) and issubclass(tp, dict) and hasattr(tp, "__required_keys__")


def type_schema(tp: Any) -> JsonSchema:
    """把类型注解转换为 JSON Schema；不支持的注解抛出 ScanError。"""
    if tp is Any or tp is inspect.Parameter.empty or tp is object:
        return {}
    if tp is None:
        return {"type": "null"}
    if tp in _SCALARS:
        return dict(_SCALARS[tp])

    origin = typing.get_origin(tp)
    args = typing.get_args(tp)

    if origin is typing.Annotated:
        return type_schema(args[0])
    if origin is typing.Union or origin is types.UnionType:
        members = [type_schema(a) for a in args]
        if any(m == {} for m in members):
            return {}
        return {"anyOf": members}
    if origin is typing.Literal:
        return {"enum": list(args)}
    if tp in (dict, Mapping) or origin in (dict, Mapping):
        schema: JsonSchema = {"type": "object"}
        if len(args) == 2:
            if args[0] is not str:
                raise ScanError(f"字典的键必须是 str：{tp!r}")
            values = type_schema(args[1])
            if values:
                schema["additionalProperties"] = values
        return schema
    if tp in (list, Sequence) or origin in (list, Sequence):
        schema = {"type": "array"}
        if args:
            items = type_schema(args[0])
            if items:
                schema["items"] = items
        return schema
    if _is_typeddict(tp):
        return _typeddict_schema(tp)
    if isinstance(tp, type) and issubclass(tp, enum.Enum):
        return {"enum": [m.value for m in tp]}
    raise ScanError(f"不支持的类型注解：{tp!r}")


def _typeddict_schema(tp: Any) -> JsonSchema:
    hints = typing.get_type_hints(tp)
    schema: JsonSchema = {
        "type": "object",
        "properties": {key: type_schema(hint) for key, hint in hints.items()},
    }
    required = [key for key in hints if key in tp.__required_keys__]
    if required:
        schema["required"] = required
    return schema


def _json_default(value: Any, where: str) -> Any:
    if isinstance(value, enum.Enum):
        value = value.value
    try:
        json.dumps(value)
    except (TypeError, ValueError) as error:
        raise ScanError(f"{where} 的默认值不能序列化为 JSON：{value!r}") from error
    return value


def input_schema(fn: Any, label: str) -> JsonSchema:
    hints = typing.get_type_hints(fn, include_extras=True)
    params = list(inspect.signature(fn).parameters.values())
    if params and is_context_param(params[0], hints.get(params[0].name)):
        params = params[1:]

    properties: dict[str, JsonSchema] = {}
    required: list[str] = []
    for param in params:
        where = f"{label} 的参数 {param.name}"
        if param.kind not in (param.POSITIONAL_OR_KEYWORD, param.KEYWORD_ONLY):
            raise ScanError(
                f"{where}：节点参数必须能按名称传入（不支持 *args、**kwargs、仅位置参数）"
            )
        try:
            prop = type_schema(hints.get(param.name, inspect.Parameter.empty))
        except ScanError as error:
            raise ScanError(f"{where}：{error}") from None
        if param.default is inspect.Parameter.empty:
            required.append(param.name)
        else:
            prop["default"] = _json_default(param.default, where)
        properties[param.name] = prop

    schema: JsonSchema = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    # 控制面把元信息存进 PostgreSQL JSONB，对象键顺序会丢失；参数表单按 order 排列。
    schema["order"] = list(properties)
    return schema


def output_schema(fn: Any, decl: NodeDeclaration, label: str) -> JsonSchema:
    try:
        if decl.outputs is not None:
            if isinstance(decl.outputs, Mapping):
                props = {key: type_schema(tp) for key, tp in decl.outputs.items()}
            elif isinstance(decl.outputs, str):
                raise ScanError("outputs 应为键名列表或 键名 → 类型 的字典")
            else:
                props = {key: {} for key in decl.outputs}
            return {"type": "object", "properties": props}
        returns = typing.get_type_hints(fn).get("return")
        if _is_typeddict(returns):
            return _typeddict_schema(returns)
    except ScanError as error:
        raise ScanError(f"{label} 的输出：{error}") from None
    return {"type": "object", "properties": {}}


def node_metadata(fn: Any, decl: NodeDeclaration) -> dict[str, Any]:
    qualname: str = fn.__qualname__
    label = f"节点 {fn.__module__}.{qualname}"
    if "." in qualname:
        raise ScanError(f"{label}：@node 只能用于模块顶层函数")
    name = decl.name or fn.__name__
    return {
        "name": name,
        "title": decl.title or name,
        "entry": f"{fn.__module__}:{qualname}",
        "inputs": input_schema(fn, label),
        "outputs": output_schema(fn, decl, label),
    }


def _iter_modules(top: str) -> list[types.ModuleType]:
    root = importlib.import_module(top)
    modules = [root]
    if hasattr(root, "__path__"):

        def onerror(name: str) -> None:
            raise ScanError(f"导入模块 {name} 失败")

        for info in pkgutil.walk_packages(root.__path__, prefix=f"{top}.", onerror=onerror):
            modules.append(importlib.import_module(info.name))
    return modules


def scan(source_root: str, top: str) -> list[dict[str, Any]]:
    """导入 `top` 及其全部子模块，返回其中 `@node` 声明的节点类型元信息（按模块、定义顺序）。"""
    sys.path.insert(0, source_root)
    nodes: list[dict[str, Any]] = []
    seen: dict[str, str] = {}
    for module in _iter_modules(top):
        for value in vars(module).values():
            decl = getattr(value, NODE_ATTR, None)
            if not isinstance(decl, NodeDeclaration) or value.__module__ != module.__name__:
                continue
            meta = node_metadata(value, decl)
            if meta["name"] in seen:
                raise ScanError(
                    f"节点名 {meta['name']} 重复：{seen[meta['name']]} 和 {meta['entry']}"
                )
            seen[meta["name"]] = meta["entry"]
            nodes.append(meta)
    return nodes


def main(argv: list[str]) -> int:
    source_root, top = argv
    try:
        nodes = scan(source_root, top)
    except ScanError as error:
        print(error, file=sys.stderr)
        return 1
    except Exception:
        print(f"导入节点代码失败：\n{traceback.format_exc()}", file=sys.stderr)
        return 1
    json.dump(nodes, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
