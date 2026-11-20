"""失败分类：只看会话记录（pi 的事件流、会话驱动的退出原因、控制面上的运行），不看助手自己怎么说。

**作废**：只有会话**因为**模型端点的故障没能做完才作废，不计入结果、要重跑——pi 的自动重试用尽了
（`auto_retry_end` 的 `success` 是 false），或者最后一条助手消息以端点错误结束。中途出过端点错误、
重试成功的会话照常算，记下重试了几次。端点错误指：连不上、连接中途断开、请求超时、转发口或上游
返回 401、402、403（鉴权、额度）、408、429（限流）和 5xx。

一次没通过、也没作废的会话归到一个主类（按下面的顺序取第一个命中的），另外把各类信号的次数都记下来：

| 类 | 怎么认 |
|---|---|
| 超时 | 会话驱动因轮数或时间上限结束 |
| 上下文耗尽 | 出现压缩事件，或模型报上下文超长 |
| 工具调用格式错 | 工具调用参数校验失败、调用了不存在的工具 |
| 编辑替换失败 | `edit` 工具报错（找不到要替换的原文、匹配到多处） |
| 等待时重复触发运行 | 助手触发了一次运行，上一次它触发的同一场景的运行还没结束 |
| 读不懂错误 | 同一条失败的命令原样重跑三次以上，或连续三次运行以同一个错误失败 |
| 认不出的错误 | 模型调用以别的错误结束（例如 400）：不记到模型头上，要人看 |
| 其他 | 以上都没有：多半是做完了但结果不对，或提前停下来了 |
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

INFRA = "环境故障"

UNKNOWN = "认不出的错误"

CATEGORIES = [
    INFRA,
    "超时",
    "上下文耗尽",
    "工具调用格式错",
    "编辑替换失败",
    "等待时重复触发运行",
    "读不懂错误",
    UNKNOWN,
    "其他",
]

_FORMAT_ERROR = re.compile(
    r"validation failed|invalid (tool )?arguments|tool .* not found|unknown tool|"
    r"must have required property|expected .* received",
    re.IGNORECASE,
)
# 模型端点的问题：连不上、连接中途断开、请求超时，转发口或上游返回鉴权、额度、限流、5xx
# （都是端点和账户的事，不是模型能力的事）。pi 把 HTTP 错误写成「… API error (状态码): 响应体」，
# 转发口自己的错误写「转发到 … 失败」。
_INFRA = re.compile(
    r"ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|Connection error|socket hang up|"
    r"fetch failed|does not match the HTTP/1.1 protocol|other side closed|^terminated|"
    r"Request timed out|timed out|\b(40[1238]|429|5\d\d)\b|overloaded|rate limit|"
    r"insufficient|quota|unauthori[sz]ed|forbidden|转发到 .* 失败|没有配置提供方",
    re.IGNORECASE,
)
_CONTEXT = re.compile(
    r"context (length|window)|too many tokens|maximum context|prompt is too long", re.I
)


def is_endpoint_error(message: str) -> bool:
    return bool(_INFRA.search(message)) and not _CONTEXT.search(message)


def tool_result_text(result: Any) -> str:
    """工具结果里的文字部分（pi 的工具结果是 `{"content": [{"type": "text", ...}]}`）。"""
    if not isinstance(result, dict):
        return str(result or "")
    parts = []
    for block in result.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text", "")))
    return "\n".join(parts)


def read_events(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    if not path.exists():
        return events
    for raw in path.read_bytes().split(b"\n"):
        if not raw.strip():
            continue
        try:
            event = json.loads(raw)
        except ValueError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def signals(
    events: list[dict[str, Any]], driver: dict[str, Any], runs: list[dict[str, Any]]
) -> Counter[str]:
    found: Counter[str] = Counter()
    if driver.get("exit_reason") in {"turn_limit", "time_limit"}:
        found["超时"] += 1
    failed_commands: Counter[str] = Counter()
    for event in events:
        kind = event.get("type")
        if kind in {"compaction_start", "compaction_end"}:
            found["上下文耗尽"] += 1
        elif kind == "message_end":
            message = event.get("message") or {}
            if message.get("role") == "assistant" and message.get("stopReason") == "error":
                error = str(message.get("errorMessage") or "")
                if _CONTEXT.search(error):
                    found["上下文耗尽"] += 1
                elif is_endpoint_error(error):
                    found["端点错误"] += 1
                else:
                    found[UNKNOWN] += 1
        elif kind == "auto_retry_start":
            found["端点重试"] += 1
        elif kind == "tool_execution_end" and event.get("isError"):
            name = event.get("toolName")
            text = tool_result_text(event.get("result"))
            if _FORMAT_ERROR.search(text):
                found["工具调用格式错"] += 1
            elif name == "edit":
                found["编辑替换失败"] += 1
            elif name == "bash":
                command = str((event.get("args") or {}).get("command", ""))
                failed_commands[command] += 1
    if any(n >= 3 for n in failed_commands.values()):
        found["读不懂错误"] += 1
    found.update(_run_signals(runs))
    return found


def is_assistant_run(run: dict[str, Any]) -> bool:
    """会话里的 pi 触发的运行（命令行带着 AI_AGENT=pi，控制面记成「经 pi」）。"""
    return run.get("triggered_via") == "pi"


def _run_signals(runs: list[dict[str, Any]]) -> Counter[str]:
    found: Counter[str] = Counter()
    mine = sorted(
        (r for r in runs if is_assistant_run(r) and r.get("started_at")),
        key=lambda r: str(r["started_at"]),
    )
    by_scenario: dict[str, list[dict[str, Any]]] = {}
    for run in mine:
        by_scenario.setdefault(str(run.get("scenario")), []).append(run)
    for scenario_runs in by_scenario.values():
        for previous, current in zip(scenario_runs, scenario_runs[1:], strict=False):
            ended = previous.get("ended_at")
            if ended is None or str(ended) > str(current["started_at"]):
                found["等待时重复触发运行"] += 1
        statuses = [r.get("status") for r in scenario_runs]
        if len(statuses) >= 3 and all(s == "failed" for s in statuses[-3:]):
            found["读不懂错误"] += 1
    return found


def endpoint_failure(events: list[dict[str, Any]]) -> str | None:
    """会话是不是因为端点故障没能做完：自动重试用尽，或者最后一条助手消息以端点错误结束。
    是的话返回那个错误，否则 None。中途出错、重试成功的不算。"""
    for event in events:
        if event.get("type") == "auto_retry_end" and not event.get("success"):
            error = str(event.get("finalError") or "")
            if is_endpoint_error(error):
                return error
    last: dict[str, Any] | None = None
    for event in events:
        message = event.get("message") or {}
        if event.get("type") == "message_end" and message.get("role") == "assistant":
            last = message
    if last is not None and last.get("stopReason") == "error":
        error = str(last.get("errorMessage") or "")
        if is_endpoint_error(error):
            return error
    return None


def classify(
    events_path: Path, driver: dict[str, Any], runs: list[dict[str, Any]]
) -> dict[str, Any]:
    events = read_events(events_path)
    found = signals(events, driver, runs)
    fatal = endpoint_failure(events)
    if fatal:
        found[INFRA] += 1
    primary = next((c for c in CATEGORIES if found.get(c)), "其他")
    return {
        "primary": primary,
        "signals": dict(found),
        "invalid": fatal is not None,
        "endpoint_error": fatal[:300] if fatal else None,
        "endpoint_retries": found.get("端点重试", 0),
    }
