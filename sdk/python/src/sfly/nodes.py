"""`@node` 装饰器：把 Python 函数声明为节点类型。只用标准库（ADR 0002）。

装饰器只记录声明（名称、标题、输出键、指标、图表、主指标），不改变函数本身；
输入/输出 schema 由 `sfly build` 根据类型注解生成，声明也由 `sfly build` 校验。
"""

from __future__ import annotations

import inspect
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Annotated, Any, Literal, TypeVar, overload

from sfly.context import Context

F = TypeVar("F", bound=Callable[..., Any])


class _AgentMarker:
    """`AgentName` 的标记：`sfly build` 据此把输入标成「Agent」类型（schema 的 `x-sfly-type`）。"""

    def __repr__(self) -> str:
        return "sfly.AgentName"


AGENT_MARKER = _AgentMarker()

#: 「Agent」类型的输入：值是 Agent 名称（运行时就是 `str`），表示节点会访问这台 Agent（ADR 0019）。
#: 检查器里显示成 Agent 下拉框；触发前检查它是已注册的 Agent；派发时控制面把它的地址和端口随任务下发
#: 给节点所在的 Agent，节点用 `ctx.agent(名称)` 访问它。只能直接用作节点参数的类型，
#: 可以写成 `AgentName | None`。
AgentName = Annotated[str, AGENT_MARKER]

#: 函数上保存节点声明的属性名。
NODE_ATTR = "__sfly_node__"

#: 输出键声明：键名列表，或键名 → 类型注解。
Outputs = Sequence[str] | Mapping[str, Any]


MetricKind = Literal["gauge", "counter"]
ChartType = Literal["line", "area", "bar", "stat"]


@dataclass(frozen=True)
class Metric:
    """指标声明：名称（标识符）、单位、类型（`gauge` 瞬时值 | `counter` 累计值）、可选说明、
    标签键（最多 3 个，命名规则同指标名）。

    声明了标签键的指标，每次上报都要给全这些键的值（`ctx.metric(name, value, labels={...})`），
    每组不同的标签值是一个序列，运行监控页的折线和面积图里各画一条线；没声明标签键的指标不能带标签。
    """

    name: str
    unit: str = ""
    kind: MetricKind = "gauge"
    description: str | None = None
    labels: Sequence[str] = ()

    def __post_init__(self) -> None:
        # 字符串也是字符序列：labels="pid" 不报错的话会被当成标签键 p、i、d。
        if isinstance(self.labels, str):
            raise TypeError(
                f"指标 {self.name} 的标签键必须是列表，例如 labels=[{self.labels!r}]，"
                f"不能是字符串 {self.labels!r}"
            )


@dataclass(frozen=True)
class Chart:
    """图表声明：标题、图表类型（`line` | `area` | `bar` | `stat`）、用到的指标名。"""

    title: str
    type: ChartType = "line"
    metrics: Sequence[str] = ()


@dataclass(frozen=True)
class NodeDeclaration:
    name: str | None
    title: str | None
    outputs: Outputs | None
    metrics: Sequence[Metric] = ()
    charts: Sequence[Chart] = ()
    primary_metric: str | None = None


@overload
def node(fn: F, /) -> F: ...


@overload
def node(
    *,
    name: str | None = None,
    title: str | None = None,
    outputs: Outputs | None = None,
    metrics: Sequence[Metric] = (),
    charts: Sequence[Chart] = (),
    primary_metric: str | None = None,
) -> Callable[[F], F]: ...


def node(
    fn: F | None = None,
    /,
    *,
    name: str | None = None,
    title: str | None = None,
    outputs: Outputs | None = None,
    metrics: Sequence[Metric] = (),
    charts: Sequence[Chart] = (),
    primary_metric: str | None = None,
) -> F | Callable[[F], F]:
    """声明一个节点类型。

    - 输入：函数参数（首个参数若名为 `ctx` 或注解为 `Context`，则是任务上下文，不算输入）。
    - 输出：`outputs` 声明的键；未声明时若返回类型注解是 TypedDict，则从中读取。
    - `name` 默认为函数名，`title` 默认为节点名。
    - `metrics`：节点运行时上报的指标；`charts`：怎么把指标画出来（没被任何图表引用的指标由
      平台生成默认图表）；`primary_metric`：在紧凑位置显示的主指标，必须是已声明的指标名。
    """

    def decorate(f: F) -> F:
        decl = NodeDeclaration(
            name=name,
            title=title,
            outputs=outputs,
            metrics=tuple(metrics),
            charts=tuple(charts),
            primary_metric=primary_metric,
        )
        setattr(f, NODE_ATTR, decl)
        return f

    if fn is not None:
        return decorate(fn)
    return decorate


def is_context_param(param: inspect.Parameter, hint: Any) -> bool:
    """节点函数的首个参数是否为任务上下文：注解为 `Context`，或名为 `ctx` 且没有注解。"""
    if hint is Context:
        return True
    return param.name == "ctx" and param.annotation is inspect.Parameter.empty
