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
from public_api_snapshot import (
    PUBLIC_MODULES,
    SNAPSHOT,
    compare,
    current,
    parse,
    render,
)

import sfly_std

PACKAGE = Path(sfly_std.__file__).parent
REPO = PACKAGE.parents[2]


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


@pytest.mark.parametrize("module_name", PUBLIC_MODULES)
def test_every_public_name_is_defined_in_the_module_that_lists_it(module_name: str) -> None:
    # `ProcessTarget` 曾经定义在内部模块里再从 `processes` 导出：用户在补全、报错里看到的路径是
    # 内部的，搬家时会连带破坏 pickle、日志里的类型名。公开的名字就定义在公开的模块里。
    module = importlib.import_module(module_name)
    for name, obj in public_names(module):
        if inspect.isfunction(obj) or inspect.isclass(obj):
            assert obj.__module__ == module_name, f"{name} 定义在 {obj.__module__}"


@pytest.mark.parametrize("module_name", PUBLIC_MODULES)
def test_a_class_or_function_without_an_underscore_is_part_of_the_promise(
    module_name: str,
) -> None:
    # 规则写的是「不在 `__all__` 里的就是内部的」，但用户从补全里看到一个不带下划线、名字又通用的
    # 函数就会用：本模块定义的函数和类，要么在 `__all__` 里（承诺），要么以下划线开头（内部）。
    module = importlib.import_module(module_name)
    undeclared = [
        name
        for name, obj in vars(module).items()
        if (inspect.isfunction(obj) or inspect.isclass(obj))
        and getattr(obj, "__module__", None) == module_name
        and not name.startswith("_")
        and name not in module.__all__
    ]
    assert undeclared == [], f"{module_name} 里没有下划线又不在 __all__ 里：{undeclared}"


def test_the_committed_snapshot_matches_the_public_signatures() -> None:
    # 兼容性承诺：公开的接口只做向后兼容的改动。快照提交在仓库里：改接口必须同时改快照，
    # 评审的人一眼看得见；更新快照的办法写在 `public_api_snapshot.py` 的文档字符串里。
    committed = parse(SNAPSHOT.read_text(encoding="utf-8"))
    diff = compare(committed, current())

    assert diff.breaking == [], (
        "这违反兼容性承诺（一台 Agent 上只有一个 sfly-std，旧的节点包还在用旧的接口）；"
        "确实要改就加一个新名字的函数、类，旧的留着。如果评审认可这次不兼容的改动，"
        "再用 `uv run python std/tests/public_api_snapshot.py --write` 更新快照：\n"
        + "\n".join(diff.breaking)
    )
    assert diff.added == [], (
        "公开接口有新增（兼容的改动），把它们记进快照："
        "`uv run python std/tests/public_api_snapshot.py --write`：\n" + "\n".join(diff.added)
    )
    assert render(current()) == SNAPSHOT.read_text(encoding="utf-8")


def snapshot_of(text: str) -> dict[str, list[str]]:
    return parse(text.strip("\n") + "\n")


SIGNATURE = """
function sfly_std.a.f -> Result
  pos ctx: Context
  pos name: str
  kw wait: float = 1.0
  kw poll: float = 0.5
dataclass sfly_std.a.Result frozen
  field count: int
  field size: int = 0
exception sfly_std.a.Failed(Exception)
constant sfly_std.a.METRICS = tuple
  metric cpu kind=gauge labels=()
  metric mem kind=gauge labels=()
"""


