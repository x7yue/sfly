"""公开接口的快照：每个 `__all__` 里的名字一项，函数写参数名、种类、默认值和返回值，数据类写字段，
异常写基类，常量写里面的指标、图表。`public_api.txt` 是提交进仓库的快照，
`test_public_api.py` 拿当前的接口和它比对。

sfly-std 的兼容性承诺（`sfly_std/__init__.py`）：一台 Agent 的共享环境里只有一个版本，公开的
接口只做向后兼容的改动。所以改接口必须同时改快照，评审的人一眼看得见：

- 兼容的改动（新增名字，函数末尾新增带默认值的关键字参数，数据类末尾新增带默认值的字段，
  常量末尾新增元素）：更新快照即可；
- 其余的改动（改名、删除、改默认值、改参数的种类或类型标注、改返回值类型、改异常的基类……）
  违反兼容性承诺：要改就加新名字，旧的留着。

更新快照：`uv run python std/tests/public_api_snapshot.py --write`。
"""

from __future__ import annotations

import dataclasses
import importlib
import inspect
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: 公开的辅助函数所在的模块（`sfly_std/__init__.py` 的文档字符串里列出的那些）。
PUBLIC_MODULES = [
    "sfly_std.commands",
    "sfly_std.processes",
    "sfly_std.resources",
    "sfly_std.logs",
    "sfly_std.waiting",
    "sfly_std.agent_files",
]

SNAPSHOT = Path(__file__).with_name("public_api.txt")

#: 快照：项（`function sfly_std.commands.run_command` 这样的标题行）→ 缩进的内容行。
Model = dict[str, list[str]]


def current() -> Model:
    """当前代码的公开接口。"""
    model: Model = {}
    for module_name in PUBLIC_MODULES:
        module = importlib.import_module(module_name)
        for name in module.__all__:
            describe(f"{module_name}.{name}", getattr(module, name), model)
    return model


def describe(path: str, obj: Any, model: Model) -> None:
    if inspect.isfunction(obj):
        model[f"function {path} -> {_ret(obj)}"] = _params(obj)
    elif inspect.isclass(obj) and issubclass(obj, BaseException):
        bases = ", ".join(b.__name__ for b in obj.__bases__)
        model[f"exception {path}({bases})"] = []
    elif inspect.isclass(obj) and dataclasses.is_dataclass(obj):
        frozen = obj.__dataclass_params__.frozen  # type: ignore[attr-defined]
        model[f"dataclass {path}{' frozen' if frozen else ''}"] = [
            f"field {f.name}: {f.type}{_default(f)}" for f in dataclasses.fields(obj)
        ] + _methods(obj)
    elif inspect.isclass(obj):
        attributes = [
            f"attribute {name}: {_text(annotation)}"
            for name, annotation in vars(obj).get("__annotations__", {}).items()
        ]
        model[f"class {path}"] = attributes + _methods(obj, init=True)
    elif isinstance(obj, tuple):
        model[f"constant {path} = tuple"] = [_item(x) for x in obj]
    else:
        model[f"constant {path} = {obj!r}"] = []


def _ret(fn: Any) -> str:
    annotation = inspect.signature(fn).return_annotation
    return "?" if annotation is inspect.Signature.empty else _text(annotation)


def _text(annotation: Any) -> str:
    return annotation if isinstance(annotation, str) else repr(annotation)


def _params(fn: Any, *, skip_self: bool = False) -> list[str]:
    lines = []
    for index, p in enumerate(inspect.signature(fn).parameters.values()):
        if skip_self and index == 0:
            continue
        kind = {
            p.POSITIONAL_ONLY: "pos-only",
            p.POSITIONAL_OR_KEYWORD: "pos",
            p.VAR_POSITIONAL: "*args",
            p.KEYWORD_ONLY: "kw",
            p.VAR_KEYWORD: "**kwargs",
        }[p.kind]
        annotation = "?" if p.annotation is p.empty else _text(p.annotation)
        default = "" if p.default is p.empty else f" = {p.default!r}"
        lines.append(f"{kind} {p.name}: {annotation}{default}")
    return lines


def _default(f: dataclasses.Field[Any]) -> str:
    if f.default is not dataclasses.MISSING:
        return f" = {f.default!r}"
    if f.default_factory is not dataclasses.MISSING:
        return " = <factory>"
    return ""


