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
import operator
import pkgutil
import re
import sys
import traceback
import types
import typing
from collections.abc import Mapping, Sequence
from typing import Any

from sfly.nodes import (
    AGENT_MARKER,
    FEISHU_BOT_MARKER,
    NODE_ATTR,
    Chart,
    Doc,
    Metric,
    NodeDeclaration,
    is_context_param,
)


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


#: 扩展输入类型的标记 → 输入 schema 里 `x-sfly-type` 的值：`sfly.AgentName` 是
#: `{"type": "string", "x-sfly-type": "agent"}`，`sfly.FeishuBot` 是
#: `{"type": "string", "x-sfly-type": "feishu_bot"}`。
#: 控制面、画布和本地调试按它识别（packages/orchestration/src/agent-inputs.ts、feishu-bots.ts）。
_INPUT_TYPES = ((AGENT_MARKER, "agent"), (FEISHU_BOT_MARKER, "feishu_bot"))


#: 输入（和输出字段）的说明最多这么多个 Unicode 字符；Python 的 `len` 数的就是 Unicode 字符。
MAX_DOC_LENGTH = 500


def _doc_text(doc: Doc) -> str:
    text = doc.documentation
    if not isinstance(text, str) or not text.strip():
        raise ScanError(f"Doc 必须是非空字符串，收到 {text!r}")
    text = text.strip()
    if len(text) > MAX_DOC_LENGTH:
        raise ScanError(f"说明超过 {MAX_DOC_LENGTH} 个字符（{len(text)} 个），请写短一些")
    return text


def has_doc(hint: Any) -> bool:
    """注解最外层的 `Annotated` 里有没有 `Doc`（不检查内容）。"""
    return typing.get_origin(hint) is typing.Annotated and any(
        isinstance(meta, Doc) for meta in hint.__metadata__
    )


def _annotated(tp: Any, metadata: Sequence[Any]) -> Any:
    """`Annotated[tp, *metadata]`（元数据个数不定，没法直接写成下标）。"""
    return operator.getitem(typing.Annotated, (tp, *metadata))


def split_doc(hint: Any) -> tuple[Any, str | None]:
    """读取注解最外层 `Annotated[T, Doc("…")]` 里的说明，返回（去掉 `Doc` 的注解，说明）。

    没写 `Doc` 时原样返回注解和 None。写错时抛出 ScanError，消息不带位置，由调用方加上
    节点和参数（输出字段）的名字：`Doc` 不是非空字符串、同一个注解里有两个 `Doc`、
    说明超过 `MAX_DOC_LENGTH` 个字符。说明去掉首尾空白。
    去掉 `Doc` 之后，`type_schema` 再遇到 `Doc` 就是写在了内层（`list[...]`、`|` 里面），
    会报错而不是悄悄丢掉。
    """
    if not has_doc(hint):
        return hint, None
    inner, *_ = typing.get_args(hint)
    docs = [meta for meta in hint.__metadata__ if isinstance(meta, Doc)]
    others = [meta for meta in hint.__metadata__ if not isinstance(meta, Doc)]
    if len(docs) > 1:
        raise ScanError(f"同一个注解里有 {len(docs)} 个 Doc，只能写一个")
    text = _doc_text(docs[0])
    return (_annotated(inner, others) if others else inner), text


def type_schema(tp: Any, *, param: bool = False) -> JsonSchema:
    """把类型注解转换为 JSON Schema；不支持的注解抛出 ScanError。

    `param`：是不是节点参数本身的类型。`sfly.AgentName`、`sfly.FeishuBot` 只能直接用作节点参数的类型
    （或 `AgentName | None`），用在别处（列表的元素、字典的值、输出）时报错。
    """
    if tp is Any or tp is inspect.Parameter.empty or tp is object:
        return {}
    if tp is None:
        return {"type": "null"}
    if tp in _SCALARS:
        return dict(_SCALARS[tp])

    origin = typing.get_origin(tp)
    args = typing.get_args(tp)

    if origin is typing.Annotated:
        if has_doc(tp):
            raise ScanError(
                "Doc 只能写在注解的最外层，不能写在 list[...]、| 等的里面；"
                '例如 Annotated[str | None, Doc("…")]'
            )
        for marker, name in _INPUT_TYPES:
            if any(meta is marker for meta in tp.__metadata__):
                if not param:
                    raise ScanError(
                        f"{marker.name} 只能直接用作节点参数的类型（可以写成 {marker.name} | None）"
                    )
                return {"type": "string", "x-sfly-type": name}
        return type_schema(args[0])
    if origin is typing.Union or origin is types.UnionType:
        optional = len(args) == 2 and type(None) in args
        members = [type_schema(a, param=param and optional) for a in args]
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


