"""找出命令行源码里用到的控制面路径：`test_cli_routes.py` 拿它们和路由清单对照。

只做静态扫描（标准库 ast），不执行命令，所以连没被别的测试跑到的分支也检查得到：
- `client.get(路径)`、`client.request(方法, 路径)`、`client.open(方法, 路径)` 的路径参数记下方法；
- 其余所有以 `/字母` 开头的完整字符串（路径常量、传给辅助函数的路径）也记下，只对照路径，
  宁可多查：不是控制面路径的（见 `NOT_CONTROL_PLANE`）要在这里明确排除；
- f-string 里的 `{...}` 当作一段任意的值，同一个函数（或模块、类）里先赋过值的变量会展开，
  所以 `base = f"/orchestrations/{id}"` 之后的 `f"{base}/head"` 也能还原成完整路径。
没法还原成路径的拼接（例如路径来自函数参数）不会被扫到：新增命令请直接把路径写成字面量或 f-string。
"""

from __future__ import annotations

import ast
import itertools
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from sfly.cli.routes import Route

HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
# 路径参数的占位值：一段普通文本，`:page.md` 之类带字面量后缀的模板也对得上。
PLACEHOLDER = "x"
_PATH_LIKE = re.compile(r"/[A-Za-z]")
_CLIENT_CALLS = {"get": 0, "request": 1, "open": 1}

# 命令行源码里长得像路径、其实不是控制面路径的：整个文件（压缩包里的成员名），
# 或某个路径（GitHub 发布地址的后缀）。
NOT_CONTROL_PLANE_FILES = {"wheel.py"}
NOT_CONTROL_PLANE_PATHS = {"/astral-sh/python-build-standalone/"}


@dataclass(frozen=True)
class PathUse:
    file: str
    line: int
    # 能确定请求方法时的方法，否则为 None（只对照路径）。
    method: str | None
    path: str

    def __str__(self) -> str:
        return f"{self.file}:{self.line} {self.method or '*'} {self.path}"


def collect_paths(source_dir: Path) -> list[PathUse]:
    uses: list[PathUse] = []
    for file in sorted(source_dir.rglob("*.py")):
        if file.name in NOT_CONTROL_PLANE_FILES:
            continue
        tree = ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
        scanner = _Scanner(str(file.relative_to(source_dir)))
        scanner.scan_scope(tree, {})
        uses.extend(scanner.uses)
    return uses


def mismatches(uses: list[PathUse], routes: list[Route]) -> list[PathUse]:
    """清单里找不到的路径用法（路径对得上但方法不对，也算）。"""
    return [use for use in uses if not _in_manifest(use, routes)]


def _in_manifest(use: PathUse, routes: list[Route]) -> bool:
    return any(
        route.match(use.path) is not None and use.method in (None, route.method) for route in routes
    )