def _methods(cls: type, *, init: bool = False) -> list[str]:
    """类自己定义的公开方法和属性（含上下文管理器的 `__enter__`、`__exit__`）。"""
    lines = []
    for name, member in vars(cls).items():
        public = not name.startswith("_") or name in {"__enter__", "__exit__"}
        if name == "__init__" and init:
            public = True
        if not public:
            continue
        if isinstance(member, property):
            lines.append(f"property {name} -> {_ret(member.fget)}")
        elif inspect.isfunction(member):
            params = " ; ".join(_params(member, skip_self=True)) or "-"
            lines.append(f"method {name}({params}) -> {_ret(member)}")
    return lines


def _item(item: Any) -> str:
    """常量里的一项：指标写名字、类型和标签，图表写标题、类型和用到的指标。"""
    if hasattr(item, "labels") and hasattr(item, "kind"):
        unit = f" unit={item.unit!r}" if item.unit else ""
        return f"metric {item.name} kind={item.kind}{unit} labels={tuple(item.labels)!r}"
    if hasattr(item, "title") and hasattr(item, "metrics"):
        return f"chart {item.title} type={item.type} metrics={tuple(item.metrics)!r}"
    return f"item {item!r}"


# ---- 文本 ----


def render(model: Model) -> str:
    lines = []
    for header, body in model.items():
        lines.append(header)
        lines += [f"  {line}" for line in body]
    return "\n".join(lines) + "\n"


def parse(text: str) -> Model:
    model: Model = {}
    header = None
    for line in text.splitlines():
        if not line.strip():
            continue
        if line.startswith("  "):
            assert header is not None
            model[header].append(line[2:])
        else:
            header = line
            model[header] = []
    return model


# ---- 比对 ----


@dataclass
class Diff:
    """两份快照的差别。"""

    #: 兼容的新增。
    added: list[str] = field(default_factory=list)
    #: 违反兼容性承诺（或需要评审）的改动。
    breaking: list[str] = field(default_factory=list)

    @property
    def same(self) -> bool:
        return not self.added and not self.breaking


def compare(old: Model, new: Model) -> Diff:
    """`old`（承诺过的快照）到 `new`（当前代码）的差别，按兼容性承诺分成新增和违反。"""
    diff = Diff()
    old_by_path = {_path(h): h for h in old}
    new_by_path = {_path(h): h for h in new}
    for path, old_header in old_by_path.items():
        if path not in new_by_path:
            diff.breaking.append(f"删除了 {path}")
            continue
        new_header = new_by_path[path]
        _compare_item(path, old_header, old[old_header], new_header, new[new_header], diff)
    for path, header in new_by_path.items():
        if path not in old_by_path:
            diff.added.append(f"新增 {header}")
    return diff


def _path(header: str) -> str:
    """标题行里的名字：`function sfly_std.a.b -> int` → `sfly_std.a.b`。"""
    return header.split(" ", 1)[1].split(" ")[0].split("(")[0]


def _compare_item(
    path: str, old_header: str, old: list[str], new_header: str, new: list[str], diff: Diff
) -> None:
    kind = old_header.split(" ", 1)[0]
    if kind != new_header.split(" ", 1)[0]:
        diff.breaking.append(f"{path} 的种类变了：{old_header} → {new_header}")
        return
    if kind == "function":
        _compare_function(path, old_header, old, new_header, new, diff)
    elif kind == "dataclass":
        _compare_dataclass(path, old_header, old, new_header, new, diff)
    elif kind == "constant":
        _compare_constant(path, old_header, old, new_header, new, diff)
    elif kind == "class":
        _compare_members(path, old, new, diff)
    elif old_header != new_header or old != new:
        diff.breaking.append(f"{path} 变了：{old_header} → {new_header}（{old} → {new}）")


def _split(line: str) -> tuple[str, str, str | None]:
    """`kw name: annotation = default` → (种类 + 名字, 类型标注, 默认值)。"""
    left, _, default = line.partition(" = ")
    head, _, annotation = left.partition(": ")
    return head, annotation, default if " = " in line else None


def _compare_function(
    path: str, old_header: str, old: list[str], new_header: str, new: list[str], diff: Diff
) -> None:
    old_ret, new_ret = old_header.rpartition(" -> ")[2], new_header.rpartition(" -> ")[2]
    if old_ret != new_ret:
        diff.breaking.append(f"{path} 的返回值类型变了：{old_ret} → {new_ret}")
    _compare_params(path, old, new, diff)


