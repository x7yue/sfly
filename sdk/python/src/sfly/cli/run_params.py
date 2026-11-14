"""`sfly run start` 的入口参数：把 `--param 名=值`、`--params JSON` 按入口节点声明的类型
转成触发请求里的 params。

声明来自场景预检接口的 `params`（名称、类型、说明、是否必填、默认值、是否 secret）。转换规则：
string 原样保留；number 按 JSON 数字解析；boolean 接受 true / false；json 按 JSON 解析。
参数名没有声明、值转换失败时报错并列出声明的参数；secret 参数的值不出现在任何错误里。
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable, Sequence
from typing import Any

from sfly.cli.errors import CliError
from sfly.cli.output import dump_json, format_table

Declaration = dict[str, Any]


def build_params(
    declared: Sequence[Declaration],
    pairs: Sequence[str],
    params_json: str | None,
    *,
    next_command: str,
) -> dict[str, Any]:
    """触发请求里的 `params`。`pairs` 是各个 `--param` 的原文（`名=值`），
    `params_json` 是 `--params` 的原文；两者同时给出时 `--param` 覆盖 `--params` 里的同名项。
    `next_command` 是出错时提示用来查看声明的命令。"""
    by_name = {d["name"]: d for d in declared}

    def invalid(message: str) -> CliError:
        return CliError(
            "invalid_params", f"{message}\n{describe_declared(declared)}", next=next_command
        )

    params: dict[str, Any] = {}
    if params_json is not None:
        given = _parse_object(params_json, invalid)
        for name in given:
            if name not in by_name:
                raise invalid(f"参数 {name} 没有声明")
        params.update(given)

    for pair in pairs:
        name, sep, text = pair.partition("=")
        if not sep or not name:
            raise invalid("--param 的格式是 名=值（名称不能为空，也不能漏掉 =）")
        decl = by_name.get(name)
        if decl is None:
            raise invalid(f"参数 {name} 没有声明")
        try:
            params[name] = convert(decl, text)
        except ValueError as error:
            raise invalid(f"参数 {name} 的值{error}") from None
    return params


def convert(decl: Declaration, text: str) -> Any:
    """按声明的类型转换命令行上的文本；失败时抛 `ValueError`，消息接在「参数 x 的值」后面
    （secret 参数的消息里没有值）。"""
    shown = "" if decl.get("secret") else f" {text!r} "
    kind = decl["type"]
    if kind == "string":
        return text
    if kind == "boolean":
        lowered = text.strip().lower()
        if lowered in ("true", "false"):
            return lowered == "true"
        raise ValueError(f"{shown}不是 boolean（写 true 或 false）")
    try:
        value = json.loads(text, parse_constant=_reject_constant)
    except ValueError:
        raise ValueError(f"{shown}不是合法的 {_expected(kind)}") from None
    if kind == "number" and (isinstance(value, bool) or not isinstance(value, int | float)):
        raise ValueError(f"{shown}不是合法的 {_expected(kind)}")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"{shown}不是合法的 {_expected(kind)}")
    return value


def _expected(kind: str) -> str:
    return "number（JSON 数字）" if kind == "number" else "json（JSON 值）"


def _reject_constant(name: str) -> Any:
    raise ValueError(name)


def _parse_object(text: str, invalid: Callable[[str], CliError]) -> dict[str, Any]:
    try:
        value = json.loads(text, parse_constant=_reject_constant)
    except ValueError as error:
        raise invalid(f"--params 不是合法的 JSON：{error}") from None
    if not isinstance(value, dict):
        raise invalid("--params 需要一个 JSON 对象，例如 '{\"名称\": 值}'")
    return value


def describe_declared(declared: Sequence[Declaration]) -> str:
    """声明的参数；「说明」列依次是参数说明、必填、默认值、secret，secret 参数的默认值不输出。"""
    if not declared:
        return "场景的入口节点没有声明参数"

    def notes(decl: Declaration) -> str:
        found = [decl["description"]] if decl.get("description") else []
        if decl.get("required"):
            found.append("必填")
        if "default" in decl and decl["default"] is not None and not decl.get("secret"):
            found.append(f"默认 {dump_json(decl['default'])}")
        if decl.get("secret"):
            found.append("secret")
        return "，".join(found)

    table = format_table(
        ["参数", "类型", "说明"], [[d["name"], d["type"], notes(d)] for d in declared]
    )
    return "声明的参数：\n" + "\n".join(f"  {line}" for line in table.splitlines())
