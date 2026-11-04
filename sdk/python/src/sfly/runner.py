"""执行器：在任务子进程中加载并调用节点函数（`python -m sfly.runner`）。只用标准库（ADR 0002）。

本地协议（docs/ARCHITECTURE.md §5.4），全部通过环境变量传入路径：

- `SFLY_TASK`：task.json，至少包含 `entry`（`模块:函数`）和 `inputs`（已解析的输入，JSON 对象）。
- `SFLY_OUTPUT`：执行器写入结果的 output.json：
  - 成功：`{"status": "success", "outputs": {...}}`，退出码 0；
  - 失败：`{"status": "failed", "error": {"type", "message", "traceback"}}`，退出码 1。
- `SFLY_ARTIFACTS`、`SFLY_EVENTS`、`SFLY_CANCEL`：产物目录、事件文件、取消标记（由 Context 使用）。

节点按关键字参数接收输入；首个参数是任务上下文时传入 `Context`。
返回值必须是 JSON 对象（返回 None 视为空对象），序列化后不超过 1 MB。
"""

from __future__ import annotations

import importlib
import inspect
import json
import os
import sys
import traceback
import typing
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from sfly.context import Context
from sfly.nodes import is_context_param

#: 节点返回值序列化后的大小上限（docs/ARCHITECTURE.md §4.1）。
MAX_OUTPUT_BYTES = 1024 * 1024


class NodeOutputError(Exception):
    """节点返回值不符合要求。"""


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


def invoke(fn: Callable[..., Any], inputs: Mapping[str, Any]) -> dict[str, Any]:
    result = fn(Context(), **inputs) if _takes_context(fn) else fn(**inputs)
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


def run(task: Mapping[str, Any]) -> tuple[int, str]:
    """执行任务，返回 (退出码, output.json 内容)。"""
    try:
        fn = load_entry(str(task["entry"]))
        return 0, _encode(invoke(fn, task.get("inputs") or {}))
    except BaseException as error:  # noqa: BLE001 - 节点代码的任何异常（包括 SystemExit）都是失败
        if isinstance(error, KeyboardInterrupt):
            raise
        tb = traceback.format_exc()
        sys.stderr.write(tb)
        failure = {
            "status": "failed",
            "error": {
                "type": type(error).__name__,
                "message": "".join(traceback.format_exception_only(type(error), error)).strip(),
                "traceback": tb,
            },
        }
        return 1, json.dumps(failure, ensure_ascii=False)


def main() -> int:
    task = json.loads(Path(os.environ["SFLY_TASK"]).read_text(encoding="utf-8"))
    code, text = run(task)
    output = Path(os.environ["SFLY_OUTPUT"])
    tmp = output.with_name(output.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, output)
    return code


if __name__ == "__main__":
    sys.exit(main())
