"""执行器：在任务子进程中加载并调用节点函数（`python -m sfly.runner`）。只用标准库（ADR 0002）。

本地协议（docs/ARCHITECTURE.md §5.4），全部通过环境变量传入路径：

- `SFLY_TASK`：task.json，至少包含 `entry`（`模块:函数`）和 `inputs`（已解析的输入，JSON 对象）。
- `SFLY_OUTPUT`：执行器写入结果的 output.json：
  - 成功：`{"status": "success", "outputs": {...}}`，退出码 0；
  - 失败：`{"status": "failed", "error": {"type", "message", "traceback"}}`，退出码 1；
    输入有节点没有声明的名字时，在调用节点之前就失败：
    `{"status": "failed", "error": {"kind": "config_error", "message"}}`（没有 `type` 和
    `traceback`）。`kind` 是读取端记的错误类型，没有这个键的失败是 `node_error`。
- `SFLY_ARTIFACTS`、`SFLY_ARTIFACTS_URL`、`SFLY_EVENTS`、`SFLY_CANCEL`：产物目录、产物下载地址前缀、
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
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from sfly.context import Cancelled, Context, on_sigterm
from sfly.nodes import NODE_ATTR, Metric, NodeDeclaration, is_context_param

# 执行器每个任务启动一个进程（#76）：从解释器启动到开始导入节点模块的路径上只导入必需的模块，
# 只在节点失败时才用到的 traceback 推迟到用到时再导入，读写 task.json、output.json 不用 pathlib。
# 测试见 tests/test_runner.py 的 test_startup_path_does_not_import_deferred_modules。

#: 节点返回值序列化后的大小上限（docs/ARCHITECTURE.md §4.1）。
MAX_OUTPUT_BYTES = 1024 * 1024


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


def _encode(outputs: dict[str, Any]) -> str:
    try:
        text = json.dumps({"status": "success", "outputs": outputs}, ensure_ascii=False)
    except (TypeError, ValueError) as error:
        raise NodeOutputError(f"节点返回值不能序列化为 JSON：{error}") from error
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


def _terminated_at(error: BaseException) -> str | None:
    """任务被终止时执行到哪：节点代码里被打断的那一行，写成「模块.函数 第 N 行」。

    取异常经过的栈里最里面、不是 SDK 也不是 Python 标准库的一帧：停在 SDK 里（等待 Agent、下载产物）
    或标准库里（`Event.wait`、`subprocess.run`、`Thread.join`、`asyncio.run`）时报调用它的节点代码，
    停在第三方库里时报库里的位置。整条栈都在 SDK 和标准库里时报最里面一帧；没有栈信息时是 None。
    """
    import traceback

    frames = list(traceback.walk_tb(error.__traceback__))
    if not frames:
        return None
    dirs = _runtime_dirs()
    frame, lineno = next(
        ((f, n) for f, n in reversed(frames) if not _is_runtime_frame(f.f_code.co_filename, dirs)),
        frames[-1],
    )
    code = frame.f_code
    module = frame.f_globals.get("__name__") or os.path.basename(code.co_filename)
    function = getattr(code, "co_qualname", code.co_name)
    place = module if function == "<module>" else f"{module}.{function}"
    return f"{place} 第 {lineno} 行"


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
        except Exception:  # noqa: BLE001 - 取不到发行版信息时只认入口模块的顶层名
            pass
    return names


def _is_node_code(
    filename: str,
    module: str,
    own: set[str],
    dirs: tuple[list[str], list[str], list[str]],
) -> bool:
    """这一帧是节点项目自己的代码：不是 SDK 或标准库，也不是第三方库。

    没有文件的帧（`<string>`）看不出来历，按节点代码算。装在 site-packages 里的帧，只有顶层模块是
    节点包自己的才算（节点包装在 Agent 的共享 venv 里，和第三方库在同一个目录）；不在 site-packages
    里的（本地调试从源码目录运行、`sfly dev` 的可编辑安装）都是节点自己的。
    """
    if _is_runtime_frame(filename, dirs):
        return False
    if not filename or filename.startswith("<") or not _in_site_packages(filename, dirs):
        return True
    return module.partition(".")[0] in own


def _place(module: str, function: str, lineno: int | None) -> str:
    place = module if function == "<module>" else f"{module}.{function}"
    return f"{place} 第 {lineno} 行"


def _failed_at(error: BaseException, entry: str, package: str | None = None) -> str | None:
    """节点失败时出错的位置：节点代码里的那一行，写成「模块.函数 第 N 行」（和被终止时同一种写法）。

    取异常经过的栈里最里面的一帧节点自己的代码（见 `_is_node_code`）。异常从 SDK、标准库里抛出时，
    报的是调用它的那一行节点代码；**从第三方库里抛出时也是**：失败时人要改的是自己的代码，库里的位置
    改不了，也不是要找的地方。这一点和被终止时（`_terminated_at`）不同：终止时停在哪就是哪，
    停在第三方库里就报库里的位置。

    导入节点模块时语法错误：栈里没有出错的那个文件（编译在导入机制里失败），位置取异常自己带的文件和行。
    栈里没有节点代码、异常也没有位置时（执行器自己出的错）是 None。
    """
    import traceback

    dirs = _runtime_dirs()
    own = _node_packages(entry, package)
    if isinstance(error, SyntaxError) and error.filename and error.lineno:
        stem = os.path.basename(error.filename).partition(".")[0]
        if _is_node_code(error.filename, stem, own, dirs):
            return f"{os.path.basename(error.filename)} 第 {error.lineno} 行"
    found = None
    for frame, lineno in traceback.walk_tb(error.__traceback__):
        code = frame.f_code
        module = str(frame.f_globals.get("__name__") or "")
        if _is_node_code(code.co_filename, module, own, dirs):
            found = (module or os.path.basename(code.co_filename), code, lineno)
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


def _termination_message(error: BaseException) -> str:
    """被终止时写进日志的那一行。找不到执行到哪时只写原因：这条路径在信号处理之后，不能再抛异常。"""
    text = str(error) or "任务被终止"
    try:
        place = _terminated_at(error)
    except Exception:  # noqa: BLE001 - 位置只是附带的信息，取不到不能影响结果
        place = None
    return f"{text}，执行到 {place}" if place else text


def _log(level: str, message: str) -> None:
    """往事件管道写一行日志（和节点里的 `ctx.log` 一样，来源是 sdk）；没有事件管道、
    写不进去时丢弃：写日志失败不能让任务丢掉 output.json。"""
    try:
        Context().log(message, level=level)
    except Exception:  # noqa: BLE001 - 同上
        pass


def _info(message: str) -> None:
    _log("info", message)


def run(task: Mapping[str, Any]) -> tuple[int, str]:
    """执行任务，返回 (退出码, output.json 内容)。"""
    importing = True  # 还在导入节点模块：失败的堆栈里全是导入机制的帧时一并去掉
    try:
        fn = load_entry(str(task["entry"]))
        importing = False
        return 0, _encode(invoke(fn, task.get("inputs") or {}))
    except InputError as error:
        # 配置错误：不是节点出错，没有堆栈可看，错误信息就是原因，不往标准错误写（ERROR 级的日志）。
        # `kind` 让读取端记成 config_error（不重试）；没有这个键的失败是 node_error。
        failure = {"status": "failed", "error": {"kind": "config_error", "message": str(error)}}
        return 1, json.dumps(failure, ensure_ascii=False)
    except BaseException as error:  # noqa: BLE001 - 节点代码的任何异常（包括 SystemExit）都是失败
        if isinstance(error, KeyboardInterrupt):
            raise
        import traceback

        place = None
        if isinstance(error, Cancelled):
            # 取消、超时、被停止子流程节点停止：正常终止，不是节点出错。标准错误来源的日志是
            # ERROR 级，不往那里写堆栈；只在事件管道里留一行 INFO，写明停在哪。被终止已经由任务状态
            # （已停止、已取消、超时）表达，这一行只是记录，不是需要处理的问题，所以不用 WARN。
            tb = traceback.format_exc()
            _info(_termination_message(error))
        else:
            # 堆栈从节点代码那一帧开始。出错的位置先于堆栈写进日志（一行 ERROR）：
            # `sfly run logs --failed` 只看日志也看得到，不用翻堆栈。整理堆栈、取位置都不能让失败
            # 丢掉原因：出了错就用完整的堆栈、不写位置。
            try:
                tb = _format_failure(error, importing=importing)
                place = _failed_at(error, str(task.get("entry") or ""), task.get("package"))
            except Exception:  # noqa: BLE001 - 位置只是附带的信息
                tb, place = traceback.format_exc(), None
            if place:
                _log("error", f"出错位置：{place}")
            sys.stderr.write(tb)
        failure_error = {
            "type": type(error).__name__,
            "message": "".join(traceback.format_exception_only(type(error), error)).strip(),
            "traceback": tb,
        }
        if place:
            failure_error["location"] = place
        failure = {"status": "failed", "error": failure_error}
        return 1, json.dumps(failure, ensure_ascii=False)


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