#: TypedDict 字段注解上的限定符，可以包在 `Annotated` 外面或里面。
#: `get_type_hints` 带 extras 时保留它们。
_FIELD_QUALIFIERS = frozenset({"Required", "NotRequired", "ReadOnly"})


def _is_field_qualifier(hint: Any) -> bool:
    # 按名字认：Python 3.10 上 `NotRequired` 来自 typing_extensions，3.13 之前的 `ReadOnly` 也是。
    return getattr(typing.get_origin(hint), "_name", None) in _FIELD_QUALIFIERS


def _without_field_qualifiers(hint: Any) -> Any:
    """去掉 `Required`、`NotRequired`、`ReadOnly`，`Annotated` 包在它们外面还是里面都行。"""
    while True:
        if _is_field_qualifier(hint):
            hint = typing.get_args(hint)[0]
            continue
        if typing.get_origin(hint) is typing.Annotated:
            inner, *_ = typing.get_args(hint)
            if _is_field_qualifier(inner):
                hint = _annotated(typing.get_args(inner)[0], hint.__metadata__)
                continue
        return hint


def _properties(fields: Mapping[str, Any], where: str = "字段") -> dict[str, JsonSchema]:
    """输出（TypedDict 或 `@node(outputs={...})`）各字段的 schema。

    字段注解最外层的 `Doc` 写成 `description`；出错时消息前面加上 `{where} {字段名}：`。
    """
    properties: dict[str, JsonSchema] = {}
    for key, hint in fields.items():
        try:
            hint, doc = split_doc(_without_field_qualifiers(hint))
            prop = type_schema(hint)
        except ScanError as error:
            raise ScanError(f"{where} {key}：{error}") from None
        if doc is not None:
            prop["description"] = doc
        properties[key] = prop
    return properties


def _typeddict_schema(tp: Any, where: str = "字段") -> JsonSchema:
    hints = typing.get_type_hints(tp, include_extras=True)
    schema: JsonSchema = {"type": "object", "properties": _properties(hints, where)}
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
        if has_doc(hints.get(params[0].name)):
            raise ScanError(f"{label} 的参数 {params[0].name}：任务上下文不是输入，不能写 Doc")
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
            hint, doc = split_doc(hints.get(param.name, inspect.Parameter.empty))
            prop = type_schema(hint, param=True)
        except ScanError as error:
            raise ScanError(f"{where}：{error}") from None
        if doc is not None:
            prop["description"] = doc
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
    where = f"{label} 的输出"
    if decl.outputs is not None:
        if isinstance(decl.outputs, Mapping):
            return {"type": "object", "properties": _properties(decl.outputs, where)}
        if isinstance(decl.outputs, str):
            raise ScanError(f"{where}：outputs 应为键名列表或 键名 → 类型 的字典")
        return {"type": "object", "properties": {key: {} for key in decl.outputs}}
    returns = typing.get_type_hints(fn).get("return")
    if _is_typeddict(returns):
        return _typeddict_schema(returns, where)
    return {"type": "object", "properties": {}}