@pytest.mark.parametrize(
    ("changed", "expected"),
    [
        ("kw wait: float = 1.0\n  kw poll: float = 0.5", "kw poll: float = 0.5"),  # 删除参数
        ("kw poll: float = 0.5", "kw gap: float = 0.5"),  # 改名
        ("kw wait: float = 1.0", "kw wait: float = 2.0"),  # 改默认值
        ("kw wait: float = 1.0", "kw wait: int = 1.0"),  # 改类型标注
        ("pos name: str", "kw name: str"),  # 改参数的种类
        ("function sfly_std.a.f -> Result", "function sfly_std.a.f -> int"),  # 改返回值类型
        (
            "pos ctx: Context\n  pos name: str",
            "pos ctx: Context\n  pos name: str\n  pos extra: int = 0",
        ),
        ("kw poll: float = 0.5", "kw poll: float = 0.5\n  kw gap: float"),  # 新增的参数没有默认值
        ("field count: int\n  field size: int = 0", "field size: int = 0"),  # 删除字段
        ("field size: int = 0", "field size: int = 0\n  field extra: int"),  # 新增字段没有默认值
        ("exception sfly_std.a.Failed(Exception)", "exception sfly_std.a.Failed(ValueError)"),
        ("  metric cpu kind=gauge labels=()\n", ""),  # 常量里删了一项
        ("metric mem kind=gauge labels=()", "metric mem kind=counter labels=()"),
        (
            "  metric cpu kind=gauge labels=()\n  metric mem kind=gauge labels=()",
            "  metric mem kind=gauge labels=()\n  metric cpu kind=gauge labels=()",
        ),
        ("dataclass sfly_std.a.Result frozen", "dataclass sfly_std.a.Result"),  # 不再是 frozen
        ("exception sfly_std.a.Failed(Exception)\n", ""),  # 删除名字
    ],
)
def test_the_comparison_flags_every_incompatible_change(changed: str, expected: str) -> None:
    old = snapshot_of(SIGNATURE)
    new = snapshot_of(SIGNATURE.replace(changed, expected))

    diff = compare(old, new)

    assert diff.breaking, f"{changed!r} → {expected!r} 违反兼容性承诺，却没有被发现"


@pytest.mark.parametrize(
    ("changed", "expected"),
    [
        ("kw poll: float = 0.5", "kw poll: float = 0.5\n  kw gap: float = 0.1"),  # 新增关键字参数
        ("field size: int = 0", "field size: int = 0\n  field extra: int = 0"),  # 新增字段
        (
            "metric mem kind=gauge labels=()",
            "metric mem kind=gauge labels=()\n  metric disk kind=gauge labels=()",
        ),
        (
            "exception sfly_std.a.Failed(Exception)",
            "exception sfly_std.a.Failed(Exception)\nexception sfly_std.a.Other(Exception)",
        ),
    ],
)
def test_the_comparison_accepts_compatible_additions_but_still_wants_the_snapshot_updated(
    changed: str, expected: str
) -> None:
    old = snapshot_of(SIGNATURE)
    new = snapshot_of(SIGNATURE.replace(changed, expected))

    diff = compare(old, new)

    assert diff.breaking == []
    assert diff.added, "兼容的新增要记进快照，所以比对要报告它们"


def test_the_snapshot_covers_every_public_name() -> None:
    names = {
        f"{module_name}.{name}"
        for module_name in PUBLIC_MODULES
        for name in importlib.import_module(module_name).__all__
    }
    committed = {
        header.split(" ", 1)[1].split(" ")[0].split("(")[0]
        for header in parse(SNAPSHOT.read_text(encoding="utf-8"))
    }
    assert committed == names


def python_blocks(path: Path) -> list[ast.Module]:
    text = path.read_text(encoding="utf-8")
    blocks = re.findall(r"^[ ]*```python\n(.*?)^[ ]*```", text, flags=re.MULTILINE | re.DOTALL)
    return [ast.parse(inspect.cleandoc(block)) for block in blocks]


#: 文档和技能里讲 sfly-std 的地方。
DOCS = [
    REPO / "docs" / "guide" / "standard-nodes.md",
    REPO / "docs" / "guide" / "skills" / "sfly-node-dev" / "SKILL.md",
]


def imported_helpers(tree: ast.Module) -> dict[str, Any]:
    """代码块里 `from sfly_std.xxx import a, b` 导入的名字 → 对象；不在 `__all__` 里的报错。"""
    found: dict[str, Any] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("sfly_std."):
            assert node.module is not None
            module = importlib.import_module(node.module)
            for alias in node.names:
                assert alias.name in module.__all__, f"{node.module} 没有公开 {alias.name}"
                found[alias.asname or alias.name] = getattr(module, alias.name)
    return found


def all_helpers() -> dict[str, Any]:
    """全部公开的函数和类，按名字：只有一行调用、没有写导入的片段也能对上。"""
    return {
        name: obj
        for module_name in PUBLIC_MODULES
        for name, obj in public_names(importlib.import_module(module_name))
        if inspect.isfunction(obj) or inspect.isclass(obj)
    }


