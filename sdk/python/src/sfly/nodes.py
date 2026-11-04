"""`@node` 装饰器：把 Python 函数声明为节点类型。只用标准库（ADR 0002）。

装饰器只记录声明（名称、标题、输出键），不改变函数本身；
输入/输出 schema 由 `sfly build` 根据类型注解生成。
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, TypeVar, overload

F = TypeVar("F", bound=Callable[..., Any])

#: 函数上保存节点声明的属性名。
NODE_ATTR = "__sfly_node__"

#: 输出键声明：键名列表，或键名 → 类型注解。
Outputs = Sequence[str] | Mapping[str, Any]


@dataclass(frozen=True)
class NodeDeclaration:
    name: str | None
    title: str | None
    outputs: Outputs | None


@overload
def node(fn: F, /) -> F: ...


@overload
def node(
    *, name: str | None = None, title: str | None = None, outputs: Outputs | None = None
) -> Callable[[F], F]: ...


def node(
    fn: F | None = None,
    /,
    *,
    name: str | None = None,
    title: str | None = None,
    outputs: Outputs | None = None,
) -> F | Callable[[F], F]:
    """声明一个节点类型。

    - 输入：函数参数（首个参数若名为 `ctx` 或注解为 `Context`，则是任务上下文，不算输入）。
    - 输出：`outputs` 声明的键；未声明时若返回类型注解是 TypedDict，则从中读取。
    - `name` 默认为函数名，`title` 默认为节点名。
    """

    def decorate(f: F) -> F:
        setattr(f, NODE_ATTR, NodeDeclaration(name=name, title=title, outputs=outputs))
        return f

    if fn is not None:
        return decorate(fn)
    return decorate