class _Scanner:
    def __init__(self, file: str) -> None:
        self.file = file
        self.uses: list[PathUse] = []
        # `self.x = "/路径"` 这样的属性赋值，同一个文件里各个方法共用。
        self.attributes: dict[str, list[str]] = {}
        self._seen: set[tuple[int, str | None, str]] = set()

    def scan_scope(self, scope: ast.AST, inherited: dict[str, list[str]]) -> None:
        env = dict(inherited)
        for node in _own_nodes(scope):
            if isinstance(node, ast.Assign | ast.AnnAssign) and node.value is not None:
                self._remember(node, env)
        parts = _string_parts(scope)
        for node in _own_nodes(scope):
            if isinstance(node, ast.Call):
                self._call(node, env)
            elif (
                isinstance(node, ast.Constant | ast.JoinedStr | ast.BinOp) and id(node) not in parts
            ):
                self._standalone(node, env)
        for node in ast.walk(scope):
            if node is not scope and isinstance(
                node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef | ast.Lambda
            ):
                if node in _direct_children_scopes(scope):
                    self.scan_scope(node, env)

    def _remember(self, node: ast.Assign | ast.AnnAssign, env: dict[str, list[str]]) -> None:
        assert node.value is not None
        values = self._resolve(node.value, env)
        if values is None:
            return
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        for target in targets:
            if isinstance(target, ast.Name):
                env[target.id] = values
            elif isinstance(target, ast.Attribute):
                self.attributes.setdefault(ast.unparse(target), []).extend(values)

    def _call(self, call: ast.Call, env: dict[str, list[str]]) -> None:
        func = call.func
        if not isinstance(func, ast.Attribute) or func.attr not in _CLIENT_CALLS:
            return
        index = _CLIENT_CALLS[func.attr]
        if len(call.args) <= index:
            return
        methods: list[str | None] = ["GET"] if func.attr == "get" else []
        if func.attr != "get":
            resolved = self._resolve(call.args[0], env)
            if resolved is None or not set(resolved) <= HTTP_METHODS:
                return
            methods = list(resolved)
        paths = self._resolve(call.args[index], env)
        for method, path in itertools.product(methods, paths or []):
            if _PATH_LIKE.match(path):
                self._record(call, method, path)

    def _standalone(self, node: ast.expr, env: dict[str, list[str]]) -> None:
        for path in self._resolve(_without_server_prefix(node, env, self), env) or []:
            if _PATH_LIKE.match(path):
                self._record(node, None, path)

    def _record(self, node: ast.AST, method: str | None, path: str) -> None:
        if path in NOT_CONTROL_PLANE_PATHS:
            return
        line = getattr(node, "lineno", 0)
        if (line, method, path) not in self._seen:
            self._seen.add((line, method, path))
            self.uses.append(PathUse(self.file, line, method, path))

    def _resolve(self, node: ast.expr, env: dict[str, list[str]]) -> list[str] | None:
        """表达式可能的字符串值；不是字符串时为 None，不认识的 `{...}` 当作 `PLACEHOLDER`。"""
        if isinstance(node, ast.Constant):
            return [node.value] if isinstance(node.value, str) else None
        if isinstance(node, ast.Name):
            return env.get(node.id)
        if isinstance(node, ast.Attribute):
            return self.attributes.get(ast.unparse(node))
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left, right = self._resolve(node.left, env), self._resolve(node.right, env)
            if left is None or right is None:
                return None
            return [a + b for a, b in itertools.product(left, right)]
        if isinstance(node, ast.JoinedStr):
            pieces: list[list[str]] = []
            for part in node.values:
                if isinstance(part, ast.Constant):
                    pieces.append([str(part.value)])
                elif isinstance(part, ast.FormattedValue):
                    pieces.append(self._resolve(part.value, env) or [PLACEHOLDER])
            return ["".join(combo) for combo in itertools.product(*pieces)]
        return None


_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)


def _own_nodes(scope: ast.AST) -> Iterator[ast.AST]:
    """`scope` 自己的节点（按源码顺序），不进入嵌套的函数、类。"""
    stack = list(reversed(list(ast.iter_child_nodes(scope))))
    while stack:
        node = stack.pop()
        yield node
        if not isinstance(node, _SCOPES):
            stack.extend(reversed(list(ast.iter_child_nodes(node))))


def _without_server_prefix(
    node: ast.expr, env: dict[str, list[str]], scanner: _Scanner
) -> ast.expr:
    """`f"{控制面地址}/packages"` 去掉开头还原不了的地址，剩下 `/packages`。"""
    if not isinstance(node, ast.JoinedStr) or len(node.values) < 2:
        return node
    head, second = node.values[0], node.values[1]
    if (
        isinstance(head, ast.FormattedValue)
        and scanner._resolve(head.value, env) is None  # noqa: SLF001
        and isinstance(second, ast.Constant)
        and _PATH_LIKE.match(str(second.value)) is not None
    ):
        return ast.JoinedStr(values=node.values[1:])
    return node


def _string_parts(scope: ast.AST) -> set[int]:
    """拼成更长字符串的各个部分（f-string 的片段、`+` 的两边）：整个字符串单独处理，部分不处理。"""
    parts: set[int] = set()
    for node in _own_nodes(scope):
        if isinstance(node, ast.JoinedStr):
            parts.update(id(part) for part in node.values)
        elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            parts.update((id(node.left), id(node.right)))
    return parts


def _direct_children_scopes(scope: ast.AST) -> list[ast.AST]:
    return [node for node in _own_nodes(scope) if isinstance(node, _SCOPES)]