@pytest.mark.parametrize("path", DOCS, ids=lambda p: p.name)
def test_every_call_of_a_helper_in_the_documentation_matches_its_signature(path: Path) -> None:
    # 文档里的片段没人跑过时，参数名写错（`refnd=30`）也不会有人发现：把片段里每个辅助函数的调用
    # 绑到真实的签名上，参数名不存在、位置参数太多都会失败。
    checked = 0
    for tree in python_blocks(path):
        helpers = {**all_helpers(), **imported_helpers(tree)}
        for call in (n for n in ast.walk(tree) if isinstance(n, ast.Call)):
            if not isinstance(call.func, ast.Name) or call.func.id not in helpers:
                continue
            if any(isinstance(a, ast.Starred) for a in call.args) or any(
                k.arg is None for k in call.keywords
            ):
                continue
            signature = inspect.signature(helpers[call.func.id])
            signature.bind_partial(
                *[None] * len(call.args), **{k.arg: None for k in call.keywords if k.arg}
            )
            checked += 1
    assert checked > 0 or path.name == "SKILL.md"


@pytest.mark.parametrize("path", DOCS, ids=lambda p: p.name)
def test_the_modules_and_names_the_documentation_mentions_exist(path: Path) -> None:
    # 技能随 SDK 的 wheel 写进用户的项目：它提到的模块、函数要真的存在、真的公开。
    text = path.read_text(encoding="utf-8")
    for module_name in sorted(set(re.findall(r"sfly_std\.([a-z][a-z_]*)", text))):
        module = importlib.import_module(f"sfly_std.{module_name}")
        assert not module_name.startswith("_")
        if f"sfly_std.{module_name}" not in PUBLIC_MODULES:
            continue
        for name in set(re.findall(rf"sfly_std\.{module_name}\.([A-Za-z_]\w*)", text)):
            assert name in module.__all__, (
                f"{path.name} 提到的 sfly_std.{module_name}.{name} 不存在"
            )


def test_the_unit_test_snippet_in_the_documentation_builds_a_working_context(
    tmp_path: Path,
) -> None:
    # 文档告诉用户直接调用辅助函数的单元测试怎么造 `Context`：这段代码真的能用。
    from sfly_std.commands import run_command

    source = next(
        ast.unparse(tree)
        for tree in python_blocks(DOCS[0])
        if any(isinstance(n, ast.FunctionDef) and n.name == "make_context" for n in ast.walk(tree))
    )
    namespace: dict[str, Any] = {}
    exec(source, namespace)  # noqa: S102 -- 文档里的片段，只定义一个函数
    ctx = namespace["make_context"](tmp_path)

    assert not ctx.cancelled()
    (tmp_path / "cancel").write_text("")
    assert ctx.cancelled()
    result = run_command(ctx, "echo 你好", save_output=True)
    assert result.stdout == "你好\n"
    assert (tmp_path / "artifacts" / "stdout.txt").read_text() == "你好\n"


MEMBERS = """
class sfly_std.a.Reader
  attribute path: Path
  method __init__(pos path: str ; kw read_from: str = 'end') -> None
  method lines(-) -> Iterator[str]
dataclass sfly_std.a.Shown frozen
  field name: str
  property label -> str
constant sfly_std.a.UNITS = tuple
  metric speed kind=gauge unit='B/s' labels=()
"""


@pytest.mark.parametrize(
    ("changed", "expected"),
    [
        (
            "  method lines(-) -> Iterator[str]\n",
            "  method lines(-) -> Iterator[str]\n  method size(-) -> int\n",
        ),  # 加方法
        (
            "kw read_from: str = 'end') -> None",
            "kw read_from: str = 'end' ; kw strict: bool = False) -> None",
        ),  # 构造函数末尾加带默认值的关键字参数
        ("  attribute path: Path\n", "  attribute path: Path\n  attribute mode: str\n"),  # 加属性
        ("  property label -> str\n", "  property label -> str\n  property short -> str\n"),
    ],
)
def test_a_class_can_gain_methods_attributes_and_defaulted_constructor_arguments(
    changed: str, expected: str
) -> None:
    diff = compare(snapshot_of(MEMBERS), snapshot_of(MEMBERS.replace(changed, expected)))

    assert diff.breaking == [], diff.breaking
    assert diff.added, "兼容的新增要记进快照"


