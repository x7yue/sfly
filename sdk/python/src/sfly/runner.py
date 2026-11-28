"""执行器：在任务子进程中加载并调用节点函数（`python -m sfly.runner`）。只用标准库（ADR 0002）。

本地协议（docs/ARCHITECTURE.md §5.4），全部通过环境变量传入路径：

- `SFLY_TASK`：task.json，至少包含 `entry`（`模块:函数`）和 `inputs`（已解析的输入，JSON 对象）。
- `SFLY_OUTPUT`：执行器写入结果的 output.json：
  - 成功：`{"status": "success", "outputs": {...}}`，退出码 0；
  - 失败：`{"status": "failed", "error": {"type", "message", "traceback"}}`，退出码 1；
    输入有节点没有声明的名字时，在调用节点之前就失败：
    `{"status": "failed", "error": {"kind": "config_error", "message"}}`（没有 `type` 和
    `traceback`）。节点没接住 `ctx.artifacts.save` 抛出的 `ArtifactLimitExceeded` 时，失败照常带
    `type`、`message`、`traceback`，另外有 `"kind": "env_error"`。`kind` 是读取端记的错误类型，
    没有这个键的失败是 `node_error`。
- `SFLY_ARTIFACTS`、`SFLY_ARTIFACTS_URL`、`SFLY_ARTIFACT_LIMIT_BYTES`、`SFLY_EVENTS`、
  `SFLY_CANCEL`：产物目录、产物下载地址前缀、这个任务的产物合计上限（字节，没有时不检查）、
  事件文件、取消标记（由 Context 使用）。

收到 SIGTERM（Agent 取消或超时时的优雅终止）时，在节点代码里抛出 `sfly.Cancelled`，
让清理代码有机会执行。

节点按关键字参数接收输入；首个参数是任务上下文时传入 `Context`。
返回值必须是 JSON 对象（返回 None 视为空对象），序列化后不超过 1 MB。
"""

from __future__ import annotations

import importlib
import inspect
import json
import os
import re
import signal
import sys
import typing
from collections.abc import Callable, Container, Mapping, Sequence
from typing import Any

from sfly.context import (
    ArtifactLimitExceeded,
    Cancelled,
    Context,
    describe_non_finite,
    non_finite_name,
    non_finite_places,
    on_sigterm,
)
from sfly.nodes import NODE_ATTR, Metric, NodeDeclaration, is_context_param

# 执行器每个任务启动一个进程（#76）：从解释器启动到开始导入节点模块的路径上只导入必需的模块，
# 只在节点失败时才用到的 traceback 推迟到用到时再导入，读写 task.json、output.json 不用 pathlib。
# 测试见 tests/test_runner.py 的 test_startup_path_does_not_import_deferred_modules。

#: 节点返回值序列化后的大小上限（docs/ARCHITECTURE.md §4.1）。
MAX_OUTPUT_BYTES = 1024 * 1024
#: 失败结果里的说明（异常的类型和文字）最多这么多字节（UTF-8）：超过的把中间省掉，
#: 首尾各留一半，写明省掉了多少。
#: 异常的文字可以有几十 MiB；原样写进 output.json，Agent 读不了（超过它的读取上限就不读，
#: 使用者看不到异常的类型和位置），
#: 控制面也收不下（#723）。完整的文字照旧写进标准错误，任务日志里有全文。
MAX_FAILURE_MESSAGE_BYTES = 64 * 1024
#: 失败结果里的堆栈最多这么多字节：超过的只留最后几帧（出错的那一处在最后），写明前面省掉了多少。
MAX_FAILURE_TRACEBACK_BYTES = 64 * 1024
#: 异常的类型名、出错的位置（「模块.函数 第 N 行」）不会长到哪里去，
#: 这个上限只是不让它们也成为无界的来源。
MAX_FAILURE_TYPE_CHARS = 256
MAX_FAILURE_LOCATION_CHARS = 1024


class NodeOutputError(Exception):
    """节点返回值不符合要求。"""


class InputError(Exception):
    """派发给节点的输入有问题（有节点没有声明的名字）：在调用节点函数之前就失败，记为配置错误。"""