def _compare_params(path: str, old: list[str], new: list[str], diff: Diff) -> None:
    """参数行（`pos name: 类型`、`kw name: 类型 = 默认值`）的兼容性：位置参数不变，已有的关键字
    参数名、类型、默认值不变，新增的只能是带默认值的关键字参数。"""
    old_pos = [_split(line) for line in old if not line.startswith("kw ")]
    new_pos = [_split(line) for line in new if not line.startswith("kw ")]
    if new_pos[: len(old_pos)] != old_pos:
        diff.breaking.append(f"{path} 的位置参数变了：{[p[0] for p in old_pos]}")
    for head, _, default in new_pos[len(old_pos) :]:
        extra = "新增的参数只能是带默认值的关键字参数" if default is not None else "也没有默认值"
        diff.breaking.append(f"{path} 新增了位置参数 {head}：{extra}")
    old_kw = {head: (a, d) for head, a, d in map(_split, (x for x in old if x.startswith("kw ")))}
    new_kw = {head: (a, d) for head, a, d in map(_split, (x for x in new if x.startswith("kw ")))}
    for head, (annotation, default) in old_kw.items():
        if head not in new_kw:
            diff.breaking.append(f"{path} 删除或改名了参数 {head}")
        elif new_kw[head] != (annotation, default):
            diff.breaking.append(
                f"{path} 的参数 {head} 变了：{annotation} = {default} → "
                f"{new_kw[head][0]} = {new_kw[head][1]}"
            )
    for head, (annotation, default) in new_kw.items():
        if head not in old_kw:
            if default is None:
                diff.breaking.append(f"{path} 新增的参数 {head} 没有默认值")
            else:
                diff.added.append(f"{path} 新增参数 {head}: {annotation} = {default}")


def _compare_members(path: str, old: list[str], new: list[str], diff: Diff) -> None:
    """类的属性、property 和方法：已有的不变，新增的兼容；`__init__` 和方法的参数按函数的规则。"""
    old_by_name = {_member_name(line): line for line in old}
    new_by_name = {_member_name(line): line for line in new}
    for name, line in old_by_name.items():
        if name not in new_by_name:
            diff.breaking.append(f"{path} 删除了 {name}")
            continue
        other = new_by_name[name]
        if line == other:
            continue
        if line.startswith("method ") and other.startswith("method "):
            old_params, old_ret = _method_signature(line)
            new_params, new_ret = _method_signature(other)
            if old_ret != new_ret:
                diff.breaking.append(f"{path}.{name} 的返回值类型变了：{old_ret} → {new_ret}")
            _compare_params(f"{path}.{name}", old_params, new_params, diff)
        else:
            diff.breaking.append(f"{path} 的 {name} 变了：{line} → {other}")
    for name, line in new_by_name.items():
        if name not in old_by_name:
            diff.added.append(f"{path} 新增 {line}")


def _member_name(line: str) -> str:
    """`method lines(-) -> …`、`property label -> …`、`attribute path: …` 里的名字。"""
    return line.split(" ", 1)[1].split("(")[0].split(" ")[0].rstrip(":")


def _method_signature(line: str) -> tuple[list[str], str]:
    """`method name(P1 ; P2) -> RET` → ([P1, P2], RET)。"""
    inside = line.split("(", 1)[1].rpartition(") -> ")
    params = [] if inside[0] == "-" else inside[0].split(" ; ")
    return params, inside[2]


def _compare_dataclass(
    path: str, old_header: str, old: list[str], new_header: str, new: list[str], diff: Diff
) -> None:
    if old_header != new_header:
        diff.breaking.append(f"{path} 变了：{old_header} → {new_header}")
    old_fields = [x for x in old if x.startswith("field ")]
    new_fields = [x for x in new if x.startswith("field ")]
    if new_fields[: len(old_fields)] != old_fields:
        diff.breaking.append(f"{path} 的字段变了：{old_fields} → {new_fields}")
    else:
        for line in new_fields[len(old_fields) :]:
            if " = " in line:
                diff.added.append(f"{path} 新增字段 {line.removeprefix('field ')}")
            else:
                diff.breaking.append(f"{path} 新增的字段 {line.removeprefix('field ')} 没有默认值")
    old_other = [x for x in old if not x.startswith("field ")]
    new_other = [x for x in new if not x.startswith("field ")]
    _compare_members(path, old_other, new_other, diff)


def _compare_constant(
    path: str, old_header: str, old: list[str], new_header: str, new: list[str], diff: Diff
) -> None:
    if old_header != new_header:
        diff.breaking.append(f"{path} 变了：{old_header} → {new_header}")
    elif new[: len(old)] != old:
        diff.breaking.append(f"{path} 里已有的项变了、少了或换了顺序：{old} → {new}")
    else:
        diff.added.extend(f"{path} 新增 {line}" for line in new[len(old) :])


def main(argv: list[str]) -> int:
    # 从 std/tests 直接运行时，sfly_std 要能导入（uv run 已经装好）。
    if "--write" in argv:
        SNAPSHOT.write_text(render(current()), encoding="utf-8")
        print(f"已写入 {SNAPSHOT}")
        return 0
    print(render(current()), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