@pytest.mark.parametrize(
    ("changed", "expected"),
    [
        ("  method lines(-) -> Iterator[str]\n", ""),  # 删方法
        ("method lines(-) -> Iterator[str]", "method lines(-) -> list[str]"),  # 改返回值类型
        ("kw read_from: str = 'end'", "kw mode: str = 'end'"),  # 构造函数的参数改名
        ("kw read_from: str = 'end'", "kw read_from: str"),  # 默认值没了
        (
            "kw read_from: str = 'end') -> None",
            "kw read_from: str = 'end' ; kw strict: bool) -> None",
        ),  # 新增的参数没有默认值
        ("  attribute path: Path\n", "  attribute path: str\n"),  # 属性的类型变了
        ("  property label -> str\n", "  property label -> int\n"),
        ("unit='B/s'", "unit='MB/s'"),  # 常量里指标的单位变了
    ],
)
def test_a_class_member_or_metric_unit_change_that_breaks_users_is_flagged(
    changed: str, expected: str
) -> None:
    assert changed in MEMBERS, changed

    diff = compare(snapshot_of(MEMBERS), snapshot_of(MEMBERS.replace(changed, expected)))

    assert diff.breaking, f"{changed!r} → {expected!r} 违反兼容性承诺，却没有被发现"


PARAMS = """
function sfly_std.a.g -> Literal['a', 'b']
  pos ctx: Context
  pos pid: int | Sequence[int] | None
  kw mode: Literal['fail', 'succeed'] = 'fail'
  kw limit: int
  kw only_kw: str = 'x'
"""


@pytest.mark.parametrize(
    ("changed", "expected"),
    [
        # 取固定值的参数多一个可选值
        (
            "kw mode: Literal['fail', 'succeed'] = 'fail'",
            "kw mode: Literal['fail', 'succeed', 'restart'] = 'fail'",
        ),
        # 参数的类型放宽：联合类型多一个成员（位置参数、关键字参数都一样）
        (
            "pos pid: int | Sequence[int] | None",
            "pos pid: int | str | Sequence[int] | None",
        ),
        ("kw only_kw: str = 'x'", "kw only_kw: str | None = 'x'"),
        # 必填的关键字参数加上默认值
        ("kw limit: int", "kw limit: int = 10"),
        # 只能按关键字传的参数放宽成也能按位置传（关键字写法仍然有效）
        (
            "pos pid: int | Sequence[int] | None\n  kw mode: Literal['fail', 'succeed'] = 'fail'\n"
            "  kw limit: int\n  kw only_kw: str = 'x'",
            "pos pid: int | Sequence[int] | None\n  pos only_kw: str = 'x'\n"
            "  kw mode: Literal['fail', 'succeed'] = 'fail'\n  kw limit: int",
        ),
    ],
)
def test_the_comparison_accepts_compatible_changes_to_existing_parameters(
    changed: str, expected: str
) -> None:
    assert changed in PARAMS, changed

    diff = compare(snapshot_of(PARAMS), snapshot_of(PARAMS.replace(changed, expected)))

    assert diff.breaking == [], diff.breaking
    assert diff.added, "兼容的改动要记进快照，所以比对要报告它们"


@pytest.mark.parametrize(
    ("changed", "expected"),
    [
        # 可选值少了一个
        (
            "kw mode: Literal['fail', 'succeed'] = 'fail'",
            "kw mode: Literal['fail'] = 'fail'",
        ),
        # 联合类型少了一个成员、或者换成别的类型
        ("pos pid: int | Sequence[int] | None", "pos pid: int | None"),
        ("kw only_kw: str = 'x'", "kw only_kw: int = 'x'"),
        # 默认值没了、变了
        ("kw mode: Literal['fail', 'succeed'] = 'fail'", "kw mode: Literal['fail', 'succeed']"),
        ("kw only_kw: str = 'x'", "kw only_kw: str = 'y'"),
        # 位置参数改成只能按关键字传
        ("pos pid: int | Sequence[int] | None", "kw pid: int | Sequence[int] | None"),
        # 返回值的类型放宽不算兼容：调用方要处理新的取值
        ("-> Literal['a', 'b']", "-> Literal['a', 'b', 'c']"),
        # 放宽成也能按位置传，同时类型收窄了
        (
            "pos pid: int | Sequence[int] | None\n  kw mode: Literal['fail', 'succeed'] = 'fail'\n"
            "  kw limit: int\n  kw only_kw: str = 'x'",
            "pos pid: int | Sequence[int] | None\n  pos only_kw: int = 'x'\n"
            "  kw mode: Literal['fail', 'succeed'] = 'fail'\n  kw limit: int",
        ),
    ],
)
def test_the_comparison_still_flags_narrowing_and_other_incompatible_parameter_changes(
    changed: str, expected: str
) -> None:
    assert changed in PARAMS, changed

    diff = compare(snapshot_of(PARAMS), snapshot_of(PARAMS.replace(changed, expected)))

    assert diff.breaking, f"{changed!r} → {expected!r} 违反兼容性承诺，却没有被发现"