#: 每个节点类型最多声明的指标数和图表数（与 packages/schema 一致）。
MAX_METRICS = 50
MAX_CHARTS = 20
#: 每个指标最多声明的标签键数（与 packages/schema 一致）。
MAX_LABEL_KEYS = 3
METRIC_KINDS = ("gauge", "counter")
CHART_TYPES = ("line", "area", "bar", "stat")
_METRIC_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def metric_declarations(decl: NodeDeclaration) -> dict[str, Any]:
    """校验并生成指标、图表、主指标的元信息；不满足约束时抛出 ScanError 说明原因。"""
    if len(decl.metrics) > MAX_METRICS:
        raise ScanError(f"每个节点类型最多 {MAX_METRICS} 个指标，声明了 {len(decl.metrics)} 个")
    if len(decl.charts) > MAX_CHARTS:
        raise ScanError(f"每个节点类型最多 {MAX_CHARTS} 张图表，声明了 {len(decl.charts)} 张")

    metrics: list[dict[str, Any]] = []
    names: set[str] = set()
    labeled: set[str] = set()
    for metric in decl.metrics:
        if not isinstance(metric, Metric):
            raise ScanError(f"metrics 的元素必须是 sfly.Metric：{metric!r}")
        if not isinstance(metric.name, str) or not _METRIC_NAME.match(metric.name):
            raise ScanError(
                f"指标名 {metric.name!r} 必须是标识符（字母、数字、下划线，不以数字开头）"
            )
        if metric.name in names:
            raise ScanError(f"指标名 {metric.name} 重复")
        if metric.kind not in METRIC_KINDS:
            raise ScanError(f"指标 {metric.name} 的类型 {metric.kind!r} 必须是 gauge 或 counter")
        if not isinstance(metric.unit, str):
            raise ScanError(f"指标 {metric.name} 的单位必须是字符串")
        names.add(metric.name)
        item: dict[str, Any] = {"name": metric.name, "unit": metric.unit, "kind": metric.kind}
        if metric.description is not None:
            item["description"] = metric.description
        labels = _label_keys(metric)
        if labels:
            item["labels"] = labels
            labeled.add(metric.name)
        metrics.append(item)

    charts: list[dict[str, Any]] = []
    for chart in decl.charts:
        if not isinstance(chart, Chart):
            raise ScanError(f"charts 的元素必须是 sfly.Chart：{chart!r}")
        if not isinstance(chart.title, str) or not chart.title:
            raise ScanError("图表标题不能为空")
        if chart.type not in CHART_TYPES:
            raise ScanError(
                f"图表 {chart.title} 的类型 {chart.type!r} 必须是 line、area、bar 或 stat"
            )
        if isinstance(chart.metrics, str) or not chart.metrics:
            raise ScanError(f"图表 {chart.title} 必须用指标名列表列出至少一个指标")
        for ref in chart.metrics:
            if ref not in names:
                raise ScanError(f"图表 {chart.title} 引用了未声明的指标 {ref}")
            if ref in labeled and chart.type in ("stat", "bar"):
                raise ScanError(
                    f"图表 {chart.title} 是 {chart.type}，不能引用带标签键的指标 {ref}；"
                    "带标签的指标只能画在 line 或 area 图表里"
                )
        charts.append({"title": chart.title, "type": chart.type, "metrics": list(chart.metrics)})

    result: dict[str, Any] = {"metrics": metrics, "charts": charts}
    if decl.primary_metric is not None:
        if decl.primary_metric not in names:
            raise ScanError(f"主指标 {decl.primary_metric} 未声明")
        if decl.primary_metric in labeled:
            raise ScanError(
                f"主指标 {decl.primary_metric} 带标签键，不能作为主指标；"
                "请另报一个不带标签的合计指标作为主指标"
            )
        result["primary_metric"] = decl.primary_metric
    return result


def _label_keys(metric: Metric) -> list[str]:
    if not isinstance(metric.labels, (list, tuple)):
        raise ScanError(f'指标 {metric.name} 的标签键必须是列表，例如 labels=["pid"]')
    if len(metric.labels) > MAX_LABEL_KEYS:
        raise ScanError(
            f"指标 {metric.name} 最多 {MAX_LABEL_KEYS} 个标签键，声明了 {len(metric.labels)} 个"
        )
    keys: list[str] = []
    for key in metric.labels:
        if not isinstance(key, str) or not _METRIC_NAME.match(key):
            raise ScanError(
                f"指标 {metric.name} 的标签键 {key!r} 必须是标识符"
                "（字母、数字、下划线，不以数字开头）"
            )
        if key in keys:
            raise ScanError(f"指标 {metric.name} 的标签键 {key} 重复")
        keys.append(key)
    return keys


#: 节点类型说明（函数的文档字符串）最长多少个 Unicode 字符
#: （与 packages/schema 的 NODE_DESCRIPTION_MAX 一致）。
MAX_NODE_DESCRIPTION = 4000


def node_description(fn: Any, label: str) -> str | None:
    """函数的文档字符串去掉缩进后整段作为节点类型的说明；没有文档字符串或只有空白时返回 None。"""
    description = inspect.cleandoc(fn.__doc__).strip() if fn.__doc__ else ""
    if len(description) > MAX_NODE_DESCRIPTION:
        raise ScanError(
            f"{label}：文档字符串（节点类型的说明）最长 {MAX_NODE_DESCRIPTION} 个字符，"
            f"实际 {len(description)} 个"
        )
    return description or None


def node_metadata(fn: Any, decl: NodeDeclaration) -> dict[str, Any]:
    qualname: str = fn.__qualname__
    label = f"节点 {fn.__module__}.{qualname}"
    if "." in qualname:
        raise ScanError(f"{label}：@node 只能用于模块顶层函数")
    name = decl.name or fn.__name__
    try:
        declarations = metric_declarations(decl)
    except ScanError as error:
        raise ScanError(f"{label}：{error}") from None
    description = node_description(fn, label)
    return {
        "name": name,
        "title": decl.title or name,
        **({"description": description} if description else {}),
        "entry": f"{fn.__module__}:{qualname}",
        "inputs": input_schema(fn, label),
        "outputs": output_schema(fn, decl, label),
        **declarations,
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
