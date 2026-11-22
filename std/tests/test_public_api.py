"""公开的辅助函数的约定（ADR 0030）：每个都有文档字符串和类型标注，从写明的模块导入，
内部模块不被外部引用；兼容性承诺里说的接口都在 `__all__` 里。"""

from __future__ import annotations

import ast
import dataclasses
import importlib
import inspect
import re
import typing
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

import sfly_std

PACKAGE = Path(sfly_std.__file__).parent
REPO = PACKAGE.parents[2]

#: 公开的辅助函数所在的模块（`sfly_std/__init__.py` 的文档字符串里列出的那些）。
PUBLIC_MODULES = [
    "sfly_std.commands",
    "sfly_std.processes",
    "sfly_std.resources",
    "sfly_std.logs",
    "sfly_std.waiting",
    "sfly_std.agent_files",
]


def public_names(module: ModuleType) -> list[tuple[str, Any]]:
    return [(name, getattr(module, name)) for name in module.__all__]


def public_callables() -> list[tuple[str, Any]]:
    found = []
    for module_name in PUBLIC_MODULES:
        module = importlib.import_module(module_name)
        for name, obj in public_names(module):
            if inspect.isfunction(obj) or inspect.isclass(obj):
                found.append((f"{module_name}.{name}", obj))
    return found


def own_methods(cls: type) -> list[Any]:
    """类自己定义的公开方法（不含下划线开头的、继承来的和数据类生成的）。"""
    if dataclasses.is_dataclass(cls) or issubclass(cls, Exception) or cls.__module__ == "typing":
        return []
    return [
        member
        for name, member in vars(cls).items()
        if inspect.isfunction(member) and not name.startswith("_")
    ]


def test_the_package_docstring_lists_every_public_module() -> None:
    doc = sfly_std.__doc__ or ""
    for module_name in PUBLIC_MODULES:
        assert f"`{module_name}`" in doc, f"{module_name} 没有写进 sfly_std 的文档字符串"
    assert "兼容性承诺" in doc


@pytest.mark.parametrize("module_name", PUBLIC_MODULES)
def test_all_is_sorted_and_every_listed_name_exists(module_name: str) -> None:
    module = importlib.import_module(module_name)

    assert module.__doc__ and module.__doc__.strip(), f"{module_name} 没有模块文档字符串"
    assert list(module.__all__) == sorted(module.__all__, key=_all_order)
    for name in module.__all__:
        assert hasattr(module, name), f"{module_name}.__all__ 里的 {name} 不存在"


def _all_order(name: str) -> tuple[int, str]:
    """常量（全大写）在前，然后是类和函数，各按字母顺序（ruff 的 RUF022 排序规则）。"""
    return (0 if name.isupper() or "_" in name and name.upper() == name else 1, name)


@pytest.mark.parametrize(
    ("name", "obj"), public_callables(), ids=lambda v: v if isinstance(v, str) else ""
)
def test_every_public_function_and_class_has_a_docstring_and_full_type_annotations(
    name: str, obj: Any
) -> None:
    assert obj.__doc__ and obj.__doc__.strip(), f"{name} 没有文档字符串"
    callables = [obj] if inspect.isfunction(obj) else [*own_methods(obj)]
    if inspect.isclass(obj) and "__init__" in vars(obj) and not issubclass(obj, Exception):
        callables.append(vars(obj)["__init__"])
    for fn in callables:
        hints = typing.get_type_hints(fn)
        signature = inspect.signature(fn)
        for parameter in signature.parameters.values():
            if parameter.name in {"self", "cls"}:
                continue
            assert parameter.name in hints, f"{name}：参数 {parameter.name} 没有类型标注"
        assert "return" in hints, f"{name}：{fn.__name__} 没有返回值的类型标注"
        if inspect.isfunction(obj):
            assert fn.__doc__, name


@pytest.mark.parametrize(
    ("name", "obj"), public_callables(), ids=lambda v: v if isinstance(v, str) else ""
)
def test_new_parameters_are_keyword_only_so_they_can_be_added_compatibly(
    name: str, obj: Any
) -> None:
    # 兼容性承诺：新增的参数只能是带默认值的关键字参数；所以除了开头几个必填的位置参数，
    # 其余参数都必须写成关键字参数（`*` 之后）。
    if not inspect.isfunction(obj):
        return
    positional = [
        p for p in inspect.signature(obj).parameters.values() if p.kind is p.POSITIONAL_OR_KEYWORD
    ]
    assert all(p.default is p.empty for p in positional), (
        f"{name}：有默认值的参数 {[p.name for p in positional if p.default is not p.empty]} "
        "要放在 * 之后，这样以后加参数不改变位置参数的顺序"
    )


def test_public_data_classes_are_frozen_so_fields_can_only_be_added() -> None:
    for name, obj in public_callables():
        if inspect.isclass(obj) and dataclasses.is_dataclass(obj):
            assert obj.__dataclass_params__.frozen, f"{name} 应该是 frozen 的数据类"  # type: ignore[attr-defined]


def test_nothing_outside_the_package_imports_an_internal_module() -> None:
    # 内部模块（下划线开头）随时可能改：包外（平台的测试、文档里的示例、技能）不能导入。
    pattern = re.compile(r"(?:from|import)\s+sfly_std\._\w+|from\s+sfly_std\s+import\s+_\w+")
    offenders = []
    roots = [REPO / "docs", REPO / "apps", REPO / "sdk", REPO / "testdata", REPO / "agent"]
    for root in roots:
        for path in root.rglob("*"):
            if path.is_file() and path.suffix in {".md", ".py", ".ts", ".json", ".rs"}:
                if "node_modules" in path.parts or "generated" in path.parts:
                    continue
                text = path.read_text(encoding="utf-8", errors="ignore")
                if pattern.search(text):
                    offenders.append(str(path.relative_to(REPO)))
    assert offenders == []


def declares_nodes(path: Path) -> bool:
    """模块里有没有用 `@node(...)` 装饰的函数（文档字符串里的示例不算）。"""
    for item in ast.parse(path.read_text(encoding="utf-8")).body:
        if isinstance(item, ast.FunctionDef):
            for decorator in item.decorator_list:
                call = decorator.func if isinstance(decorator, ast.Call) else decorator
                if isinstance(call, ast.Name) and call.id == "node":
                    return True
    return False


def test_node_modules_do_not_define_helpers_other_modules_would_have_to_import() -> None:
    # 节点模块（用 @node 声明的）只是外壳：别的模块不从节点模块里导入辅助函数或常量，
    # 要共用的东西放在公开的辅助函数模块里（异常类的同名子类除外，见 ADR 0030）。
    node_modules = {
        path.stem
        for path in PACKAGE.glob("*.py")
        if not path.name.startswith("_") and declares_nodes(path)
    }
    offenders = []
    for path in PACKAGE.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module is not None:
                target = node.module.removeprefix("sfly_std.")
                if node.module.startswith("sfly_std.") and target in node_modules:
                    offenders.append(f"{path.name} 从节点模块 {target} 导入")
    assert offenders == []
