"""运行预设（GLOSSARY「运行预设」，ADR 0023）在命令行里的取用和显示。

- `sfly run start --preset 名称`：在场景预检返回的预设里按准确名称找，找不到、已失效时报错，不触发。

预设是不是失效、为什么失效都是控制面算好的（`status`、`problems`），命令行只转述，不重新判断。
secret 预设参数的值由控制面打码（`******`），命令行原样显示，读不到原值。
创建、修改、删除预设没有专门的命令，用 `sfly api`（`sfly api --list presets` 列出接口）。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sfly.cli.client import ApiError
from sfly.cli.errors import CliError
from sfly.cli.output import candidate_list

Preset = dict[str, Any]
Declaration = dict[str, Any]

_LOCKED_HINT = (
    "去掉 --param 或 --params 里的这个参数，预设会填上它保存的值；要用别的值就不要加 --preset。"
)


def problems_text(problems: Sequence[dict[str, str]], declared: Sequence[Declaration]) -> str:
    """失效的原因写成一句话：哪个参数、什么问题；类型不对时写明它现在的类型。
    与控制面 `preset_invalid` 的消息、控制台里的写法一致。"""
    types = {d["name"]: d["type"] for d in declared}
    found = []
    for problem in problems:
        name = problem["param"]
        if problem["reason"] == "missing":
            found.append(f"参数 {name} 已不存在")
        else:
            current = f"（{types[name]}）" if name in types else ""
            found.append(f"参数 {name} 保存的值不符合现在的类型{current}")
    return "；".join(found)


def find_preset(
    scenario: dict[str, Any],
    presets: Sequence[Preset],
    declared: Sequence[Declaration],
    name: str,
) -> Preset:
    """`--preset` 指定的运行预设：在场景的运行预设（预检的 `presets`）里按准确名称找，区分大小写。
    找不到时抛 `preset_not_found`，列出这个场景的全部预设；已失效时抛 `preset_invalid`，
    写明原因。"""
    scenario_id = scenario["id"]
    show = f"sfly scenario show {scenario_id}"
    found = next((p for p in presets if p["name"] == name), None)
    if found is None:
        if not presets:
            raise CliError(
                "preset_not_found",
                f"场景「{scenario['name']}」没有名称是「{name}」的运行预设，"
                "这个场景还没有任何运行预设。\n"
                f"新建运行预设：在控制台场景列表的「运行预设…」里，"
                f"或者 sfly api POST /orchestrations/{scenario_id}/presets",
                next="sfly api --list presets",
            )
        listed = candidate_list([_listed(p, declared) for p in presets])
        raise CliError(
            "preset_not_found",
            f"场景「{scenario['name']}」没有名称是「{name}」的运行预设。"
            f"这个场景的运行预设（名称要完全一致）：\n{listed}",
            next=show,
        )
    if found["status"] == "invalid":
        reasons = problems_text(found["problems"], declared)
        raise CliError(
            "preset_invalid",
            f"运行预设「{name}」已失效，不能用来触发：{reasons}\n"
            "在控制台场景列表的「运行预设…」里修好它，"
            f"或者用 sfly api PATCH /orchestrations/{scenario_id}/presets/{found['id']} 修改。",
            next=show,
        )
    return found


def _listed(preset: Preset, declared: Sequence[Declaration]) -> str:
    if preset["status"] == "ok":
        return str(preset["name"])
    return f"{preset['name']}（已失效：{problems_text(preset['problems'], declared)}）"


def with_next_step(error: ApiError, scenario_id: str) -> ApiError:
    """触发时控制面因为运行预设拒绝（预设参数传了别的值，或预检之后预设被删除、改成失效）：
    说明沿用控制面的（写明参数名和预设名），补上怎么办和下一步。其他错误原样返回。"""
    show = f"sfly scenario show {scenario_id}"
    if error.code == "preset_param_locked":
        return error.replace(message=f"{error.message}\n{_LOCKED_HINT}", next=show)
    if error.code in ("preset_not_found", "preset_invalid"):
        return error.replace(next=show)
    return error