def load_entry(entry: str) -> Callable[..., Any]:
    module_name, sep, qualname = entry.partition(":")
    if not sep or not module_name or not qualname:
        raise ValueError(f"节点入口格式应为 模块:函数，实际为 {entry!r}")
    target: Any = importlib.import_module(module_name)
    for part in qualname.split("."):
        target = getattr(target, part)
    if not callable(target):
        raise TypeError(f"节点入口 {entry} 不是可调用对象")
    return typing.cast(Callable[..., Any], target)


def _takes_context(fn: Callable[..., Any]) -> bool:
    params = list(inspect.signature(fn).parameters.values())
    if not params:
        return False
    try:
        hint = typing.get_type_hints(fn).get(params[0].name)
    except Exception:
        hint = params[0].annotation
    return is_context_param(params[0], hint)


def _declared_inputs(fn: Callable[..., Any]) -> list[str] | None:
    """节点声明的输入名，按参数顺序（任务上下文不是输入）；有 `**kwargs` 时全收，返回 None。"""
    params = list(inspect.signature(fn).parameters.values())
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params):
        return None
    if _takes_context(fn):
        params = params[1:]
    by_name = (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
    return [p.name for p in params if p.kind in by_name]


def _check_declared(fn: Callable[..., Any], inputs: Mapping[str, Any]) -> None:
    """输入里有节点没有声明的名字时抛出 `InputError`，写出多出来的名字和节点声明了哪些输入。"""
    declared = _declared_inputs(fn)
    if declared is None:
        return
    extra = [name for name in inputs if name not in declared]
    if not extra:
        return
    decl = getattr(fn, NODE_ATTR, None)
    name = (decl.name if isinstance(decl, NodeDeclaration) else None) or fn.__name__
    known = f"它声明的输入有：{'、'.join(declared)}" if declared else "它不接收任何输入"
    raise InputError(f"节点 {name} 没有声明输入 {'、'.join(extra)}，{known}")


def _declared_metrics(fn: Callable[..., Any]) -> Sequence[Metric] | None:
    """`@node` 声明的指标；入口没有用 `@node` 声明时为 None（不检查指标名和标签键）。"""
    decl = getattr(fn, NODE_ATTR, None)
    if not isinstance(decl, NodeDeclaration):
        return None
    return decl.metrics


def invoke(fn: Callable[..., Any], inputs: Mapping[str, Any]) -> dict[str, Any]:
    _check_declared(fn, inputs)
    if _takes_context(fn):
        result = fn(Context(metrics=_declared_metrics(fn)), **inputs)
    else:
        result = fn(**inputs)
    if result is None:
        return {}
    if not isinstance(result, dict):
        raise NodeOutputError(f"节点返回值必须是 JSON 对象（dict），实际为 {type(result).__name__}")
    return result


def _non_finite_message(outputs: dict[str, Any]) -> str | None:
    """返回值里有 NaN 或无穷时的错误说明（哪个输出、怎么办）；没有时为 None（原因是别的）。"""
    places = non_finite_places(outputs)
    if not places:
        return None
    if len(places) == 1:
        place, number = places[0]
        what = f"输出 {place} 的值是 {non_finite_name(number)}"
    else:
        what = f"输出里有 {len(places)} 处 NaN 或无穷：{describe_non_finite(places)}"
    advice = "换成 None（表示没有值），或者换成字符串（例如 str(值)）再返回"
    return f"{what}。JSON 里没有 NaN 和无穷，{advice}"


def _non_finite_reason(outputs: dict[str, Any]) -> str | None:
    """`_non_finite_message`，但找位置自己出错时当作没找到：位置只是附带的信息，
    不能让它的异常盖住原来的错误。"""
    try:
        return _non_finite_message(outputs)
    except Exception:
        return None


def _encode(outputs: dict[str, Any]) -> str:
    try:
        # allow_nan=False：NaN、无穷不写成 `NaN`、`Infinity`（不是合法的 JSON，Agent 读不了这份
        # 输出，任务会以看不出原因的「执行器异常退出」失败），而是在这里失败，写明是哪个输出。
        text = json.dumps(
            {"status": "success", "outputs": outputs}, ensure_ascii=False, allow_nan=False
        )
    except (TypeError, ValueError) as error:
        reason = _non_finite_reason(outputs) if isinstance(error, ValueError) else None
        raise NodeOutputError(f"节点返回值不能序列化为 JSON：{reason or error}") from error
    if len(text.encode("utf-8")) > MAX_OUTPUT_BYTES:
        raise NodeOutputError("节点返回值超过 1 MB 上限")
    return text


def _normalized(path: str) -> str:
    """比较路径用的写法：解开符号链接，大小写不敏感的文件系统上统一大小写。"""
    return os.path.normcase(os.path.realpath(path))


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _runtime_dirs() -> tuple[list[str], list[str], list[str]]:
    """（SDK 的目录，Python 标准库的目录，装第三方库的目录），都已规范化。

    标准库的目录取 `sysconfig` 的 `stdlib`（在 venv 里指向基础解释器的标准库，Agent 上的共享
    venv 也一样）、`platstdlib`（有的平台与 `stdlib` 不同；venv 里是 venv 自己的 lib 目录）和
    `os` 模块所在的目录。第三方库的目录是 `purelib`、`platlib`：它们常在上面某个目录里面，
    那里的文件不算标准库（节点包自己也可能装在那里）。
    """
    import sysconfig

    paths = sysconfig.get_paths()
    stdlib = [paths.get(key) for key in ("stdlib", "platstdlib")]
    stdlib.append(os.path.dirname(getattr(os, "__file__", "") or ""))
    third_party = [paths.get(key) for key in ("purelib", "platlib")]
    sdk = os.path.dirname(os.path.abspath(__file__))
    return (
        [_normalized(sdk)],
        [_normalized(d) for d in stdlib if d],
        [_normalized(d) for d in third_party if d],
    )


def _is_runtime_frame(filename: str, dirs: tuple[list[str], list[str], list[str]]) -> bool:
    """这一帧是 SDK 或 Python 标准库的代码，不是节点代码。

    `<frozen importlib._bootstrap>` 这类冻结的标准库模块算标准库；其余没有文件的帧（`<string>`、
    空的文件名）看不出来历，按节点代码算。第三方库（site-packages）里的帧不跳过：节点包自己可能
    就装在那里，停在第三方库里时写的是库里的位置。
    """
    sdk, stdlib, third_party = dirs
    if filename.startswith("<frozen "):
        return True
    if not filename or filename.startswith("<"):
        return False
    path = _normalized(filename)
    if any(_under(path, d) for d in sdk):
        return True
    in_site = any(_under(path, d) for d in third_party) or any(
        part in ("site-packages", "dist-packages") for part in path.split(os.sep)
    )
    return not in_site and any(_under(path, d) for d in stdlib)


#: 平台自带的、在用户的业务节点里被调用的包（标准节点包的辅助函数）。取「执行到哪」和「出错位置」时
#: 它们的栈帧和 SDK、Python 标准库一样不算：报调用它们的那一行用户代码；被终止时，用户直接调用的
#: 那个辅助函数写在后面作补充。节点自己就是这个包里的节点（标准节点 `shell` 等：它的顶层模块在
#: `_node_packages` 里）时不跳过：它们的代码就在包里，位置仍然指向包里。
PLATFORM_PACKAGES = frozenset({"sfly_std"})


def _is_platform_module(module: str, own: Container[str]) -> bool:
    """这个模块是平台自带的包、而节点不是它里面的节点（节点自己的包不在这里跳过）。"""
    top = module.partition(".")[0]
    return top in PLATFORM_PACKAGES and top not in own


def _frame_place(frame: Any, lineno: int) -> str:
    code = frame.f_code
    module = frame.f_globals.get("__name__") or os.path.basename(code.co_filename)
    function = getattr(code, "co_qualname", code.co_name)
    place = module if function == "<module>" else f"{module}.{function}"
    return f"{place} 第 {lineno} 行"


def _terminated_at(error: BaseException, entry: str = "", package: str | None = None) -> str | None:
    """任务被终止时执行到哪：节点代码里被打断的那一行，写成「模块.函数 第 N 行」。

    取异常经过的栈里最里面、不是辅助函数内部的一帧。辅助函数内部指：SDK、Python 标准库、平台自带的
    包（`PLATFORM_PACKAGES`，标准节点包 `sfly_std`）的帧，以及从 `sfly_std` 的帧往里调到的、不是
    节点自己代码的帧（它依赖的 `psutil` 之类：被终止时正好停在那里也算 `sfly_std` 里的事）。节点
    自己的代码用 `_is_node_code` 认：用户传给 `poll_until` 的回调仍然报回调那一行。

    所以停在 SDK、标准库、标准节点包的辅助函数（`wait_for_port`、`monitor_processes`、
    `run_command`）或它调到的第三方库里时，报调用它们的那一行节点代码；用户把辅助函数包进自己的工具模块时，报工具
    模块里调用它的那一行（它是用户的代码，是最近的一帧）；用户自己的代码直接停在第三方库里时，报库里
    的位置。

    停在辅助函数里时，用户直接调用的那个辅助函数（报出的那一帧之后第一个 `sfly_std` 的帧）写在后面
    作补充：`biz.check.run 第 12 行（正在 sfly_std.waiting.wait_for_port 第 130 行）`。节点自己就是
    标准节点（`entry` 的顶层模块是 `sfly_std`）时不跳过它的帧，没有补充。整条栈都是辅助函数内部时，
    报最里面一帧 `sfly_std` 的帧（没有补充），没有 `sfly_std` 的帧时报最里面一帧；没有栈信息时
    是 None。
    """
    import traceback

    frames = list(traceback.walk_tb(error.__traceback__))
    if not frames:
        return None
    dirs = _runtime_dirs()
    own = _OwnPackages(entry, package)  # 栈里出现 `sfly_std` 的帧时才算：这一步发生在收尾时间里
    inside = False  # 正在 sfly_std 调用的栈段里
    platform: list[bool] = []
    internal: list[bool] = []
    for frame, _ in frames:
        filename = frame.f_code.co_filename
        module = str(frame.f_globals.get("__name__") or "")
        is_platform = _is_platform_module(module, own)
        runtime = _is_runtime_frame(filename, dirs)
        if is_platform:
            inside = True
        elif (
            inside
            and not runtime
            and not _is_unreal_file(filename)
            and _is_node_code(filename, module, own, dirs)
        ):
            inside = (
                False  # 用户传进去的回调：节点自己的代码（有真的文件的帧：`<string>` 这类留在段里）
            )
        platform.append(is_platform)
        internal.append(runtime or is_platform or inside)
    index = next(
        (i for i in range(len(frames) - 1, -1, -1) if not internal[i]),
        next((i for i in range(len(frames) - 1, -1, -1) if platform[i]), len(frames) - 1),
    )
    place = _frame_place(*frames[index])
    if internal[index]:
        return place
    caller = next((i for i in range(index + 1, len(frames)) if platform[i]), None)
    return f"{place}（正在 {_frame_place(*frames[caller])}）" if caller is not None else place


def _in_site_packages(filename: str, dirs: tuple[list[str], list[str], list[str]]) -> bool:
    """文件装在第三方库的目录里（site-packages、dist-packages）。"""
    path = _normalized(filename)
    return any(_under(path, d) for d in dirs[2]) or any(
        part in ("site-packages", "dist-packages") for part in path.split(os.sep)
    )


def _node_packages(entry: str, package: str | None) -> set[str]:
    """节点包自己的顶层模块名：入口模块的顶层名，加上节点包（task.json 的 `package`）这个发行版
    装进来的所有顶层模块。节点包装在 Agent 共享 venv 的 site-packages 里，靠它分得出节点自己的代码
    和第三方库。"""
    names = {entry.partition(":")[0].partition(".")[0]}
    if package:
        try:
            from importlib import metadata

            def normalized(name: str) -> str:
                return re.sub(r"[-_.]+", "-", name).lower()

            wanted = normalized(package)
            for top, dists in metadata.packages_distributions().items():
                if any(normalized(d) == wanted for d in dists):
                    names.add(top)
        except Exception:  # 取不到发行版信息时只认入口模块的顶层名
            pass
    return names


class _OwnPackages:
    """节点包自己的顶层模块名（`_node_packages`），第一次问到时才算：算它要读全部发行版的元信息，
    被终止时在收尾时间里做这件事，栈里没有 `sfly_std` 的帧（用不上它）时不该花这个时间。"""

    def __init__(self, entry: str, package: str | None) -> None:
        self._entry = entry
        self._package = package
        self._names: set[str] | None = None

    def __contains__(self, name: object) -> bool:
        if self._names is None:
            self._names = _node_packages(self._entry, self._package)
        return name in self._names


def _is_node_code(
    filename: str,
    module: str,
    own: Container[str],
    dirs: tuple[list[str], list[str], list[str]],
) -> bool:
    """这一帧是节点项目自己的代码：不是 SDK 或标准库，也不是第三方库。

    没有文件的帧（`<string>`）看不出来历，按节点代码算。装在 site-packages 里的帧，只有顶层模块是
    节点包自己的才算（节点包装在 Agent 的共享 venv 里，和第三方库在同一个目录）；不在 site-packages
    里的（本地调试从源码目录运行、`sfly dev` 的可编辑安装）都是节点自己的。平台自带的包
    （`PLATFORM_PACKAGES`，`sfly_std`）不算节点自己的代码，不管它装在哪里（本仓库的可编辑安装也一样），除非节点就是它里面的标准节点。
    被终止时的「执行到哪」（`_terminated_at`）和失败时的出错位置（`_failed_at`）用的是同一个判断。
    """
    if _is_runtime_frame(filename, dirs) or _is_platform_module(module, own):
        return False
    if not filename or filename.startswith("<") or not _in_site_packages(filename, dirs):
        return True
    return module.partition(".")[0] in own


def _place(module: str, function: str, lineno: int | None) -> str:
    place = module if function == "<module>" else f"{module}.{function}"
    return f"{place} 第 {lineno} 行"


def _module_of(filename: str, dirs: tuple[list[str], list[str], list[str]]) -> str:
    """源文件对应的模块名：相对 `sys.path` 里（或 site-packages 目录）最深的那个目录，`pkg/sub.py`
    是 `pkg.sub`，包的 `__init__.py` 是包名 `pkg`。不在其中任何一个目录里时是文件名去掉扩展名。"""
    path = _normalized(filename)
    roots = [*dirs[2], *(_normalized(entry or os.curdir) for entry in sys.path)]
    parts = path.split(os.sep)
    roots += [
        os.sep.join(parts[: i + 1])
        for i, part in enumerate(parts)
        if part in ("site-packages", "dist-packages")
    ]
    root = max((r for r in roots if r != path and _under(path, r)), key=len, default=None)
    relative = os.path.relpath(path, root) if root else os.path.basename(path)
    names = os.path.splitext(relative)[0].split(os.sep)
    if len(names) > 1 and names[-1] == "__init__":
        names.pop()
    return ".".join(names)


def _is_unreal_file(filename: str) -> bool:
    """没有文件的帧：`<string>`（`exec`、dataclass 生成的方法）这类，文件里没有它的那一行。"""
    return not filename or filename.startswith("<")


def _failed_at(error: BaseException, entry: str, package: str | None = None) -> str | None:
    """节点失败时出错的位置：节点代码里的那一行，写成「模块.函数 第 N 行」（和被终止时同一种写法）。

    取异常经过的栈里最里面的一帧节点自己的代码（见 `_is_node_code`）。异常从 SDK、标准库里抛出时，
    报的是调用它的那一行节点代码；**从第三方库里抛出时也是**：失败时人要改的是自己的代码，库里的位置
    改不了，也不是要找的地方。这一点和被终止时（`_terminated_at`）不同：终止时停在哪就是哪，
    停在第三方库里就报库里的位置。

    有真实文件的帧优先：`exec` 出来的函数、dataclass 生成的方法这类没有文件的帧（`<string>`），
    文件里没有它们的那一行，先找有文件的节点代码帧（调用它们的那一行）；整条栈都没有文件时才用它们。

    异常组（`asyncio.TaskGroup` 里的子任务抛出的）自己的栈停在 `async with` 那一行，取第一个子异常
    （嵌套的一直往下）里出错的那一行。

    导入节点模块时语法错误：栈里没有出错的那个文件（编译在导入机制里失败），位置取异常自己带的文件和行，
    文件写成模块名（`mypkg.nodes 第 2 行`；包的 `__init__.py` 是包名）。
    栈里没有节点代码、异常也没有位置时（执行器自己出的错）是 None。
    """
    import builtins
    import traceback

    dirs = _runtime_dirs()
    own = _node_packages(entry, package)
    group = getattr(builtins, "BaseExceptionGroup", ())
    while isinstance(error, group) and error.exceptions:
        error = error.exceptions[0]
    if isinstance(error, SyntaxError) and error.filename and error.lineno:
        module = _module_of(error.filename, dirs)
        if _is_node_code(error.filename, module, own, dirs):
            return _place(module, "<module>", error.lineno)
    found = fallback = None
    for frame, lineno in traceback.walk_tb(error.__traceback__):
        code = frame.f_code
        module = str(frame.f_globals.get("__name__") or "")
        if _is_node_code(code.co_filename, module, own, dirs):
            at = (module or os.path.basename(code.co_filename), code, lineno)
            if _is_unreal_file(code.co_filename):
                fallback = at
            else:
                found = at
    found = found or fallback
    if found is None:
        return None
    module, code, lineno = found
    return _place(module, getattr(code, "co_qualname", code.co_name), lineno)


def _strip_leading_runtime_frames(
    exc: Any, dirs: tuple[list[str], list[str], list[str]], *, importing: bool
) -> None:
    """去掉这一段异常的堆栈里开头连续的执行器帧（SDK、标准库）：堆栈从节点代码那一帧开始。

    只去开头的：异常是在 SDK 里抛出的（`ctx.agent(...).files.download` 失败）时，节点代码之后的
    SDK 帧保留，它们说明是哪一次调用失败。整段栈都是执行器的帧时不动（执行器自己出的错，
    要看它在哪出的）；
    只有导入节点模块时（`importing`）失败的例外：入口模块找不到、有语法错误时栈里全是导入机制的帧，
    都去掉，异常信息本身（语法错误带着出错的文件和行）已经说明了原因。异常链（`raise ... from ...`、
    处理异常时又抛出的）和异常组里的每一段各自处理。
    """
    seen: set[int] = set()
    pending = [exc]
    while pending:
        part = pending.pop()
        if part is None or id(part) in seen:
            continue
        seen.add(id(part))
        stack = part.stack
        leading = next(
            (i for i, f in enumerate(stack) if not _is_runtime_frame(f.filename, dirs)),
            len(stack) if importing else 0,
        )
        del stack[:leading]
        pending.extend(
            [part.__cause__, part.__context__, *(getattr(part, "exceptions", None) or [])]
        )


def _format_failure(error: BaseException, *, importing: bool = False) -> str:
    """节点失败的堆栈：和 `traceback.format_exc()` 一样，只是开头连续的执行器帧去掉了。"""
    import traceback

    exc = traceback.TracebackException.from_exception(error)
    _strip_leading_runtime_frames(exc, _runtime_dirs(), importing=importing)
    return "".join(exc.format())


def _encoded_if_over(text: str, limit: int) -> bytes | None:
    """`text` 的 UTF-8 编码超过 `limit` 字节时返回编码，没超过返回 None（每个字符最多 4 个字节：
    字符数乘 4 不超过上限的不用编码就知道没超过）。"""
    if len(text) * 4 <= limit:
        return None
    raw = text.encode("utf-8", "surrogatepass")
    return raw if len(raw) > limit else None


def _bound_text(text: str, limit: int, what: str) -> str:
    """`text` 的 UTF-8 字节数超过 `limit` 时把中间省掉：开头和末尾各留一半（落在字符边界上），
    写明原来多少字节、
    省掉了多少。没超过的原样返回。"""
    raw = _encoded_if_over(text, limit)
    if raw is None:
        return text
    keep = limit // 2
    head = raw[:keep].decode("utf-8", "ignore")
    tail = raw[len(raw) - keep :].decode("utf-8", "ignore")
    left_out = len(raw) - len(head.encode("utf-8")) - len(tail.encode("utf-8"))
    return (
        f"{head}\n\n…（{what}有 {len(raw)} 字节，超过 {limit} 字节：中间 {left_out} 字节没有保留；"
        f"完整的在任务日志的标准错误里）…\n\n{tail}"
    )


def _bound_traceback(tb: str, limit: int) -> str:
    """堆栈的 UTF-8 字节数超过 `limit` 时只留最后的几帧（从一帧的开头起），
    写明前面省掉了多少字节。"""
    raw = _encoded_if_over(tb, limit)
    if raw is None:
        return tb
    cut = len(raw) - limit
    start = raw.find(b"\n  File ", cut)  # 下一帧的开头
    if start != -1:
        start += 1
    else:  # 没有帧的开头可以对齐：对齐到一行的开头
        line = raw.find(b"\n", cut)
        start = line + 1 if 0 <= line < len(raw) - 1 else cut
    kept = raw[start:].decode("utf-8", "ignore")
    return (
        f"…（堆栈有 {len(raw)} 字节，超过 {limit} 字节：前面的 {start} 字节没有保留，"
        "只留最后的几帧；"
        f"完整的在任务日志的标准错误里）…\n{kept}"
    )


def _bound_failure(message: str, tb: str, own: str) -> tuple[str, str]:
    """失败结果里的说明和堆栈各自限长（[`MAX_FAILURE_MESSAGE_BYTES`]、[`MAX_FAILURE_TRACEBACK_BYTES`]）。

    `own` 是异常自己的文字（`format_exception_only`），说明是它去掉首尾空白，
    堆栈的末尾通常也是它。堆栈超过上限、
    必须省掉一些的时候，末尾这一份不留：同样的文字不存两份（留着的话，异常的文字很长时堆栈的尾部全是这段文字，
    看不到帧）。堆栈没超过上限时一个字不变，说明也是。
    """
    bounded = _bound_text(message, MAX_FAILURE_MESSAGE_BYTES, "异常的文字")
    if own and tb.endswith(own) and _encoded_if_over(tb, MAX_FAILURE_TRACEBACK_BYTES) is not None:
        tb = f"{tb[: len(tb) - len(own)]}（这条异常的文字就是上面的说明，这里不重复。）\n"
    return bounded, _bound_traceback(tb, MAX_FAILURE_TRACEBACK_BYTES)


def _termination_message(error: BaseException, entry: str = "", package: str | None = None) -> str:
    """被终止时写进日志的那一行。找不到执行到哪时只写原因：这条路径在信号处理之后，不能再抛异常。"""
    text = str(error) or "任务被终止"
    try:
        place = _terminated_at(error, entry, package)
    except Exception:  # 位置只是附带的信息，取不到不能影响结果
        place = None
    return f"{text}，执行到 {place}" if place else text


def _log(level: str, message: str) -> None:
    """往事件管道写一行日志（和节点里的 `ctx.log` 一样，来源是 sdk）；没有事件管道、
    写不进去时丢弃：写日志失败不能让任务丢掉 output.json。"""
    try:
        Context().log(message, level=level)
    except Exception:  # 同上
        pass


def _info(message: str) -> None:
    _log("info", message)


def _is_artifact_limit(error: BaseException) -> bool:
    """失败是不是只因为产物超限：就是 `ArtifactLimitExceeded`，或者异常组（`asyncio.TaskGroup`
    里几个任务都没接住）里每一个叶子都是它；混着别的异常的组不算（有别的原因，照常按节点出错重试）。"""
    import builtins

    group = getattr(builtins, "BaseExceptionGroup", ())
    if isinstance(error, group):
        return bool(error.exceptions) and all(_is_artifact_limit(e) for e in error.exceptions)
    return isinstance(error, ArtifactLimitExceeded)


def run(task: Mapping[str, Any]) -> tuple[int, str]:
    """执行任务，返回 (退出码, output.json 内容)。"""
    importing = True  # 还在导入节点模块：失败的堆栈里全是导入机制的帧时一并去掉
    try:
        fn = load_entry(str(task["entry"]))
        importing = False
        _install_thread_hook(str(task.get("entry") or ""), task.get("package"))
        return 0, _encode(invoke(fn, task.get("inputs") or {}))
    except InputError as error:
        # 配置错误：不是节点出错，没有堆栈可看，错误信息就是原因，不往标准错误写（ERROR 级的日志）。
        # `kind` 让读取端记成 config_error（不重试）；没有这个键的失败是 node_error。
        message = _bound_text(str(error), MAX_FAILURE_MESSAGE_BYTES, "说明")
        failure = {"status": "failed", "error": {"kind": "config_error", "message": message}}
        return 1, json.dumps(failure, ensure_ascii=False)
    except BaseException as error:  # 节点代码的任何异常（包括 SystemExit）都是失败
        if isinstance(error, KeyboardInterrupt):
            raise
        import traceback

        place = None
        if isinstance(error, Cancelled):
            # 取消、超时、被停止子流程节点停止：正常终止，不是节点出错。标准错误来源的日志是
            # ERROR 级，不往那里写堆栈；只在事件管道里留一行 INFO，写明停在哪。被终止已经由任务状态
            # （已停止、已取消、超时）表达，这一行只是记录，不是需要处理的问题，所以不用 WARN。
            tb = traceback.format_exc()
            _info(_termination_message(error, str(task.get("entry") or ""), task.get("package")))
        else:
            # 堆栈从节点代码那一帧开始。出错的位置先于堆栈写进日志（一行 ERROR）：
            # `sfly run logs --failed` 只看日志也看得到，不用翻堆栈。整理堆栈、取位置都不能让失败
            # 丢掉原因：出了错就用完整的堆栈、不写位置。
            # 两件事各自兜底：整理不了堆栈就用节点的异常完整的堆栈，取不到位置就不写位置。
            # 兜底时不能用 `format_exc()`：在这个 `except` 里它格式化的是刚接住的内部错误。
            try:
                tb = _format_failure(error, importing=importing)
            except Exception:  # 整理堆栈只是为了好读
                tb = "".join(traceback.format_exception(error))
            try:
                place = _failed_at(error, str(task.get("entry") or ""), task.get("package"))
            except Exception:  # 位置只是附带的信息
                place = None
            if place:
                _log("error", f"出错位置：{place}")
            sys.stderr.write(tb)
        own = "".join(traceback.format_exception_only(type(error), error))
        message, tb = _bound_failure(own.strip(), tb, own)
        failure_error = {
            "type": type(error).__name__[:MAX_FAILURE_TYPE_CHARS],
            "message": message,
            "traceback": tb,
        }
        if place:
            failure_error["location"] = place[:MAX_FAILURE_LOCATION_CHARS]
        if _is_artifact_limit(error):
            # 没接住 `ctx.artifacts.save` 抛出的超限：和 Agent 上传前发现产物超限同一个类型
            # env_error，不按 retries 重试（重跑一遍产物还是这么大，#477）。
            failure_error["kind"] = "env_error"
        failure = {"status": "failed", "error": failure_error}
        return 1, json.dumps(failure, ensure_ascii=False)


def _install_thread_hook(entry: str, package: str | None) -> None:
    """后台线程里没接住的 `Cancelled` 和主线程一样是正常终止（见 `run`）：只在事件管道里留一行
    INFO，不让线程的默认处理往标准错误写 ERROR 级的堆栈（约 20 行）。别的异常照旧。

    只在节点已经导入了 `threading` 时装（节点要开线程，就一定导入了它）：启动路径上不为这个
    多导入一个模块（#76，`test_startup_path_does_not_import_deferred_modules`）。节点在运行中
    才第一次导入 `threading` 的话没有这一行，线程里没接住的 `Cancelled` 照旧写堆栈。"""
    threading: Any = sys.modules.get("threading")
    if threading is None:
        return
    default = threading.excepthook

    def hook(args: Any) -> None:
        error = args.exc_value
        if isinstance(error, Cancelled):
            name = args.thread.name if args.thread is not None else "?"
            _info(f"后台线程 {name}：{_termination_message(error, entry, package)}")
            return
        default(args)

    threading.excepthook = hook


def main() -> int:
    signal.signal(signal.SIGTERM, on_sigterm)
    with open(os.environ["SFLY_TASK"], encoding="utf-8") as f:
        task = json.loads(f.read())
    code, text = run(task)
    output = os.environ["SFLY_OUTPUT"]
    tmp = output + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, output)
    return code


if __name__ == "__main__":
    sys.exit(main())
