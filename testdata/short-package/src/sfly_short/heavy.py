"""重依赖节点：模块顶层导入整个标准库、再定义一批类，模拟顶层导入 pandas 这类大库的节点（#76）。

为什么不用 pandas：性能测试不访问外网，也不该随某个第三方库的版本变化。这里做的事是确定的
（同一个 Python 每次都一样），成分与导入大库相同：

- 把标准库的全部模块导入一遍（开发机上约 110 ms）：几百个模块的 .pyc、一批 C 扩展（_decimal、
  _ssl、_sqlite3、_ctypes 等），而且同样会导入 json、re、typing、inspect 这些 SDK 也用到的模块
  ——SDK 推迟导入它们时，重依赖节点省不下这部分，与真实的大库一致。跳过图形界面、演示和测试用的包，
  以及导入时就有副作用的模块（打开浏览器、打印文字、运行 `__main__`）；当前平台没有的模块
  （Windows 专用、没有编译进来的 C 扩展）导入失败时跳过。
- 再定义 `_CLASSES` 组数据类和枚举（开发机上约 90 ms）：大库导入时大部分时间花在执行模块里的
  类定义、装饰器上，只导入标准库到不了 #76 测得的 pandas 导入用时（约 218 ms）。

两部分合起来，开发机上导入约 200 ms。
"""

from __future__ import annotations

import dataclasses
import enum
import importlib
import pkgutil
import sys
import time

from sfly import node

_STARTED = time.perf_counter()

#: 名字里任何一段是它们的模块都不导入。
_SKIP = {
    "__main__",
    "antigravity",
    "this",
    "idlelib",
    "tkinter",
    "turtle",
    "turtledemo",
    "test",
    "tests",
    "idle_test",
    "ensurepip",
    "venv",
    "lib2to3",
}


def _wanted(name: str) -> bool:
    return not (_SKIP & set(name.split(".")))


def _import_stdlib() -> int:
    """按名字顺序导入标准库的全部顶层模块与子模块，返回导入成功的个数。"""
    imported = 0
    for top in sorted(sys.stdlib_module_names):
        if top.startswith("_") or not _wanted(top):
            continue
        try:
            module = importlib.import_module(top)
        except ImportError:
            continue
        imported += 1
        path = getattr(module, "__path__", [])
        for info in pkgutil.walk_packages(path, f"{top}.", onerror=lambda _name: None):
            if not _wanted(info.name):
                continue
            try:
                importlib.import_module(info.name)
            except ImportError:
                continue
            imported += 1
    return imported


#: 定义多少组数据类与枚举。
_CLASSES = 150


def _define_classes() -> list[object]:
    """定义 `_CLASSES` 组冻结的数据类（6 个字段）和枚举（8 个成员）。"""
    classes: list[object] = []
    for i in range(_CLASSES):
        fields = [(f"f{k}", int, k) for k in range(6)]
        classes.append(dataclasses.make_dataclass(f"Record{i}", fields, frozen=True))
        classes.append(enum.Enum(f"Kind{i}", [f"V{k}" for k in range(8)]))
    return classes


_MODULES = _import_stdlib()
_DEFINED = _define_classes()
_IMPORT_MS = (time.perf_counter() - _STARTED) * 1000


@node(title="重依赖节点", outputs=["modules", "classes", "import_ms"])
def heavy() -> dict[str, object]:
    """返回导入的标准库模块个数、定义的类个数和导入用时（毫秒，节点模块自己计时）。"""
    return {"modules": _MODULES, "classes": len(_DEFINED), "import_ms": round(_IMPORT_MS, 1)}
