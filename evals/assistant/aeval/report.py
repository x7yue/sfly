"""把一个结果目录里的会话记录汇总成 Markdown 表格（贴进 issue 用）。

每个模型、每道题一行：通过次数、轮数和用时的中位数、token 的中位数、pi 内存峰值的最大值、
没通过的会话按失败分类计数。另起一张表列出模型的档次、上下文窗口、是否支持工具调用。
"""

from __future__ import annotations

import json
import statistics
from collections import Counter
from pathlib import Path
from typing import Any

from aeval.decide import ARM_NAMES as DECIDE_ARM_NAMES
from aeval.decide import decide, render_decision
from aeval.models import load_models


def load_records(results: Path) -> list[dict[str, Any]]:
    records = []
    for path in sorted(results.glob("*/session.json")):
        records.append(json.loads(path.read_text()))
    return records


ARM_NAMES = {"a": "A 本地", "b": "B 远程", "p": "平台"}
REMOTE_ARMS = [arm for arm in DECIDE_ARM_NAMES if arm != "a"]


def arm_of(record: dict[str, Any]) -> str:
    """第一轮的记录没有 arm 字段：那时只有臂 A。"""
    return str(record.get("arm", "a"))


def valid(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """计入结果的会话：去掉作废的，也去掉工具自检（它只验证流程，不是题目）。"""
    return [r for r in records if not r.get("invalid") and r.get("task") != "toolcheck"]


def _median(values: list[float]) -> str:
    if not values:
        return "-"
    value = statistics.median(values)
    return f"{value:,.0f}" if value >= 1000 else f"{value:g}"


def table(records: list[dict[str, Any]]) -> str:
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for record in valid(records):
        groups.setdefault((record["model"], record["task"], arm_of(record)), []).append(record)
    rows = [
        "| 模型 | 题目 | 臂 | 通过 | 轮数中位数 | 用时中位数（秒） "
        "| 输入 token 中位数（含缓存的读和写） | 输出 token 中位数 "
        "| pi 内存峰值（MiB） | 失败分类 |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for (model, task, arm), group in sorted(groups.items()):
        drivers = [r.get("driver") or {} for r in group]
        passed = sum(1 for r in group if r["grade"]["passed"])
        turns = [float(d["turns"]) for d in drivers if "turns" in d]
        seconds = [float(d["wall_seconds"]) for d in drivers if "wall_seconds" in d]
        tokens_in = [
            float(d["tokens"]["input"] + d["tokens"]["cache_read"] + d["tokens"]["cache_write"])
            for d in drivers
            if "tokens" in d
        ]
        tokens_out = [float(d["tokens"]["output"]) for d in drivers if "tokens" in d]
        memory = [float(d["pi_peak_rss_mib"]) for d in drivers if "pi_peak_rss_mib" in d]
        failures = Counter(
            (r.get("failure") or {}).get("primary", "其他")
            for r in group
            if not r["grade"]["passed"]
        )
        failure_text = "、".join(f"{k} {v}" for k, v in failures.most_common()) or "-"
        category = group[0].get("category", "")
        rows.append(
            f"| {model} | {category}（{task}） | {ARM_NAMES[arm]} | {passed}/{len(group)} "
            f"| {_median(turns)} "
            f"| {_median(seconds)} | {_median(tokens_in)} | {_median(tokens_out)} "
            f"| {max(memory) if memory else '-'} | {failure_text} |"
        )
    return "\n".join(rows)


def models_table(records: list[dict[str, Any]], models_path: Path | None = None) -> str:
    models = load_models(models_path)
    used = sorted({r["model"] for r in records})
    rows = ["| 模型 | 档次 | 上下文窗口 | 工具调用 | 思考强度 |", "|---|---|---|---|---|"]
    for name in used:
        model = models.get(name)
        spec = model.spec if model else {}
        rows.append(
            f"| {name} | {spec.get('tier', '?')} | {spec.get('contextWindow', '?')} "
            f"| {'支持' if spec.get('toolCalls') else '?'} | {spec.get('thinking') or '默认'} |"
        )
    return "\n".join(rows)


def render(results: Path) -> str:
    records = load_records(results)
    counted = valid(records)
    invalid = [r for r in records if r.get("invalid")]
    info_path = results / "run-info.json"
    info = json.loads(info_path.read_text()) if info_path.exists() else {}
    head = [
        f"- sfly：{info.get('sfly', '?')}（控制面镜像 {info.get('server_image', '?')}）",
        f"- pi：{info.get('pi', '?')}",
        f"- 有效会话数：{len(counted)}；每次会话上限 {info.get('max_turns', '?')} 轮、"
        f"{info.get('max_seconds', '?')} 秒",
    ]
    if invalid:
        head.append(f"- 作废（模型端点故障，不计入）：{len(invalid)} 次")
    body = "\n".join(head) + "\n\n" + models_table(counted) + "\n\n" + table(records) + "\n"
    body += "\n" + endpoint_table(records) + "\n"
    for model in sorted({r["model"] for r in counted if arm_of(r) == "a"}):
        body += "\n" + render_gate(counted, model) + "\n"
    all_for_decision = [r for r in records if r.get("task") != "toolcheck"]
    for remote in REMOTE_ARMS:
        for model in sorted({r["model"] for r in counted if arm_of(r) == remote}):
            body += "\n" + render_decision(decide(all_for_decision, model, remote)) + "\n"
            body += "".join(f"- {note}\n" for note in comparison_notes(counted, model, remote))
    return body


def comparison_notes(records: list[dict[str, Any]], model: str, remote: str) -> list[str]:
    """臂 A 和远程那一臂比时要说明的：两臂的上限不一样（判定照算，但轮数、超时不可比）；
    平台臂的内存峰值和臂 A 的量法。"""
    notes = []
    limits: dict[str, set[str]] = {}
    for record in records:
        if record["model"] == model and arm_of(record) in ("a", remote):
            given = (record.get("driver") or {}).get("limits") or {}
            text = f"{given.get('max_turns', '?')} 轮、{given.get('max_seconds', '?')} 秒"
            limits.setdefault(arm_of(record), set()).add(text)
    if len(limits) == 2 and limits["a"] != limits[remote]:
        notes.append(
            f"注意：两臂的上限不一样（臂 A：{'、'.join(sorted(limits['a']))}；"
            f"{ARM_NAMES[remote]}：{'、'.join(sorted(limits[remote]))}），轮数和超时不可比，"
            "上面的判定只作参考"
        )
    if remote == "p":
        notes.append(
            "内存峰值：两臂都是 pi 进程的 VmHWM、每秒取一次；臂 A 是开发环境里的 JSON 模式、"
            "本地工具，平台臂是助手容器里的 RPC 模式、加载远程工具扩展，进程按会话常驻，"
            "量的是同一种东西，但不是同一个配置下的 pi"
        )
    return notes


def endpoint_table(records: list[dict[str, Any]]) -> str:
    """按（模型、题目、臂）列出作废的次数和原因，以及有效会话里端点出错、pi 重试成功的次数。"""
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for record in records:
        if record.get("task") == "toolcheck":
            continue
        groups.setdefault((record["model"], record["task"], arm_of(record)), []).append(record)
    rows = [
        "| 模型 | 题目 | 臂 | 作废 | 作废的原因 | 有效会话里的端点重试 |",
        "|---|---|---|---|---|---|",
    ]
    for (model, task, arm), group in sorted(groups.items()):
        voided = [r for r in group if r.get("invalid")]
        reasons = Counter(_reason(r) for r in voided)
        retries = sum(int(r.get("endpoint_retries") or 0) for r in group if not r.get("invalid"))
        if not voided and not retries:
            continue
        text = "；".join(f"{k}（{v} 次）" for k, v in reasons.most_common()) or "-"
        rows.append(f"| {model} | {task} | {ARM_NAMES[arm]} | {len(voided)} | {text} | {retries} |")
    if len(rows) == 2:
        return "没有作废的会话，有效会话里也没有端点重试。"
    return "端点故障：\n\n" + "\n".join(rows)


def _reason(record: dict[str, Any]) -> str:
    error = str(
        record.get("platform_error")
        or record.get("endpoint_error")
        or (record.get("failure") or {}).get("endpoint_error")
        or ""
    )
    return error[:60].replace("|", "\\|") or "未记录"


# 过线的标准（#443）：至少一个内网档模型，「写」「修」各不低于 3 次里过 2 次；
# 过线后补到 5 次，各不低于 4 次。
GATE_TASKS = ("write", "fix")


def render_gate(records: list[dict[str, Any]], model: str) -> str:
    """过线检查：按臂 A 的有效会话，前 3 次看 2/3，到 5 次时看 4/5。"""
    parts = []
    for task in GATE_TASKS:
        runs = sorted(
            (r for r in records if r["model"] == model and arm_of(r) == "a" and r["task"] == task),
            key=lambda r: str(r.get("seeded_at", "")),
        )
        first = sum(r["grade"]["passed"] for r in runs[:3])
        text = f"{task} 前 3 次过 {first} 次" if len(runs) >= 3 else f"{task} 只有 {len(runs)} 次"
        if len(runs) >= 5:
            text += f"、5 次过 {sum(r['grade']['passed'] for r in runs[:5])} 次"
        parts.append(text)
    return f"过线检查（{model}，「写」「修」各 ≥2/3，补到 5 次后各 ≥4/5）：" + "；".join(parts)
